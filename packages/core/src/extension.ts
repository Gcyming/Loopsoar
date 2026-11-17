/**
 * 扩展（Extension）模型 —— 「万物皆插件」的本地安装单元。
 * 纯逻辑：不碰 fs / electron；安装目录扫描在壳层完成，这里只做清单校验与注册表。
 *
 * 清单文件：<extension-id>/loopsoar.extension.json
 * {
 *   "id": "my-tool", "name": "我的工具", "version": "0.1.0",
 *   "description": "...", "author": "...", "main": "index.mjs",
 *   "permissions": ["read", "network"],
 *   "keywords": ["fetch"]
 * }
 */
import { z } from "zod";
import type { ToolPermissions } from "./tools/registry.js";

export const EXTENSION_MANIFEST_FILE = "loopsoar.extension.json";

export const EXTENSION_PERMISSION_KEYS = ["read", "write", "terminal", "network"] as const;
export type ExtensionPermission = (typeof EXTENSION_PERMISSION_KEYS)[number];

export const ExtensionManifestSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9._-]*$/i, "id 仅允许字母数字 . _ -"),
  name: z.string().min(1).max(200),
  version: z.string().min(1).max(40),
  description: z.string().max(4000).optional(),
  author: z.string().max(200).optional(),
  /** 入口文件（相对扩展目录）；当前版本必须提供——纯声明式扩展（仅提示词/规则）尚未实现。 */
  main: z.string().max(300).optional(),
  /**
   * 扩展工具可用的权限上限。未声明 = 扩展工具全部拒绝（fail-closed）。
   * 注意：它只约束桥接进 ToolRegistry 的工具；默认情况下 worker 进程仍是完整 Node 权限，
   * 安装第三方扩展等同于信任其代码。设 `isolation: "node"` 可启用 Node permission model
   * 的第一层 OS 隔离（只读扩展目录/worker 目录，写仅限扩展目录）；强隔离仍未做。
   */
  permissions: z.array(z.enum(EXTENSION_PERMISSION_KEYS)).max(4).optional(),
  /**
   * OS 级隔离（P1-8 第一步）：设为 "node" 时，worker 用 Node permission model 启动，
   * 只读扩展目录与 worker 目录，写权限仅限扩展目录，子进程按 terminal 授权。
   * 默认 "none" 保持旧扩展兼容；真正的强隔离/容器化仍未做。
   */
  isolation: z.enum(["none", "node"]).optional(),
  keywords: z.array(z.string().max(80)).max(50).optional(),
});

export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;

/**
 * 计算某个扩展工具的实际权限：manifest 授权 ∩ 工具声明，fail-closed。
 *
 * 规则：
 *   · manifest 未声明权限 → 拒绝（不能靠“工具自己说自己只读”放行）；
 *   · 工具未声明任何权限 → 拒绝（空权限在 kindOfTool 里会被误判成 read）；
 *   · 工具声明了 manifest 未授予的权限 → 拒绝整个工具（不做静默降级）；
 *   · 全部通过 → 返回交集，供 ToolRegistry/沙箱按类别判定。
 */
export function resolveExtensionToolPermissions(
  manifestPermissions: readonly string[] | undefined,
  declared: Record<string, unknown> | undefined,
): { permissions: ToolPermissions; errors: string[] } {
  const granted = new Set<string>(manifestPermissions ?? []);
  const errors: string[] = [];
  if (granted.size === 0) {
    errors.push("manifest 未声明 permissions，扩展工具一律拒绝");
  }

  const declaredTrue = Object.entries(declared ?? {}).filter(([, value]) => value === true);
  if (declaredTrue.length === 0) {
    errors.push("工具未声明任何 permissions");
  }

  const permissions: ToolPermissions = {};
  for (const [key] of declaredTrue) {
    if (!(EXTENSION_PERMISSION_KEYS as readonly string[]).includes(key)) {
      errors.push(`工具声明了未知权限：${key}`);
      continue;
    }
    if (!granted.has(key)) {
      errors.push(`工具声明了 manifest 未授权的权限：${key}`);
      continue;
    }
    permissions[key as ExtensionPermission] = true;
  }

  return errors.length > 0 ? { permissions: {}, errors } : { permissions, errors };
}

export interface InstalledExtension {
  manifest: ExtensionManifest;
  /** 安装目录绝对路径（壳层注入）。 */
  dir: string;
  enabled: boolean;
  installedAt: number;
}

export class ExtensionRegistry {
  private items = new Map<string, InstalledExtension>();

  /** 解析并校验清单；失败抛错（调用方决定是否忽略坏扩展）。 */
  static parseManifest(raw: unknown): ExtensionManifest {
    return ExtensionManifestSchema.parse(raw);
  }

  install(manifest: ExtensionManifest, dir: string, enabled = true, installedAt = Date.now()): InstalledExtension {
    const existing = this.items.get(manifest.id);
    const item: InstalledExtension = {
      manifest,
      dir,
      enabled,
      installedAt: existing?.installedAt ?? installedAt,
    };
    this.items.set(manifest.id, item);
    return item;
  }

  get(id: string): InstalledExtension | undefined {
    return this.items.get(id);
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  list(): InstalledExtension[] {
    return [...this.items.values()].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  }

  setEnabled(id: string, enabled: boolean): InstalledExtension | undefined {
    const item = this.items.get(id);
    if (!item) return undefined;
    item.enabled = enabled;
    return item;
  }

  remove(id: string): InstalledExtension | undefined {
    const item = this.items.get(id);
    if (!item) return undefined;
    this.items.delete(id);
    return item;
  }

  /** 已启用扩展（供注入 Agent 的扩展清单/提示词）。 */
  enabled(): InstalledExtension[] {
    return this.list().filter((e) => e.enabled);
  }

  /** 已启用扩展的一句话摘要（注入 volatile 段，token 友好）。 */
  promptSummary(): string {
    const items = this.enabled();
    if (items.length === 0) return "";
    const lines = items.map((e) => `- ${e.manifest.name} (${e.manifest.id}@${e.manifest.version})${e.manifest.description ? `：${e.manifest.description}` : ""}`);
    return ["## 可用扩展", ...lines].join("\n");
  }

  clear(): void {
    this.items.clear();
  }
}
