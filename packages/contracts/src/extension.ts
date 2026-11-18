/**
 * 扩展 manifest 契约（共享类型 + 校验 schema）。
 *
 * 放在 contracts 而不是 core，是因为设置页（ui）也要渲染 manifest；
 * UI 只允许依赖 contracts，不能反向依赖 core。core 重新导出这些符号保持旧导入路径兼容。
 */
import { z } from "zod";

export const EXTENSION_PERMISSION_KEYS = ["read", "write", "terminal", "network"] as const;
export type ExtensionPermission = (typeof EXTENSION_PERMISSION_KEYS)[number];

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

/** 声明式贡献点：commands / instructions / ui / hooks，均为数据，不执行扩展代码。 */
export const ExtensionContributionsSchema = z.object({
  commands: z.array(ExtensionCommandSchema).max(32).optional(),
  /** 启用后注入 Agent volatile 段的系统指令（不是工具，不执行代码）。 */
  instructions: z.string().max(4_000).optional(),
  /** 设置页只读面板（纯文本/键值）。 */
  ui: z.array(ExtensionPanelSchema).max(8).optional(),
  /** 每轮会话开始注入的声明式提示（不是回调，不执行代码）。 */
  hooks: z.array(ExtensionHookSchema).max(8).optional(),
});
export type ExtensionContributions = z.infer<typeof ExtensionContributionsSchema>;

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
  isolation: z.enum(["none", "node", "strict"]).optional(),
  /** 声明式贡献点；目前支持 commands（提示词模板），不执行扩展代码。 */
  contributes: ExtensionContributionsSchema.optional(),
  keywords: z.array(z.string().max(80)).max(50).optional(),
});

export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;
