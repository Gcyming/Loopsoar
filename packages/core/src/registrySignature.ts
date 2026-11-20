/**
 * 扩展市场目录签名（纯逻辑，Node crypto）。
 *
 * 目录签名解决的是「registry 本身被篡改」：攻击者若能改 index.json，就能把
 * 更新指向旧版/恶意包；包签名只能证明包未变，不能证明「市场让你装的就是这个包」。
 *
 * 签名对象 = 去掉 signature 后的规范化目录 JSON；因此任何 plugins/revocations/
 * expiresAt 的改动都会让签名失效。公钥信任由客户端配置（不是目录自报）。
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import type {
  ExtensionRegistryIndex,
  ExtensionRegistrySignatureStatus,
  ExtensionRevocation,
} from "loopsoar-contracts/extensionRegistry";
import { canonicalJson, fingerprintPublicKey } from "./extensionSignature.js";

export interface RegistrySignatureState {
  status: ExtensionRegistrySignatureStatus;
  fingerprint?: string;
  signedAt?: number;
  message?: string;
}

/** 签名载荷：目录去掉 signature 字段后的稳定 JSON。 */
export function registrySigningPayload(index: ExtensionRegistryIndex): string {
  const { signature: _signature, ...rest } = index;
  return canonicalJson(rest);
}

/** 用私钥签名目录，返回带 signature 的新对象（不修改入参）。 */
export function signRegistryIndex(
  index: ExtensionRegistryIndex,
  privateKeyPem: string,
  signedAt = Date.now(),
): ExtensionRegistryIndex {
  const key = createPrivateKey(privateKeyPem);
  const publicKey = createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64");
  const value = sign(null, Buffer.from(registrySigningPayload(index), "utf8"), key).toString("base64");
  return { ...index, signature: { algorithm: "ed25519", publicKey, value, signedAt } };
}

/**
 * 验证目录签名。`trustedFingerprints` 为空时：签名有效但标记 untrusted（不抛错），
 * 便于本地/开发目录；调用方决定是否强制。签名损坏永远是 invalid。
 */
export function verifyRegistrySignature(
  index: ExtensionRegistryIndex,
  trustedFingerprints: ReadonlySet<string>,
): RegistrySignatureState {
  const signature = index.signature;
  if (!signature) return { status: "unsigned" };
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(signature.publicKey, "base64"),
      format: "der",
      type: "spki",
    });
    const ok = verify(
      null,
      Buffer.from(registrySigningPayload(index), "utf8"),
      publicKey,
      Buffer.from(signature.value, "base64"),
    );
    if (!ok) return { status: "invalid", message: "目录签名校验失败（index.json 在签名后被修改）" };
    const fingerprint = fingerprintPublicKey(signature.publicKey);
    return {
      status: trustedFingerprints.has(fingerprint) ? "trusted" : "untrusted",
      fingerprint,
      ...(signature.signedAt !== undefined ? { signedAt: signature.signedAt } : {}),
      ...(trustedFingerprints.has(fingerprint) ? {} : { message: "目录签名有效，但公钥未配置为受信市场密钥" }),
    };
  } catch (err) {
    return {
      status: "invalid",
      message: `目录签名无法解析：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** 找出命中 id/version 的撤销记录；version 缺省匹配该扩展全部版本。 */
export function findRevocation(
  index: Pick<ExtensionRegistryIndex, "revocations">,
  id: string,
  version: string,
): ExtensionRevocation | undefined {
  return (index.revocations ?? []).find(
    (entry) => entry.id === id && (entry.version === undefined || entry.version === version),
  );
}

/** 目录公钥指纹（供 UI/设置展示；格式 sha256:<hex>）。 */
export function registryKeyFingerprint(publicKeyBase64: string): string {
  return fingerprintPublicKey(publicKeyBase64);
}

/** 生成目录版本摘要（用于日志/审计，不参与签名）。 */
export function registryDigest(index: ExtensionRegistryIndex): string {
  return createHash("sha256").update(registrySigningPayload(index), "utf8").digest("hex");
}
