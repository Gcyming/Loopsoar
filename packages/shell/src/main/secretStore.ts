/**
 * 密钥库（SecretStore）：API Key 加密落盘，**永不回传渲染层、永不写日志**。
 *
 * 存储：<configDir>/secrets.enc.json
 *   { version: 1, mode: "os" | "degraded", items: { [providerId]: { cipher, hint, updatedAt } } }
 *
 * 加密策略（借鉴 slime 的 `providers.enc.json` 只给 has_key/key_hint 的做法）：
 *   - 首选 Electron safeStorage（Windows DPAPI / macOS Keychain / Linux libsecret）——OS 级加密；
 *   - 不可用时降级为 AES-256-GCM，密钥文件 <configDir>/.secret.key（权限 0600），
 *     mode 标记为 degraded 并在设置页提示；
 *   - 两者都不允许时抛错，调用方回退环境变量。
 *
 * 安全纪律：日志/审计只出现通道与状态；错误文案不回显密钥；列表只给掩码 hint。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type SecretStorageMode = "os" | "degraded" | "unavailable";

export interface SecretCryptoBackend {
  available: boolean;
  encrypt(plain: string): Buffer;
  decrypt(cipher: Buffer): string;
}

export interface SecretRecord {
  /** base64 密文 */
  cipher: string;
  /** 掩码提示，形如 sk-…a1b2 */
  hint: string;
  updatedAt: number;
}

interface SecretsFile {
  version: 1;
  mode: Exclude<SecretStorageMode, "unavailable">;
  items: Record<string, SecretRecord>;
}

interface StoredSecret extends SecretRecord {
  /** 降级后端（AES + .secret.key）备份密文：OS 密钥库不可用/变化时兜底解密。 */
  cipherFallback?: string;
}

const KEY_LENGTH = 32;

/** 掩码：保留前 3 位与后 4 位；太短的密钥全掩码。 */
export function maskSecret(secret: string): string {
  const value = secret.trim();
  if (value.length <= 8) return "********";
  return `${value.slice(0, 3)}…${value.slice(-4)}`;
}

/** AES-256-GCM 降级后端（密钥文件 0600）。 */
function createDegradedBackend(keyFile: string): SecretCryptoBackend {
  const loadKey = (): Buffer => {
    try {
      if (fs.existsSync(keyFile)) {
        const buf = Buffer.from(fs.readFileSync(keyFile, "utf8").trim(), "base64");
        if (buf.length === KEY_LENGTH) return buf;
      }
    } catch {
      // 重建
    }
    const key = crypto.randomBytes(KEY_LENGTH);
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, key.toString("base64"), { encoding: "utf8", mode: 0o600 });
    return key;
  };
  return {
    available: true,
    encrypt(plain: string): Buffer {
      const key = loadKey();
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return Buffer.concat([Buffer.from("v1"), iv, tag, enc]);
    },
    decrypt(payload: Buffer): string {
      const key = loadKey();
      if (payload.subarray(0, 2).toString() !== "v1") throw new Error("密钥数据格式不受支持");
      const iv = payload.subarray(2, 14);
      const tag = payload.subarray(14, 30);
      const data = payload.subarray(30);
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    },
  };
}

export class SecretStore {
  private file: string;
  private backend: SecretCryptoBackend;
  private mode: SecretStorageMode;
  /** 进程内明文缓存：只在 shell 内使用，绝不跨 IPC。 */
  private cache = new Map<string, string>();
  /** 降级备用后端：始终双写，避免 OS 密钥库可用性变化导致旧密文读不出。 */
  private fallback: SecretCryptoBackend | null = null;

  constructor(configDir: string, backend: SecretCryptoBackend) {
    this.file = path.join(configDir, "secrets.enc.json");
    this.backend = backend;
    this.mode = backend.available ? "os" : "unavailable";
  }

  /** 显式启用降级加密：OS 密钥库不可用，或**已有文件是 degraded 模式**（必须沿用同一后端才能解密）。 */
  useDegradedBackend(keyFile: string): void {
    if (this.mode === "degraded") return;
    this.backend = createDegradedBackend(keyFile);
    this.mode = "degraded";
  }

  /**
   * 启用降级备用后端（双写；主后端不可解时回落）。
   * 注意：这是「OS 密钥库不可用/历史 degraded 文件」时的兼容路径；
   * OS 密钥库可用时装配层不会再调用它（见 purgeFallback）。
   */
  setFallbackBackend(keyFile: string): void {
    this.fallback = createDegradedBackend(keyFile);
  }

  /**
   * 清理历史版本写入的降级备份密文，并删除 AES 密钥文件。
   * 只在 OS 密钥库可用且当前文件是 os 模式时调用：满足「API Key 只存操作系统凭据存储」，
   * 同时避免留下一份可被同机读取的 AES 备份。返回清理条数。
   */
  purgeFallback(runtimeKeyFile: string): { purged: number } {
    if (this.mode !== "os") return { purged: 0 };
    const data = this.read();
    let purged = 0;
    for (const item of Object.values(data.items) as StoredSecret[]) {
      if (item.cipherFallback) {
        delete item.cipherFallback;
        purged += 1;
      }
    }
    if (purged > 0) this.write(data);
    try {
      fs.rmSync(runtimeKeyFile, { force: true });
    } catch {
      // 文件不存在/被占用：下次启动再试
    }
    this.fallback = null;
    return { purged };
  }

  /** 已落盘文件记录的加密模式（不存在/损坏返回 null）；装配层据此选择与历史数据兼容的后端。 */
  fileMode(): "os" | "degraded" | null {
    try {
      if (!fs.existsSync(this.file)) return null;
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as { mode?: unknown };
      return raw.mode === "os" || raw.mode === "degraded" ? raw.mode : null;
    } catch {
      return null;
    }
  }

  storageMode(): SecretStorageMode {
    return this.mode;
  }

  private read(): SecretsFile {
    try {
      if (!fs.existsSync(this.file)) return { version: 1, mode: this.mode === "os" ? "os" : "degraded", items: {} };
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as SecretsFile;
      if (!raw || typeof raw !== "object" || !raw.items) throw new Error("bad");
      return raw;
    } catch {
      // 文件损坏时视为空（保留原文件备份，便于排查）
      try {
        fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch {
        // 忽略
      }
      return { version: 1, mode: this.mode === "os" ? "os" : "degraded", items: {} };
    }
  }

  private write(data: SecretsFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2), "utf8");
  }

  has(providerId: string): boolean {
    const item = this.read().items[providerId] as StoredSecret | undefined;
    return Boolean(item?.cipher || item?.cipherFallback);
  }

  hint(providerId: string): string | null {
    return this.read().items[providerId]?.hint ?? null;
  }

  /** 已保存密钥的 providerId 清单（仅 id，不返回明文；迁移/诊断用）。 */
  ids(): string[] {
    return Object.keys(this.read().items);
  }

  /** 密钥记录元信息（updatedAt/hint，不含明文；供应商去重合并时比较新旧用）。 */
  meta(providerId: string): { updatedAt: number; hint: string } | null {
    const item = this.read().items[providerId];
    if (!item) return null;
    return { updatedAt: Number(item.updatedAt) || 0, hint: item.hint };
  }

  /** 取明文密钥（仅 shell 内使用；未配置返回 null）。主后端失败时自动尝试降级备份。 */
  get(providerId: string): string | null {
    const cached = this.cache.get(providerId);
    if (cached) return cached;
    const item = this.read().items[providerId] as StoredSecret | undefined;
    if (!item) return null;
    const debug = Boolean(process.env.LOOPSOAR_SECRET_DEBUG);
    const tryDecrypt = (cipher: string | undefined, backend: SecretCryptoBackend | null, tag: string): string | null => {
      if (!cipher || !backend) return null;
      try {
        return backend.decrypt(Buffer.from(cipher, "base64"));
      } catch (err) {
        if (debug) console.log(`[Loopsoar] secret decrypt failed (${tag}): ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    };
    // OS 主密文 → 降级备份密文；两边都失败才算"丢失"
    const plain =
      (this.mode !== "unavailable" ? tryDecrypt(item.cipher, this.backend, "primary") : null) ??
      tryDecrypt(item.cipherFallback, this.fallback, "fallback");
    if (plain === null) return null;
    this.cache.set(providerId, plain);
    return plain;
  }

  set(providerId: string, apiKey: string): SecretRecord {
    if (this.mode === "unavailable" && !this.fallback) {
      throw new Error("系统密钥库不可用，无法安全保存密钥（可改用环境变量）");
    }
    const value = apiKey.trim();
    if (value.length < 8) throw new Error("密钥格式不合法（至少 8 位）");
    const cipher = this.mode === "unavailable" ? "" : this.backend.encrypt(value).toString("base64");
    const cipherFallback = this.fallback ? this.fallback.encrypt(value).toString("base64") : undefined;
    const record: StoredSecret = { cipher, cipherFallback, hint: maskSecret(value), updatedAt: Date.now() };
    const data = this.read();
    data.mode = this.mode === "degraded" || this.mode === "unavailable" ? "degraded" : "os";
    data.items[providerId] = record;
    this.write(data);
    this.cache.set(providerId, value);
    return { cipher, hint: record.hint, updatedAt: record.updatedAt };
  }

  clear(providerId: string): boolean {
    const data = this.read();
    if (!data.items[providerId]) {
      this.cache.delete(providerId);
      return false;
    }
    delete data.items[providerId];
    this.write(data);
    this.cache.delete(providerId);
    return true;
  }
}
