/**
 * 扩展 manifest 契约（共享类型 + 校验 schema）。
 *
 * 放在 contracts 而不是 core，是因为设置页（ui）也要渲染 manifest；
 * UI 只允许依赖 contracts，不能反向依赖 core。core 重新导出这些符号保持旧导入路径兼容。
 *
 * ── API 版本策略（v2） ────────────────────────────────────────────────
 * 宿主 API 版本：EXTENSION_HOST_API_VERSION。
 * manifest 的 apiVersion 表示「扩展按哪个宿主 API 大版本编写」；宿主只保证
 * 同一大版本内的向后兼容，跨大版本由兼容性检查给出 upgrade 提示并拒绝启动。
 * engines.loopsoar 是对宿主应用版本的范围约束（与 apiVersion 正交）。
 */
import { z } from "zod";

/** 当前宿主插件 API 版本。改动破坏性接口时必须提升 major。 */
export const EXTENSION_HOST_API_VERSION = "2.0.0";
/** 未声明 apiVersion 的历史扩展按 1.0.0 处理（工具桥兼容，事件/视图不可用）。 */
export const EXTENSION_LEGACY_API_VERSION = "1.0.0";

/** 工具可声明的权限（与 ToolPermissions 对齐）。 */
export const EXTENSION_TOOL_PERMISSION_KEYS = ["read", "write", "terminal", "network"] as const;
export type ExtensionToolPermission = (typeof EXTENSION_TOOL_PERMISSION_KEYS)[number];

/**
 * manifest 可申请的权限。events 不进入工具权限：它只允许扩展订阅生命周期事件，
 * 不改变任何工具的沙箱判定。
 */
export const EXTENSION_PERMISSION_KEYS = [...EXTENSION_TOOL_PERMISSION_KEYS, "events"] as const;
export type ExtensionPermission = (typeof EXTENSION_PERMISSION_KEYS)[number];

/** 代码级事件钩子白名单（声明式 turn.start 提示词仍走 contributes.hooks）。 */
export const EXTENSION_EVENT_NAMES = ["turn.start", "turn.end", "tool.before", "tool.after"] as const;
export type ExtensionEventName = (typeof EXTENSION_EVENT_NAMES)[number];

const SEMVER_RE =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export const SemverStringSchema = z.string().min(1).max(80).regex(SEMVER_RE, "必须是 SemVer（如 1.2.3 / 1.2.3-beta.1）");
export const VersionRangeSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[\w\s.^~<>=|*xX+-]+$/, "版本范围含非法字符");

const ExtensionIdSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9._-]*$/i, "id 仅允许字母数字 . _ -");

/** 扩展贡献的斜杠命令：只把 prompt 填进输入框，不执行任意代码，用户可编辑后再发。 */
export const ExtensionCommandSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9._-]*$/i, "command id 仅允许字母数字 . _ -"),
  title: z.string().min(1).max(160),
  description: z.string().max(400).optional(),
  /** 选中命令后填入 Composer 的提示词模板。 */
  prompt: z.string().min(1).max(8_000),
});
export type ExtensionCommand = z.infer<typeof ExtensionCommandSchema>;

/** 声明式 UI 面板：只渲染文本/键值，不接受 HTML/脚本，避免第三方扩展污染主界面。 */
export const ExtensionPanelSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9._-]*$/i, "panel id 仅允许字母数字 . _ -"),
  title: z.string().min(1).max(160),
  description: z.string().max(2_000).optional(),
  items: z
    .array(z.object({ label: z.string().min(1).max(120), value: z.string().max(2_000) }))
    .max(20)
    .optional(),
});
export type ExtensionPanel = z.infer<typeof ExtensionPanelSchema>;

/** 声明式 hook：当前只支持 turn.start 注入提示词，不执行扩展代码。 */
export const ExtensionHookSchema = z.object({
  event: z.literal("turn.start"),
  prompt: z.string().min(1).max(4_000),
});
export type ExtensionHook = z.infer<typeof ExtensionHookSchema>;

/** 可贡献的主题 token 白名单：只允许覆盖颜色变量，禁止任意 CSS（防第三方扩展注入样式/截图）。 */
export const EXTENSION_THEME_TOKENS = [
  "ls-bg",
  "ls-surface",
  "ls-surface-raised",
  "ls-surface-hover",
  "ls-border",
  "ls-border-strong",
  "ls-text",
  "ls-text-muted",
  "ls-text-faint",
  "ls-accent",
  "ls-accent-hover",
  "ls-danger",
  "ls-teal",
] as const;
export type ExtensionThemeToken = (typeof EXTENSION_THEME_TOKENS)[number];

/** 颜色值只接受 hex / rgb(a) / hsl(a)：不接受 var()/url()/分号，杜绝 CSS 注入。 */
const ThemeColorSchema = z
  .string()
  .max(80)
  .regex(/^(#[0-9a-fA-F]{3,8}|rgba?\([0-9.,%\s]+\)|hsla?\([0-9.,%\s]+\))$/, "主题颜色只允许 hex / rgb() / hsl()");

/** 扩展贡献的 loop（L2 声明式）：只收紧预算 + 追加提示词，不执行扩展代码。 */
export const ExtensionLoopSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9._-]*$/i, "loop id 仅允许字母数字 . _ -"),
  name: z.string().min(1).max(160),
  description: z.string().max(400).optional(),
  /** 追加为本 loop 运行时的额外用户消息（不动 stable 系统提示）。 */
  systemPromptAppend: z.string().max(4_000).optional(),
  /** 只能收紧内置预算（applyDeclarativeLoop 内与硬上限取 min）。 */
  maxRounds: z.number().int().min(1).max(200).optional(),
  maxToolCalls: z.number().int().min(1).max(500).optional(),
  allowedTools: z.array(z.string().min(1).max(80)).max(80).optional(),
});
export type ExtensionLoopContribution = z.infer<typeof ExtensionLoopSchema>;

/** 扩展贡献的主题：只允许覆盖白名单 CSS 变量（token），不做任意 CSS。 */
export const ExtensionThemeSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9._-]*$/i, "theme id 仅允许字母数字 . _ -"),
  name: z.string().min(1).max(160),
  description: z.string().max(400).optional(),
  tokens: z
    .record(z.enum(EXTENSION_THEME_TOKENS), ThemeColorSchema)
    .refine((tokens) => Object.keys(tokens).length > 0, "主题至少要覆盖一个 token"),
});
export type ExtensionThemeContribution = z.infer<typeof ExtensionThemeSchema>;

/**
 * 扩展目录内的相对路径（入口/视图）：拒绝绝对路径、盘符与 `..` 穿越。
 * 真正的 realpath 校验在安装器/协议处理器里再做一层（纵深防御）。
 */
export const ExtensionRelativePathSchema = z
  .string()
  .min(1)
  .max(300)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.startsWith("\\") &&
      !/^[a-zA-Z]:/.test(value) &&
      !value.split(/[\\/]/).includes("..") &&
      !value.includes("\0"),
    "必须是扩展目录内的相对路径（不允许绝对路径 / .. 穿越）",
  );

/** 富 UI 视图：HTML 入口在沙箱 iframe 中加载，只能通过 postMessage 与应用通信。 */
export const ExtensionViewSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9._-]*$/i, "view id 仅允许字母数字 . _ -"),
  title: z.string().min(1).max(160),
  description: z.string().max(400).optional(),
  /** 相对扩展目录的 HTML 入口。 */
  entry: ExtensionRelativePathSchema,
  /** 期望高度（px）；UI 可在运行时按视图消息调整。 */
  height: z.number().int().min(200).max(1_200).optional(),
});
export type ExtensionView = z.infer<typeof ExtensionViewSchema>;

/** Ed25519 分离签名：publicKey 为 base64 SPKI DER，value 为 base64 签名。 */
export const ExtensionSignatureSchema = z.object({
  algorithm: z.literal("ed25519"),
  publicKey: z.string().min(40).max(2_000).regex(/^[A-Za-z0-9+/=]+$/, "publicKey 必须是 base64"),
  value: z.string().min(40).max(2_000).regex(/^[A-Za-z0-9+/=]+$/, "signature 必须是 base64"),
  signedAt: z.number().int().nonnegative().optional(),
});
export type ExtensionSignature = z.infer<typeof ExtensionSignatureSchema>;

/** 声明式贡献点：commands / instructions / ui / hooks / loops / themes / views，均为数据，不执行扩展代码。 */
export const ExtensionContributionsSchema = z.object({
  commands: z.array(ExtensionCommandSchema).max(32).optional(),
  /** 启用后注入 Agent volatile 段的系统指令（不是工具，不执行代码）。 */
  instructions: z.string().max(4_000).optional(),
  /** 设置页只读面板（纯文本/键值）。 */
  ui: z.array(ExtensionPanelSchema).max(8).optional(),
  /** 每轮会话开始注入的声明式提示（不是回调，不执行代码）。 */
  hooks: z.array(ExtensionHookSchema).max(8).optional(),
  /** 可插拔 loop（L2 声明式）：注册进 LoopRegistry，与内置同样受静态校验与回退约束。 */
  loops: z.array(ExtensionLoopSchema).max(8).optional(),
  /** 主题（只覆盖白名单 CSS 变量）。 */
  themes: z.array(ExtensionThemeSchema).max(8).optional(),
  /** 富 UI 视图（沙箱 iframe + 自定义协议，不接触主界面 DOM）。 */
  views: z.array(ExtensionViewSchema).max(8).optional(),
});
export type ExtensionContributions = z.infer<typeof ExtensionContributionsSchema>;

export const ExtensionManifestSchema = z.object({
  id: ExtensionIdSchema,
  name: z.string().min(1).max(200),
  /** SemVer 必填：市场更新/回滚/依赖解析都依赖可比版本。 */
  version: SemverStringSchema,
  /** 扩展编写所依据的宿主 API 版本；缺省按 1.0.0（兼容历史工具桥扩展）。 */
  apiVersion: SemverStringSchema.default(EXTENSION_LEGACY_API_VERSION),
  /** 对宿主应用版本的范围约束；缺省不限制（兼容性检查会给出 unpinned 警告）。 */
  engines: z
    .object({
      loopsoar: VersionRangeSchema,
    })
    .optional(),
  description: z.string().max(4000).optional(),
  author: z.string().max(200).optional(),
  /** 发布者 id：用于市场展示与信任归组（不是身份认证，认证靠签名公钥）。 */
  publisher: ExtensionIdSchema.optional(),
  license: z.string().max(80).optional(),
  homepage: z.string().max(500).optional(),
  repository: z.string().max(500).optional(),
  /** 入口文件（相对扩展目录）；纯声明式扩展可省略。 */
  main: ExtensionRelativePathSchema.optional(),
  /**
   * 扩展可用的权限上限。未声明 = 扩展工具/事件全部拒绝（fail-closed）。
   * events 只放行事件订阅；工具仍走各自的 permissions 交集。
   */
  permissions: z.array(z.enum(EXTENSION_PERMISSION_KEYS)).max(5).optional(),
  /**
   * OS 级隔离：设为 "node" 时 worker 用 Node permission model 启动，
   * 只读扩展目录与 worker 目录，写权限仅限扩展目录，子进程按 terminal 授权；
   * "strict" 进一步去掉 write/child/addons。默认 "none" 保持旧扩展兼容。
   */
  isolation: z.enum(["none", "node", "strict"]).optional(),
  /** 代码级事件订阅声明：只有在此声明的扩展才允许 api.on(event)。 */
  events: z.array(z.enum(EXTENSION_EVENT_NAMES)).max(8).optional(),
  /**
   * 包内容摘要（`sha256-<base64>`）：覆盖除 manifest 自身外的全部文件。
   * 有签名的包必须带 integrity；安装器会重新计算并比对。
   */
  integrity: z.string().max(200).regex(/^sha256-[A-Za-z0-9+/=]{40,}$/, "integrity 必须是 sha256-<base64>").optional(),
  /** Ed25519 签名；签名对象是「去掉 signature 字段的规范化清单」。 */
  signature: ExtensionSignatureSchema.optional(),
  /**
   * 插件依赖：扩展 id → SemVer 范围。依赖必须已安装且启用；禁用会被依赖图拒绝，
   * 禁用被依赖方会级联禁用依赖者（可见上报，不静默）。
   */
  dependencies: z.record(ExtensionIdSchema, VersionRangeSchema).optional(),
  /** 声明式贡献点。 */
  contributes: ExtensionContributionsSchema.optional(),
  keywords: z.array(z.string().max(80)).max(50).optional(),
});

export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;
