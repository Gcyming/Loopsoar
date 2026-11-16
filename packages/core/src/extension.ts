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

export const EXTENSION_MANIFEST_FILE = "loopsoar.extension.json";

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
  /** 入口文件（相对扩展目录）；留空表示纯声明式扩展（仅给 Agent 提供提示词/规则）。 */
  main: z.string().max(300).optional(),
  /** 声明的权限类别，安装时展示；实际执行仍走沙箱与确认流程。 */
  permissions: z.array(z.enum(["read", "write", "terminal", "network"])).max(4).optional(),
  keywords: z.array(z.string().max(80)).max(50).optional(),
});

export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;

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
