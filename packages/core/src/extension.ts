/**
 * 扩展（Extension）模型 —— 「万物皆插件」的本地安装单元。
 * 纯逻辑：不碰 fs / electron；安装目录扫描在壳层完成，这里只做清单校验与注册表。
 *
 * 清单文件：<extension-id>/loopsoar.extension.json
 * {
 *   "id": "my-tool", "name": "我的工具", "version": "0.1.0",
 *   "description": "...", "author": "...", "main": "index.mjs",
 *   "permissions": ["read", "network"],
 *   "contributes": { "commands": [{ "id": "fetch", "title": "抓取", "prompt": "抓取 {{url}} 的正文" }] },
 *   "keywords": ["fetch"]
 * }
 */
import type { ToolPermissions } from "./tools/registry.js";
import {
  EXTENSION_PERMISSION_KEYS,
  EXTENSION_TOOL_PERMISSION_KEYS,
  ExtensionManifestSchema,
  type ExtensionManifest,
  type ExtensionPermission,
  type ExtensionToolPermission,
} from "loopsoar-contracts/extension";
import type { ExtensionCompatibility } from "./extensionCompat.js";
import type { ExtensionTrustState, ExtensionCertification } from "./extensionSignature.js";

export const EXTENSION_MANIFEST_FILE = "loopsoar.extension.json";

export {
  EXTENSION_EVENT_NAMES,
  EXTENSION_HOST_API_VERSION,
  EXTENSION_LEGACY_API_VERSION,
  EXTENSION_PERMISSION_KEYS,
  EXTENSION_THEME_TOKENS,
  EXTENSION_TOOL_PERMISSION_KEYS,
  ExtensionCommandSchema,
  ExtensionContributionsSchema,
  ExtensionHookSchema,
  ExtensionLoopSchema,
  ExtensionManifestSchema,
  ExtensionPanelSchema,
  ExtensionSignatureSchema,
  ExtensionThemeSchema,
  ExtensionViewSchema,
  SemverStringSchema,
  VersionRangeSchema,
} from "loopsoar-contracts/extension";
export type {
  ExtensionCommand,
  ExtensionContributions,
  ExtensionEventName,
  ExtensionHook,
  ExtensionLoopContribution,
  ExtensionManifest,
  ExtensionPanel,
  ExtensionPermission,
  ExtensionSignature,
  ExtensionThemeContribution,
  ExtensionThemeToken,
  ExtensionToolPermission,
  ExtensionView,
} from "loopsoar-contracts/extension";

/**
 * 计算某个扩展工具的实际权限：manifest 授权 ∩ 工具声明，fail-closed。
 *
 * 规则：
 *   · manifest 未声明权限 → 拒绝（不能靠“工具自己说自己只读”放行）；
 *   · 工具未声明任何权限 → 拒绝（空权限在 kindOfTool 里会被误判成 read）；
 *   · 工具声明了 manifest 未授予的权限 → 拒绝整个工具（不做静默降级）；
 *   · 工具不能声明 events（那是 manifest 级事件订阅，不是工具权限）；
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
    if (!(EXTENSION_TOOL_PERMISSION_KEYS as readonly string[]).includes(key)) {
      errors.push(
        key === "events"
          ? "工具不能声明 events（事件订阅请在 manifest.events 声明）"
          : `工具声明了未知权限：${key}`,
      );
      continue;
    }
    if (!granted.has(key)) {
      errors.push(`工具声明了 manifest 未授权的权限：${key}`);
      continue;
    }
    permissions[key as ExtensionToolPermission] = true;
  }

  return errors.length > 0 ? { permissions: {}, errors } : { permissions, errors };
}

/** 宿主扫描后附加的运行时信息（纯数据；不落盘，由壳层每次重算）。 */
export interface ExtensionRuntimeInfo {
  compatibility: ExtensionCompatibility;
  trust: ExtensionTrustState;
  certification: ExtensionCertification;
  dependencies: {
    ok: boolean;
    issues: string[];
    /** 依赖此扩展的其它扩展 id（禁用级联提示用）。 */
    dependents: string[];
  };
  /** 安装版本记录（用于 UI 展示回滚入口）。 */
  version?: { active: string; previous?: string };
  /** 市场撤销记录：命中后 certification=blocked，且不可启用/安装。 */
  revocation?: { reason: string; revokedAt: number; version?: string };
}

export interface InstalledExtension {
  manifest: ExtensionManifest;
  /** 安装目录绝对路径（壳层注入）。 */
  dir: string;
  enabled: boolean;
  installedAt: number;
  /** 壳层每次 scan 重算；纯逻辑注册表不填。 */
  info?: ExtensionRuntimeInfo;
}

export interface ExtensionCommandView {
  /** 斜杠命令名（含前导 /，已带扩展 id 防冲突）。 */
  command: string;
  title: string;
  description?: string;
  prompt: string;
  extensionId: string;
  extensionName: string;
}

/**
 * 收集已启用扩展的声明式命令；扩展 id/命令 id 已由 manifest schema 限制，
 * 这里只做前缀拼接，避免两个扩展贡献同名命令。
 */
export function collectExtensionCommands(extensions: readonly InstalledExtension[]): ExtensionCommandView[] {
  const out: ExtensionCommandView[] = [];
  for (const item of extensions) {
    if (!item.enabled) continue;
    for (const command of item.manifest.contributes?.commands ?? []) {
      out.push({
        command: `/${item.manifest.id}.${command.id}`,
        title: command.title,
        ...(command.description ? { description: command.description } : {}),
        prompt: command.prompt,
        extensionId: item.manifest.id,
        extensionName: item.manifest.name,
      });
    }
  }
  return out;
}

/** 扩展贡献的 loop：全局 id 加 ext. 前缀，避免与用户手写 loop（<dataDir>/loops）撞名。 */
export interface ExtensionLoopView {
  /** 全局唯一 id：`ext.<extensionId>.<loopId>`。 */
  id: string;
  name: string;
  description?: string;
  extensionId: string;
  extensionName: string;
  config: {
    systemPromptAppend?: string;
    maxRounds?: number;
    maxToolCalls?: number;
    allowedTools?: string[];
  };
}

/** 扩展贡献的主题：tokens 已通过白名单校验，UI 只按 token 写 CSS 变量。 */
export interface ExtensionThemeView {
  /** 全局唯一 id：`ext.<extensionId>.<themeId>`。 */
  id: string;
  name: string;
  description?: string;
  extensionId: string;
  extensionName: string;
  tokens: Record<string, string>;
}

export const EXTENSION_LOOP_PREFIX = "ext.";
/** 内置 loop id（core-loop）不可被扩展覆盖；这里用常量避免 core 反向依赖 shell。 */
const RESERVED_LOOP_IDS = new Set(["core-loop"]);

/**
 * 收集已启用扩展贡献的 loop（L2 声明式）。冲突（重复 id / 占用内置 id）一律跳过并上报，
 * 不做「后到者覆盖」——冲突必须可见，否则用户不知道哪个扩展没生效。
 */
export function collectExtensionLoops(extensions: readonly InstalledExtension[]): {
  loops: ExtensionLoopView[];
  conflicts: string[];
} {
  const loops: ExtensionLoopView[] = [];
  const conflicts: string[] = [];
  const seen = new Set<string>();
  for (const item of extensions) {
    if (!item.enabled) continue;
    for (const loop of item.manifest.contributes?.loops ?? []) {
      const id = `${EXTENSION_LOOP_PREFIX}${item.manifest.id}.${loop.id}`;
      if (RESERVED_LOOP_IDS.has(id) || seen.has(id)) {
        conflicts.push(`loop ${id} 与已有 loop 冲突，已跳过`);
        continue;
      }
      seen.add(id);
      loops.push({
        id,
        name: loop.name,
        ...(loop.description ? { description: loop.description } : {}),
        extensionId: item.manifest.id,
        extensionName: item.manifest.name,
        config: {
          ...(loop.systemPromptAppend ? { systemPromptAppend: loop.systemPromptAppend } : {}),
          ...(loop.maxRounds !== undefined ? { maxRounds: loop.maxRounds } : {}),
          ...(loop.maxToolCalls !== undefined ? { maxToolCalls: loop.maxToolCalls } : {}),
          ...(loop.allowedTools ? { allowedTools: [...loop.allowedTools] } : {}),
        },
      });
    }
  }
  return { loops, conflicts };
}

/** 收集已启用扩展贡献的主题（同 id 冲突跳过并上报）。 */
export function collectExtensionThemes(extensions: readonly InstalledExtension[]): {
  themes: ExtensionThemeView[];
  conflicts: string[];
} {
  const themes: ExtensionThemeView[] = [];
  const conflicts: string[] = [];
  const seen = new Set<string>();
  for (const item of extensions) {
    if (!item.enabled) continue;
    for (const theme of item.manifest.contributes?.themes ?? []) {
      const id = `${EXTENSION_LOOP_PREFIX}${item.manifest.id}.${theme.id}`;
      if (seen.has(id)) {
        conflicts.push(`theme ${id} 与已有主题冲突，已跳过`);
        continue;
      }
      seen.add(id);
      themes.push({
        id,
        name: theme.name,
        ...(theme.description ? { description: theme.description } : {}),
        extensionId: item.manifest.id,
        extensionName: item.manifest.name,
        tokens: { ...theme.tokens },
      });
    }
  }
  return { themes, conflicts };
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

  /** 已启用扩展的声明式指令 + turn.start hooks；注入 volatile 段，不执行代码。 */
  instructionsPrompt(): string {
    const blocks = this.enabled()
      .map((item) => {
        const text = item.manifest.contributes?.instructions?.trim();
        return text ? `### ${item.manifest.name}（${item.manifest.id}）\n${text}` : "";
      })
      .filter(Boolean);
    const hooks = this.enabled()
      .flatMap((item) =>
        (item.manifest.contributes?.hooks ?? []).map(
          (hook) => `### ${item.manifest.name}（${item.manifest.id}）· ${hook.event}\n${hook.prompt.trim()}`,
        ),
      )
      .filter(Boolean);
    if (blocks.length === 0 && hooks.length === 0) return "";
    return [
      ...(blocks.length > 0 ? ["## 扩展指令", ...blocks] : []),
      ...(hooks.length > 0 ? ["## 扩展 hooks（turn.start）", ...hooks] : []),
    ]
      .join("\n\n")
      .slice(0, 12_000);
  }

  clear(): void {
    this.items.clear();
  }
}
