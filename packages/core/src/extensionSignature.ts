/**
 * 扩展签名 / 包完整性（纯逻辑，Node crypto）。
 *
 * 信任模型：
 *   · 签名对象 = 去掉 signature 字段后的规范化 manifest；integrity 字段也在签名内，
 *     因此「改清单」或「换包内容」都会让签名/摘要失效；
 *   · integrity = 除 manifest 外全部文件的树摘要（路径 + 长度 + 内容 SHA-256）；
 *   · 公钥信任是显式动作：首次看到某公钥只标记 untrusted，用户点「信任发布者」后
 *     指纹进入 trust store；签名有效但公钥未信任 ≠ 可信。
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import type { ExtensionManifest, ExtensionSignature } from "loopsoar-contracts/extension";
import type { ExtensionCompatibility } from "./extensionCompat.js";

export type ExtensionTrustStatus = "trusted" | "unsigned" | "untrusted" | "invalid";

export interface ExtensionTrustState {
  status: ExtensionTrustStatus;
  /** 公钥指纹：`sha256:<hex>`（信任库键）。 */
  fingerprint?: string;
  publisher?: string;
  signedAt?: number;
  message?: string;
}

export type ExtensionCertification = "certified" | "compatible" | "unverified" | "blocked";

export interface TreeFile {
  /** 相对扩展根目录的 POSIX 路径。 */
  path: string;
  data: Uint8Array;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : sortValue(item)));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) continue;
      out[key] = sortValue(item);
    }
    return out;
  }
  return value;
}

/** 稳定 JSON：对象键排序、undefined 省略（数组内按 JSON 语义变 null）。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

/** 签名载荷：manifest 去掉 signature 后的规范化 JSON。 */
export function manifestSigningPayload(manifest: ExtensionManifest): string {
  const { signature: _signature, ...rest } = manifest as ExtensionManifest & { signature?: ExtensionSignature };
  return canonicalJson(rest);
}

/**
 * 包内容树摘要。调用方必须排除 manifest 自身（否则 integrity 写进 manifest 会自指）。
 * 路径重复直接抛错（复制/打包阶段的 bug 不能静默成一个包）。
 */
export function computeTreeDigest(files: readonly TreeFile[]): string {
  const normalized = [...files].map((file) => ({ ...file, path: file.path.replace(/\\/g, "/") }));
  normalized.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hash = createHash("sha256");
  let previous = "";
  for (const file of normalized) {
    if (file.path === previous) throw new Error(`包内路径重复：${file.path}`);
    previous = file.path;
    hash.update(file.path, "utf8");
    hash.update("\0");
    hash.update(String(file.data.byteLength), "utf8");
    hash.update("\0");
    hash.update(file.data);
    hash.update("\n");
  }
  return `sha256-${hash.digest("base64")}`;
}

export function inspectIntegrity(files: readonly TreeFile[], expected: string | undefined): { ok: boolean; actual: string; message?: string } {
  const actual = computeTreeDigest(files);
  if (!expected) return { ok: true, actual };
  return {
    ok: actual === expected,
    actual,
    ...(actual === expected ? {} : { message: `包内容摘要不匹配（清单 ${expected}，实际 ${actual}）` }),
  };
}

/** 公钥指纹（DER SPKI 的 SHA-256）。 */
export function fingerprintPublicKey(publicKeyBase64: string): string {
  const der = Buffer.from(publicKeyBase64, "base64");
  return `sha256:${createHash("sha256").update(der).digest("hex")}`;
}

function publicKeyFromBase64(publicKeyBase64: string): ReturnType<typeof createPublicKey> {
  return createPublicKey({ key: Buffer.from(publicKeyBase64, "base64"), format: "der", type: "spki" });
}

/** 校验 manifest 签名；不检查 integrity（由 inspectIntegrity 单独做）。 */
export function verifyManifestSignature(
  manifest: ExtensionManifest,
  trustedFingerprints: ReadonlySet<string>,
  revokedFingerprints: ReadonlySet<string> = new Set(),
): ExtensionTrustState {
  const signature = manifest.signature;
  if (!signature) return { status: "unsigned", ...(manifest.publisher ? { publisher: manifest.publisher } : {}) };
  try {
    const publicKey = publicKeyFromBase64(signature.publicKey);
    const ok = verify(null, Buffer.from(manifestSigningPayload(manifest), "utf8"), publicKey, Buffer.from(signature.value, "base64"));
    if (!ok) return { status: "invalid", message: "签名校验失败（清单在签名后被修改）" };
    const fingerprint = fingerprintPublicKey(signature.publicKey);
    if (revokedFingerprints.has(fingerprint)) {
      return { status: "invalid", fingerprint, message: "签名公钥已被撤销（密钥轮换/泄露止损）" };
    }
    const trusted = trustedFingerprints.has(fingerprint);
    return {
      status: trusted ? "trusted" : "untrusted",
      fingerprint,
      ...(signature.signedAt !== undefined ? { signedAt: signature.signedAt } : {}),
      ...(manifest.publisher ? { publisher: manifest.publisher } : {}),
      ...(trusted ? {} : { message: "签名有效，但公钥尚未被信任" }),
    };
  } catch (err) {
    return {
      status: "invalid",
      message: `签名无法解析：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** 生成 Ed25519 密钥对（PEM 私钥 + base64 SPKI 公钥 + 指纹）。 */
export function generateSigningKeyPair(): { privateKeyPem: string; publicKey: string; fingerprint: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyBase64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  return { privateKeyPem, publicKey: publicKeyBase64, fingerprint: fingerprintPublicKey(publicKeyBase64) };
}

/** 用私钥签名 manifest，返回带 signature 的新对象（不修改入参）。 */
export function signExtensionManifest(manifest: ExtensionManifest, privateKeyPem: string, signedAt = Date.now()): ExtensionManifest {
  const key = createPrivateKey(privateKeyPem);
  const publicKeyBase64 = createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64");
  const value = sign(null, Buffer.from(manifestSigningPayload(manifest), "utf8"), key).toString("base64");
  return {
    ...manifest,
    signature: { algorithm: "ed25519", publicKey: publicKeyBase64, value, signedAt },
  };
}

/**
 * 认证级别：
 *   certified  = 签名公钥已信任 + 兼容性零警告 + 固定 engines + 依赖满足
 *   compatible = 可运行（可能有警告）
 *   unverified = 可运行但签名未信任/未签名（策略允许时）
 *   blocked    = 兼容性/依赖/签名完整性有一票否决
 */
export function certificationFor(
  compatibility: ExtensionCompatibility,
  trust: ExtensionTrustState,
  dependenciesOk: boolean,
): ExtensionCertification {
  if (compatibility.status === "blocked" || !dependenciesOk || trust.status === "invalid") return "blocked";
  if (trust.status === "trusted" && compatibility.status === "compatible" && compatibility.engineRange) return "certified";
  if (trust.status === "unsigned" || trust.status === "untrusted") return "unverified";
  return "compatible";
}
