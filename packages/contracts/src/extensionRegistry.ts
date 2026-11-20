/**
 * 扩展市场索引契约（静态 JSON / HTTP registry 通用）。
 *
 * 设计目标：registry 可以是任意静态托管（GitHub Pages / 对象存储 / 内网服务），
 * 客户端只依赖这一份 schema；下载包必须带 sha256，签名与否则由包内 manifest 决定。
 */
import { z } from "zod";
import { SemverStringSchema, VersionRangeSchema } from "./extension.js";

const ExtensionIdSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9._-]*$/i, "id 仅允许字母数字 . _ -");

export const ExtensionRegistryVersionSchema = z.object({
  version: SemverStringSchema,
  /** 缺失时以包内 manifest 为准；市场列表用于提前提示 API 兼容性。 */
  apiVersion: SemverStringSchema.optional(),
  engines: z.object({ loopsoar: VersionRangeSchema }).optional(),
  /** 绝对 URL 或相对 index.json 的路径。 */
  downloadUrl: z.string().min(1).max(2_000),
  /** 包文件（zip）的 SHA-256（hex）。必填：没有摘要的下载不允许安装。 */
  sha256: z.string().regex(/^[a-f0-9]{64}$/i, "sha256 必须是 64 位 hex"),
  size: z.number().int().positive().max(64 * 1024 * 1024).optional(),
  publishedAt: z.number().int().nonnegative().optional(),
  changelog: z.string().max(4_000).optional(),
  yanked: z.boolean().optional(),
});
export type ExtensionRegistryVersion = z.infer<typeof ExtensionRegistryVersionSchema>;

/** Ed25519 目录签名：publicKey 为 base64 SPKI DER，value 为 base64 签名。 */
export const ExtensionRegistrySignatureSchema = z.object({
  algorithm: z.literal("ed25519"),
  publicKey: z.string().min(40).max(2_000).regex(/^[A-Za-z0-9+/=]+$/, "publicKey 必须是 base64"),
  value: z.string().min(40).max(2_000).regex(/^[A-Za-z0-9+/=]+$/, "signature 必须是 base64"),
  signedAt: z.number().int().nonnegative().optional(),
});
export type ExtensionRegistrySignature = z.infer<typeof ExtensionRegistrySignatureSchema>;

/**
 * 撤销记录：定向封禁已发布的安装包。
 * version 缺省 = 该扩展全部版本（适用于发布者密钥泄露/恶意扩展整体下架）。
 * 客户端拉取 registry 后会持久化并在扫描时强制 blocked，无需等待用户手动卸载。
 */
export const ExtensionRevocationSchema = z.object({
  id: ExtensionIdSchema,
  version: SemverStringSchema.optional(),
  reason: z.string().min(1).max(1_000),
  revokedAt: z.number().int().nonnegative(),
  /** 预留：block=禁止安装/启用；warn=只提示（当前客户端一律按 block 处理）。 */
  severity: z.enum(["block", "warn"]).optional(),
});
export type ExtensionRevocation = z.infer<typeof ExtensionRevocationSchema>;


export const ExtensionRegistryEntrySchema = z.object({
  id: ExtensionIdSchema,
  name: z.string().min(1).max(200),
  description: z.string().max(2_000).optional(),
  publisher: z.string().max(120).optional(),
  homepage: z.string().max(500).optional(),
  keywords: z.array(z.string().max(80)).max(30).optional(),
  /** 可选：显式标记最新版；缺省取最高非 yanked 版本。 */
  latest: SemverStringSchema.optional(),
  versions: z.array(ExtensionRegistryVersionSchema).min(1).max(100),
});
export type ExtensionRegistryEntry = z.infer<typeof ExtensionRegistryEntrySchema>;

export const ExtensionRegistryIndexSchema = z.object({
  /** v1 兼容；新目录使用 v2（支持签名/撤销/过期）。 */
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  name: z.string().max(200).optional(),
  updatedAt: z.number().int().nonnegative().optional(),
  /** 发布通道（客户端当前只展示；多通道用不同 index URL 实现灰度）。 */
  channel: z.enum(["stable", "beta"]).optional(),
  /**
   * 目录过期时间（epoch ms）。客户端拒绝过期目录，避免长期缓存/回滚攻击；
   * 缺省不过期（兼容测试与内网 registry）。
   */
  expiresAt: z.number().int().nonnegative().optional(),
  /** 撤销列表：命中 id/version 的已安装扩展在下次扫描时强制 blocked。 */
  revocations: z.array(ExtensionRevocationSchema).max(5_000).optional(),
  plugins: z.array(ExtensionRegistryEntrySchema).max(2_000),
  /** v2 可选：配置市场公钥后客户端强制要求 trusted 签名。 */
  signature: ExtensionRegistrySignatureSchema.optional(),
});
export type ExtensionRegistryIndex = z.infer<typeof ExtensionRegistryIndexSchema>;

/** 目录签名状态（客户端验证结果，不来自服务端自报）。 */
export type ExtensionRegistrySignatureStatus = "trusted" | "untrusted" | "unsigned" | "invalid";


/** 目录响应（客户端附加：来源 URL、解析后的下载地址、已安装版本）。 */
export interface ExtensionCatalogView {
  registryUrl: string;
  name?: string;
  updatedAt?: number;
  channel?: "stable" | "beta";
  expiresAt?: number;
  fetchedAt: number;
  /** 目录签名验证状态；未配置市场公钥时签名只展示不强制。 */
  signature?: { status: ExtensionRegistrySignatureStatus; fingerprint?: string };
  /** 本目录携带的撤销记录数量（仅供 UI 展示；实际执行在 ExtensionHost）。 */
  revoked?: number;
  plugins: Array<
    ExtensionRegistryEntry & {
      /** 选中的最新版本（非 yanked 的最高版或 latest 指向）。 */
      latestVersion?: string;
      installedVersion?: string;
      updateAvailable?: boolean;
      /** 已安装但市场版本更低/相同，仅用于 UI 展示。 */
      compatible?: boolean;
    }
  >;
}
