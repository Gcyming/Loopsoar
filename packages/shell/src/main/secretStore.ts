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
    const item = this.read().items[providerId];
    return Boolean(item?.cipher);
  }

  hint(providerId: string): string | null {
    return this.read().items[providerId]?.hint ?? null;
  }

  /** 取明文密钥（仅 shell 内使用；未配置返回 null）。 */
  get(providerId: string): string | null {
    const cached = this.cache.get(providerId);
    if (cached) return cached;
    const item = this.read().items[providerId];
    if (!item?.cipher) return null;
    if (this.mode === "unavailable") return null;
    try {
      const plain = this.backend.decrypt(Buffer.from(item.cipher, "base64"));
      this.cache.set(providerId, plain);
      return plain;
    } catch {
      return null;
    }
  }

  set(providerId: string, apiKey: string): SecretRecord {
    if (this.mode === "unavailable") throw new Error("系统密钥库不可用，无法安全保存密钥（可改用环境变量）");
    const value = apiKey.trim();
    if (value.length < 8) throw new Error("密钥格式不合法（至少 8 位）");
    const cipher = this.backend.encrypt(value).toString("base64");
    const record: SecretRecord = { cipher, hint: maskSecret(value), updatedAt: Date.now() };
    const data = this.read();
    data.mode = this.mode === "os" ? "os" : "degraded";
    data.items[providerId] = record;
    this.write(data);
    this.cache.set(providerId, value);
    return record;
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
