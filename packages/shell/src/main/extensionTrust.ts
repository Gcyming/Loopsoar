/**
 * 扩展信任库 + 包完整性校验（壳层，IO 边界）。
 *
 * 两件事分开：
 *   · TrustStore：哪些签名公钥被用户显式信任（`<dataDir>/extensions-trust.json`）；
 *   · verifyExtensionPackage：重新计算包树摘要、校验签名，输出可展示的信任状态。
 *
 * 信任策略：
 *   warn   —— 未签名/未信任可运行，但标记 unverified（默认，兼容旧扩展）；
 *   strict —— 只有 trusted 签名可启用；invalid 永远 blocked。
 */
import fs from "node:fs";
import path from "node:path";
import type { ExtensionManifest } from "loopsoar-core/extension";
import {
  computeTreeDigest,
  fingerprintPublicKey,
  verifyManifestSignature,
  type ExtensionTrustState,
  type TreeFile,
} from "loopsoar-core/extensionSignature";

export type ExtensionTrustPolicy = "warn" | "strict";

export interface TrustedKeyRecord {
  fingerprint: string;
  publicKey: string;
  publisher?: string;
  trustedAt: number;
  /** 密钥生效/过期时间（epoch ms）；过期后不再参与 trusted 判定，但保留记录可审计。 */
  notBefore?: number;
  notAfter?: number;
  /** 撤销时间（epoch ms）：命中后签名直接 invalid，优先于 trusted。 */
  revokedAt?: number;
  revokeReason?: string;
}

interface TrustFile {
  version: 2;
  policy?: ExtensionTrustPolicy;
  keys?: TrustedKeyRecord[];
}

export class ExtensionTrustStore {
  private records = new Map<string, TrustedKeyRecord>();
  private policyValue: ExtensionTrustPolicy = "warn";
  /** 信任状态变更计数：宿主用它让签名校验缓存失效。 */
  revision = 0;

  constructor(private readonly filePath: string) {
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<TrustFile>;
      this.policyValue = raw.policy === "strict" ? "strict" : "warn";
      for (const record of raw.keys ?? []) {
        if (!record || typeof record.fingerprint !== "string" || typeof record.publicKey !== "string") continue;
        this.records.set(record.fingerprint, {
          fingerprint: record.fingerprint,
          publicKey: record.publicKey,
          ...(typeof record.publisher === "string" ? { publisher: record.publisher } : {}),
          trustedAt: typeof record.trustedAt === "number" ? record.trustedAt : Date.now(),
          ...(typeof record.notBefore === "number" ? { notBefore: record.notBefore } : {}),
          ...(typeof record.notAfter === "number" ? { notAfter: record.notAfter } : {}),
          ...(typeof record.revokedAt === "number" ? { revokedAt: record.revokedAt } : {}),
          ...(typeof record.revokeReason === "string" ? { revokeReason: record.revokeReason } : {}),
        });
      }
    } catch (err) {
      console.warn(`[Loopsoar] 扩展信任库读取失败（按默认 warn 启动）：${err instanceof Error ? err.message : String(err)}`);
      this.records.clear();
      this.policyValue = "warn";
    }
  }

  private write(): void {
    const data: TrustFile = {
      version: 2,
      policy: this.policyValue,
      keys: [...this.records.values()].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)),
    };
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
      fs.renameSync(tmp, this.filePath);
      this.revision += 1;
    } catch (err) {
      console.warn(`[Loopsoar] 扩展信任库写入失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  policy(): ExtensionTrustPolicy {
    return this.policyValue;
  }

  setPolicy(policy: ExtensionTrustPolicy): void {
    if (this.policyValue === policy) return;
    this.policyValue = policy;
    this.write();
  }

  list(): TrustedKeyRecord[] {
    return [...this.records.values()].sort((a, b) => b.trustedAt - a.trustedAt);
  }

  /** 当前有效（未撤销、在有效期内）的信任指纹；用于签名校验。 */
  fingerprints(now = Date.now()): Set<string> {
    const active = new Set<string>();
    for (const record of this.records.values()) {
      if (record.revokedAt !== undefined) continue;
      if (record.notBefore !== undefined && now < record.notBefore) continue;
      if (record.notAfter !== undefined && now > record.notAfter) continue;
      active.add(record.fingerprint);
    }
    return active;
  }

  /** 已撤销的指纹集合：签名校验用它把「撤销密钥」判为 invalid，而不是普通 untrusted。 */
  revokedFingerprints(): Set<string> {
    return new Set([...this.records.values()].filter((record) => record.revokedAt !== undefined).map((record) => record.fingerprint));
  }

  has(fingerprint: string): boolean {
    return this.records.has(fingerprint);
  }

  /** 信任公钥：指纹必须由公钥重新计算得出（不接受渲染层伪造的 fingerprint）。 */
  trust(input: {
    fingerprint: string;
    publicKey: string;
    publisher?: string;
    notBefore?: number;
    notAfter?: number;
  }): { ok: boolean; error?: string } {
    let actual: string;
    try {
      actual = fingerprintPublicKey(input.publicKey);
    } catch (err) {
      return { ok: false, error: `公钥无法解析：${err instanceof Error ? err.message : String(err)}` };
    }
    if (actual !== input.fingerprint) return { ok: false, error: "公钥指纹不匹配（拒绝信任）" };
    if (input.notBefore !== undefined && input.notAfter !== undefined && input.notAfter <= input.notBefore) {
      return { ok: false, error: "无效的密钥有效期（notAfter 必须晚于 notBefore）" };
    }
    this.records.set(actual, {
      fingerprint: actual,
      publicKey: input.publicKey,
      ...(input.publisher ? { publisher: input.publisher } : {}),
      trustedAt: Date.now(),
      ...(input.notBefore !== undefined ? { notBefore: input.notBefore } : {}),
      ...(input.notAfter !== undefined ? { notAfter: input.notAfter } : {}),
    });
    this.write();
    return { ok: true };
  }

  /** 撤销密钥：保留记录（可审计），但立即退出有效信任集；已签名的扩展下次扫描变 blocked。 */
  revoke(fingerprint: string, reason?: string): { ok: boolean; error?: string } {
    const record = this.records.get(fingerprint);
    if (!record) return { ok: false, error: "密钥不在信任库中" };
    this.records.set(fingerprint, {
      ...record,
      revokedAt: Date.now(),
      ...(reason ? { revokeReason: reason } : {}),
    });
    this.write();
    return { ok: true };
  }

  untrust(fingerprint: string): boolean {
    const removed = this.records.delete(fingerprint);
    if (removed) this.write();
    return removed;
  }
}

export interface PackageLimits {
  maxFiles: number;
  maxBytes: number;
  maxDepth: number;
}

export const DEFAULT_PACKAGE_LIMITS: PackageLimits = {
  maxFiles: 2_000,
  maxBytes: 64 * 1024 * 1024,
  maxDepth: 20,
};

const SKIP_NAMES = new Set([".git", "node_modules", ".DS_Store", "Thumbs.db"]);

/**
 * 读取包内全部文件（不含 manifest 自身）。symlink 一律拒绝：它能把任意系统文件
 * 带进摘要/安装目录，是典型的供应链绕过点。
 */
export function readPackageFiles(
  dir: string,
  limits: PackageLimits = DEFAULT_PACKAGE_LIMITS,
): { files: TreeFile[]; bytes: number } {
  const root = path.resolve(dir);
  const files: TreeFile[] = [];
  let bytes = 0;

  const walk = (current: string, relative: string, depth: number): void => {
    if (depth > limits.maxDepth) throw new Error(`包目录层级超过 ${limits.maxDepth} 层`);
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (SKIP_NAMES.has(entry.name)) continue;
      if (relative === "" && entry.name === "loopsoar.extension.json") continue;
      const full = path.join(current, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`包内不允许符号链接：${rel}`);
      if (stat.isDirectory()) {
        walk(full, rel, depth + 1);
        continue;
      }
      if (!stat.isFile()) throw new Error(`包内包含不支持的文件类型：${rel}`);
      if (files.length >= limits.maxFiles) throw new Error(`包内文件数超过 ${limits.maxFiles}`);
      bytes += stat.size;
      if (bytes > limits.maxBytes) throw new Error(`包体积超过 ${Math.round(limits.maxBytes / 1024 / 1024)}MB`);
      files.push({ path: rel, data: fs.readFileSync(full) });
    }
  };

  walk(root, "", 0);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, bytes };
}

export function computePackageIntegrity(dir: string, limits?: PackageLimits): string {
  return computeTreeDigest(readPackageFiles(dir, limits).files);
}

export interface PackageVerification {
  trust: ExtensionTrustState;
  integrity: { ok: boolean; actual: string; expected?: string; message?: string };
  files: number;
  bytes: number;
}

/**
 * 校验目录包：摘要 + 签名。注意签名包必须带 integrity；无 integrity 的签名只覆盖
 * 清单（不能证明包内容未被替换），按无效处理。
 */
export function verifyExtensionPackage(
  dir: string,
  manifest: ExtensionManifest,
  trustStore: ExtensionTrustStore,
  limits?: PackageLimits,
): PackageVerification {
  const { files, bytes } = readPackageFiles(dir, limits);
  const actual = computeTreeDigest(files);
  const integrityOk = !manifest.integrity || manifest.integrity === actual;
  const integrity = {
    ok: integrityOk,
    actual,
    ...(manifest.integrity ? { expected: manifest.integrity } : {}),
    ...(integrityOk ? {} : { message: `包内容摘要不匹配（清单 ${manifest.integrity}，实际 ${actual}）` }),
  };

  let trust = verifyManifestSignature(manifest, trustStore.fingerprints(), trustStore.revokedFingerprints());
  if (manifest.signature && !manifest.integrity) {
    trust = { status: "invalid", message: "签名包缺少 integrity：无法证明包内容未被替换" };
  } else if (!integrityOk) {
    trust = { status: "invalid", message: integrity.message ?? "包内容摘要不匹配" };
  }
  return { trust, integrity, files: files.length, bytes };
}
