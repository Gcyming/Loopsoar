/**
 * 通用偏好（设置 · 通用）：默认值 / 合并（纯逻辑）。
 *
 * schema 唯一产地是契约层（packages/contracts/src/schemas.ts 的 PreferencesSchema）：
 * 壳层受信入口用它 safeParse，UI 用它的推断类型渲染。core 若再自持一份 schema，
 * 两边字段必然漂移 —— 契约侧不认识的字段会被 zod 默认 strip 掉，落盘时静默回默认值。
 * 因此这里只保留「默认值 + 合并行为 + 搜索引擎 URL」，字段定义一律从契约导入。
 */
import { PreferencesSchema, type PreferencesData } from "loopsoar-contracts/schemas";

/** 动效强度枚举（由契约 schema 推导，保留旧导出名以免调用点断裂）。 */
export const AnimationsSchema = PreferencesSchema.shape.animations;
export type Animations = PreferencesData["animations"];

export type Preferences = PreferencesData;

export const DEFAULT_PREFERENCES: Preferences = {
  language: "zh-CN",
  animations: "full",
  restoreSession: true,
  searchEngine: "bing",
  downloadDir: "",
  workspaceRoot: "",
  memoryStorePath: "",
  memoryAutoCapture: true,
  skillAutoCandidate: false,
  sidebarWidth: 360,
  theme: "soft",
  sidebarMode: "docked",
  browserOpenLayout: "docked",
  agentMaxRounds: 80,
  agentMaxToolCalls: 100,
  agentRepeatToolWarn: 5,
  agentRepeatToolStop: 30,
  reasoningEffort: "",
  loopId: "",
  adBlockEnabled: true,
  sensitiveAlwaysConfirm: true,
};

/** 合并：未知字段丢弃、缺字段补默认、非法值抛可读错误。 */
export function mergePreferences(raw: unknown): Preferences {
  const source = typeof raw === "object" && raw !== null ? { ...(raw as Record<string, unknown>) } : {};
  // 历史兼容：旧版本默认搜索引擎是 DuckDuckGo（已下线），读到旧配置时迁移到 Bing，
  // 否则 schema 校验失败会把整份偏好判为非法（用户升级后设置页直接报错）。
  if (source.searchEngine === "duckduckgo" || typeof source.searchEngine !== "string") {
    delete source.searchEngine;
  }
  // 历史兼容：「每次询问」策略已下线（首启向导选一次，之后在设置里改）。
  // 老配置里的 "ask" 迁移为默认的 docked，否则 schema 校验失败会让整份偏好判为非法。
  if (source.browserOpenLayout === "ask") source.browserOpenLayout = "docked";
  const merged = { ...DEFAULT_PREFERENCES, ...source };
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
    // 旧默认 40 在长任务里频繁触发轮次闸；未显式改过的用户迁移到 80。
    agentMaxRounds: parsed.data.agentMaxRounds === undefined || parsed.data.agentMaxRounds === 40 ? 80 : parsed.data.agentMaxRounds,
    agentMaxToolCalls: parsed.data.agentMaxToolCalls ?? 100,
    agentRepeatToolWarn: parsed.data.agentRepeatToolWarn ?? 5,
    agentRepeatToolStop: parsed.data.agentRepeatToolStop ?? 30,
    reasoningEffort: parsed.data.reasoningEffort ?? "",
    loopId: parsed.data.loopId ?? "",
    adBlockEnabled: parsed.data.adBlockEnabled ?? true,
    sensitiveAlwaysConfirm: parsed.data.sensitiveAlwaysConfirm ?? true,
    theme: parsed.data.theme ?? "soft",
    sidebarMode: parsed.data.sidebarMode ?? "docked",
    browserOpenLayout: parsed.data.browserOpenLayout ?? "docked",
  };
}

/** 搜索引擎 → omnibox 搜索 URL 模板（非 URL 输入时使用）。 */
export function searchUrlFor(engine: Preferences["searchEngine"], query: string): string {
  const q = encodeURIComponent(query);
  switch (engine) {
    case "google":
      return `https://www.google.com/search?q=${q}`;
    case "baidu":
      return `https://www.baidu.com/s?wd=${q}`;
    case "bing":
    default:
      return `https://www.bing.com/search?q=${q}`;
  }
}
