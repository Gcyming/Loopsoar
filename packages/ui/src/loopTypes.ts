/* ── Agent-Loop（ADR-0010：内置 loop + 安全回退 + 选择） ── */

/** 一个可运行的 Agent 执行循环（builtin 不可删除、不可原位修改）。 */
export interface LoopInfo {
  id: string;
  name: string;
  builtin: boolean;
  /** 是否为当前活动 loop。 */
  active: boolean;
  /** 三档 loop 类型（builtin / 声明式 / 脚本）；旧后端可缺省。 */
  kind?: "builtin" | "declarative" | "script" | "custom";
  /** 定义是否可用（坏 JSON / 脚本缺失时 false，UI 应灰显）。 */
  valid?: boolean;
  error?: string;
  description?: string;
  /** 设置页是否允许编辑（仅普通 L2 声明式文件）。 */
  editable?: boolean;
}

/** 阶段 id（与契约 loopStages.ts 保持一致；UI 不依赖 shell）。 */
export type LoopStageId = "plan" | "research" | "browse" | "interact" | "workspace" | "delegate";

export interface LoopStageConfig {
  id: LoopStageId;
  enabled: boolean;
}

/** 设置页编辑的声明式配置（loop:get/save 的载荷）。 */
export interface LoopEditorConfig {
  kind: "declarative";
  id: string;
  name: string;
  description?: string;
  systemPromptAppend?: string;
  maxRounds?: number;
  maxToolCalls?: number;
  stages?: LoopStageConfig[];
  allowedTools?: string[];
  temperature?: number;
}

export interface LoopGetResult {
  ok: boolean;
  error?: string;
  loop?: LoopInfo & { config?: LoopEditorConfig };
}

export interface LoopSaveResult extends LoopListResult {
  ok: boolean;
  error?: string;
  savedId?: string;
  filePath?: string;
}

export interface LoopDeleteResult extends LoopListResult {
  ok: boolean;
  error?: string;
  deletedId?: string;
}

/** 安全回退记录（自定义 loop 失败 → 用同一 ctx 回退 builtin）。 */
export interface LoopFallbackRecord {
  reason: string;
  at: number;
}

/** loop:list 返回：可选 loop 列表 + 当前选择 + 回退历史。 */
/** /compact 结果。 */
export interface CompactResult {
  ok: boolean;
  before: { messages: number; chars: number };
  after: { messages: number; chars: number };
  dropped: number;
  savedRatio: number;
  applied: boolean;
  /** 是否真的超出预算（false 时 apply 也幂等无副作用）。 */
  compressed?: boolean;
  sessionId?: string;
  /** 压缩摘要正文（apply 时写入会话）。 */
  summary?: string;
  /** 预览条目（apply=false 时最多 24 条）。 */
  preview?: Array<{ role?: string; text: string }>;
  error?: string;
}

export interface LoopListResult {
  loops: LoopInfo[];
  activeId: string | null;
  fallbacks: LoopFallbackRecord[];
}

/** loop:setActive 返回（失败带中文原因；成功时同时带最新列表，省一次 loop:list 往返）。 */
export interface LoopSetActiveResult {
  ok: boolean;
  error?: string;
  activeId?: string | null;
  /** 成功时返回的最新 loop 列表（与 loop:list 同构字段）。 */
  loops?: LoopInfo[];
  fallbacks?: LoopFallbackRecord[];
}

/** loop:changed 事件负载：活动 loop 变更（可能携带最新列表）。 */
export interface LoopChangedPayload {
  activeId: string | null;
  loops?: LoopInfo[];
}

/** loop:fallback 事件负载：安全回退（界面必须显著提示）。 */
export interface LoopFallbackPayload {
  reason: string;
  at?: number;
}
