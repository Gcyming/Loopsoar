/**
 * 通用偏好（设置 · 通用）：默认值 / 校验 / 合并（纯逻辑）。
 * 为什么把默认值放 core：壳层、UI、测试三处都要知道「未配置时是什么」，
 * 各写一份必然漂移；这里作为唯一产地，UI 只做展示与收集。
 */
import { z } from "zod";

export const AnimationsSchema = z.enum(["full", "reduced", "off"]);
export type Animations = z.infer<typeof AnimationsSchema>;

export const PreferencesSchema = z.object({
  language: z.enum(["zh-CN", "en-US"]),
  animations: AnimationsSchema,
  restoreSession: z.boolean(),
  searchEngine: z.enum(["bing", "google", "duckduckgo"]),
  downloadDir: z.string().max(1024).optional(),
  workspaceRoot: z.string().max(1024).optional(),
  memoryStorePath: z.string().max(1024).optional(),
  memoryAutoCapture: z.boolean(),
  sidebarWidth: z.number().int().min(240).max(720),
  /** Agent 单次任务最多请求轮数（防止无限循环；默认 40）。 */
  agentMaxRounds: z.number().int().min(1).max(500).optional(),
  /** Agent 单次任务最多工具调用次数（默认 100）。 */
  agentMaxToolCalls: z.number().int().min(1).max(2000).optional(),
  /** 相同工具+参数重复调用的提醒阈值（默认 5）。 */
  agentRepeatToolWarn: z.number().int().min(2).max(50).optional(),
  /** 相同工具+参数重复调用的停止阈值（默认 30）。 */
  agentRepeatToolStop: z.number().int().min(3).max(200).optional(),
  /** 推理强度（空 = 模型默认；重启后保持）。 */
  reasoningEffort: z.string().max(64).optional(),
  /** 当前 Agent-Loop id（空 = 内置 loop）；与 contracts PreferencesSchema 同步，勿再漂移。 */
  loopId: z.string().max(64).optional(),
});

export type Preferences = z.infer<typeof PreferencesSchema>;

export const DEFAULT_PREFERENCES: Preferences = {
  language: "zh-CN",
  animations: "full",
  restoreSession: true,
  searchEngine: "bing",
  downloadDir: "",
  workspaceRoot: "",
  memoryStorePath: "",
  memoryAutoCapture: true,
  sidebarWidth: 360,
  agentMaxRounds: 40,
  agentMaxToolCalls: 100,
  agentRepeatToolWarn: 5,
  agentRepeatToolStop: 30,
  reasoningEffort: "",
  loopId: "",
};

/** 合并：未知字段丢弃、缺字段补默认、非法值抛可读错误。 */
export function mergePreferences(raw: unknown): Preferences {
  const merged = { ...DEFAULT_PREFERENCES, ...(typeof raw === "object" && raw !== null ? raw : {}) };
  const parsed = PreferencesSchema.safeParse(merged);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("；");
    throw new Error(`偏好配置非法：${detail}`);
  }
  return {
    ...parsed.data,
    downloadDir: parsed.data.downloadDir ?? "",
    workspaceRoot: parsed.data.workspaceRoot ?? "",
    memoryStorePath: parsed.data.memoryStorePath ?? "",
    agentMaxRounds: parsed.data.agentMaxRounds ?? 40,
    agentMaxToolCalls: parsed.data.agentMaxToolCalls ?? 100,
    agentRepeatToolWarn: parsed.data.agentRepeatToolWarn ?? 5,
    agentRepeatToolStop: parsed.data.agentRepeatToolStop ?? 30,
    reasoningEffort: parsed.data.reasoningEffort ?? "",
    loopId: parsed.data.loopId ?? "",
  };
}

/** 搜索引擎 → omnibox 搜索 URL 模板（非 URL 输入时使用）。 */
export function searchUrlFor(engine: Preferences["searchEngine"], query: string): string {
  const q = encodeURIComponent(query);
  switch (engine) {
    case "google":
      return `https://www.google.com/search?q=${q}`;
    case "duckduckgo":
      return `https://duckduckgo.com/?q=${q}`;
    case "bing":
    default:
      return `https://www.bing.com/search?q=${q}`;
  }
}
