/**
 * 模型选择列表的数据整备（纯逻辑）：把"多供应商配置"整理成按供应商分组的可选模型。
 *
 * 背景：输入区的模型菜单只展示当前供应商，用户无法直接切到另一个供应商的模型。
 * 这里以 providers 列表为唯一输入：展示每个供应商里**开关打开（selected !== false）**的全部模型，
 * 提供商内模型开关（拨片）控制"是否出现在菜单"；没有「默认模型」概念，点哪个用哪个；活动供应商置顶。
 */
import type { ProviderItem, ProviderModel } from "./types.js";

export interface ModelChoice {
  id: string;
  thinking?: boolean;
  vision?: boolean;
  contextWindow?: number;
  thinkingEfforts?: string[];
  /** 输入模态（text/image/audio/video）：模型菜单用「图」徽标提示是否支持图片输入。 */
  inputModalities?: Array<"text" | "image" | "audio" | "video">;
}

/** 模型能力信息的固定取值顺序（展示/输入归一都按这个顺序，便于稳定断言）。 */
export const INPUT_MODALITIES = ["text", "image", "audio", "video"] as const;
export type InputModality = (typeof INPUT_MODALITIES)[number];

/**
 * 归一化模态输入：兼容逗号（中英文）/空格分隔、大小写、重复值，过滤非法值。
 * 结果按 INPUT_MODALITIES 固定顺序排列（text,image,audio,video）。
 */
export function parseModalitiesInput(raw: string): InputModality[] {
  const tokens = raw
    .split(/[,，\s]+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  const accepted = new Set(tokens.filter((token): token is InputModality => (INPUT_MODALITIES as readonly string[]).includes(token)));
  return INPUT_MODALITIES.filter((modality) => accepted.has(modality));
}

/** 模态数组 → 表格输入框文本（只保留合法值，逗号分隔）。 */
export function modalitiesToInput(modalities: readonly string[] | undefined): string {
  return parseModalitiesInput((modalities ?? []).join(",")).join(",");
}

/**
 * 模态数组 → 可读徽标文本（如「文本/图片/视频」）。
 * 文案由调用方传入的翻译函数决定（设置面板用 i18n；测试传确定性 mock）；空返回 "—"。
 */
export function formatModalities(modalities: readonly string[] | undefined, translate: (key: string) => string): string {
  const normalized = parseModalitiesInput((modalities ?? []).join(","));
  if (normalized.length === 0) return "—";
  return normalized.map((modality) => translate(`settings.providers.modality.${modality}`)).join("/");
}

/** 三态布尔（undefined/true/false）→ 表格 <select> 的 value。 */
export function triStateToValue(value: boolean | undefined): "" | "true" | "false" {
  if (value === true) return "true";
  if (value === false) return "false";
  return "";
}

/** 表格 <select> 的 value → 三态布尔（"" → undefined，表示未知/自动）。 */
export function valueToTriState(value: string): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/**
 * 上下文窗口的紧凑展示：1000000 → "1M"，131072 → "131K"，8000 → "8K"，512 → "512"。
 * 无值/非法值返回 undefined（调用方只在有值时渲染，避免菜单变宽）。
 */
export function formatContextWindow(tokens: number | undefined): string | undefined {
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return undefined;
  if (tokens >= 1_000_000) {
    const millions = Math.round(tokens / 100_000) / 10;
    return `${millions}M`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(Math.round(tokens));
}

/** 是否支持图片输入：显式 vision=true 或 inputModalities 含 image（模型菜单「图」徽标用）。 */
export function supportsImageInput(vision: boolean | undefined, modalities: readonly string[] | undefined): boolean {
  return vision === true || parseModalitiesInput((modalities ?? []).join(",")).includes("image");
}

export interface ModelGroup {
  providerId: string;
  provider: string;
  baseUrl: string;
  active: boolean;
  /** OpenCode 计划标记：go = Go 订阅额度（/inference/go），payg = 按量付费钱包；其他供应商为 null。 */
  plan: "go" | "payg" | null;
  models: ModelChoice[];
}

/**
 * 识别 OpenCode 供应商的计划（两套端点、两套额度/Key，不可混用）：
 *   · https://opencode.ai/inference/go/... → "go"（Go 订阅额度）
 *   · https://opencode.ai/inference/...     → "payg"（按量付费余额）
 * 菜单/供应商卡片据此显示「Go 订阅 / 按量付费」，避免同名模型选错计划（402 余额不足的常见原因）。
 */
export function openCodePlanLabel(baseUrl: string): "go" | "payg" | null {
  if (!/opencode\.ai/i.test(baseUrl)) return null;
  return /\/inference\/go(\/|$)/i.test(baseUrl) ? "go" : "payg";
}

/** 生成模型菜单分组；activeId 缺省时按列表顺序。 */
export function buildModelGroups(items: ProviderItem[], activeId: string | null): ModelGroup[] {
  const groups: ModelGroup[] = [];
  for (const item of items) {
    const models: ModelChoice[] = [];
    const push = (model: {
      id: string;
      thinking?: boolean;
      vision?: boolean;
      contextWindow?: number;
      thinkingEfforts?: string[];
      inputModalities?: Array<"text" | "image" | "audio" | "video">;
    }): void => {
      const id = typeof model.id === "string" ? model.id.trim() : "";
      if (!id || models.some((existing) => existing.id === id)) return;
      models.push({
        id,
        thinking: model.thinking,
        vision: model.vision,
        contextWindow: model.contextWindow,
        thinkingEfforts: model.thinkingEfforts,
        inputModalities: model.inputModalities,
      });
    };
    // 只展示开关打开的模型；旧数据没有 selected 字段时视为打开（默认全部可用）。
    // 没有「默认模型」特例：菜单里点哪个就是哪个。
    for (const model of item.models ?? []) {
      if (model.selected === false) continue;
      push(model);
    }
    if (models.length === 0 && item.model) push({ id: item.model });
    groups.push({
      providerId: item.id,
      provider: item.provider,
      baseUrl: item.baseUrl,
      active: item.id === activeId,
      plan: openCodePlanLabel(item.baseUrl),
      models: models.slice(0, 200),
    });
  }
  // 活动供应商置顶，其余保持配置顺序
  return groups.sort((a, b) => Number(b.active) - Number(a.active));
}

/** 「获取模型列表」时可被上游刷新的能力字段（与 core 的 CAPABILITY_KEYS 对齐）。 */
export const MODEL_CAPABILITY_KEYS = [
  "contextWindow",
  "maxOutput",
  "vision",
  "thinking",
  "thinkingEfforts",
  "inputModalities",
  "functionCalling",
  "structuredOutput",
] as const;
export type ModelCapabilityKey = (typeof MODEL_CAPABILITY_KEYS)[number];

/** 后端返回的每个模型能力来源诊断（上游给了哪些字段、内置表推断出哪些）。 */
export interface ProviderCapabilityMeta {
  upstreamFields?: string[];
  inferredCaps?: Record<string, unknown>;
}

export interface MergeFetchedModelsResult {
  models: ProviderModel[];
  /** 上游确实返回了能力字段的模型数。 */
  upstreamModels: number;
  /** 合并后至少带一项能力（上下文/输出/视觉/模态/工具/结构化输出/思考）的模型数。 */
  enrichedModels: number;
}

const capabilityValueEqual = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => value === b[index]);
  return a === b;
};

/**
 * 合并「刚拉取的上游模型列表」与本地已有模型配置，并贯彻三态优先级：
 * **用户显式手填 > 上游实时元数据 > 内置表推断**。
 *
 * 判定「显式手填」：本地已有值且与内置表推断值不同（推断值由后端随 capabilityMeta 回传）。
 * 这样再次点「获取模型列表」时，上游新值能刷新掉旧的自动填充，但不会覆盖用户手填的字段。
 * 不再有「默认模型/启用勾选」：拉到的模型全部进入清单，菜单里全部可选。
 */
export function mergeFetchedProviderModels(
  fetched: ProviderModel[],
  existing: ProviderModel[],
  capabilityMeta: Record<string, ProviderCapabilityMeta> | undefined,
): MergeFetchedModelsResult {
  const existingById = new Map(
    existing.filter((model) => typeof model.id === "string" && model.id.trim()).map((model) => [model.id, model]),
  );
  const seen = new Set<string>();
  const models: ProviderModel[] = [];
  let upstreamModels = 0;
  for (const incoming of fetched) {
    const id = typeof incoming.id === "string" ? incoming.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const prev = existingById.get(id);
    const meta = capabilityMeta?.[id];
    const upstreamFields = new Set(meta?.upstreamFields ?? []);
    const inferredCaps = meta?.inferredCaps ?? {};
    if (upstreamFields.size > 0) upstreamModels += 1;
    const merged: ProviderModel = { ...incoming, id };
    for (const key of MODEL_CAPABILITY_KEYS) {
      const prevValue = prev?.[key];
      const inferredValue = inferredCaps[key];
      const incomingValue = incoming[key];
      // 显式手填：本地值存在且与内置推断不同 → 刷新时保留用户值。
      const manuallySet = prevValue !== undefined && (inferredValue === undefined || !capabilityValueEqual(prevValue, inferredValue));
      if (manuallySet) {
        (merged as unknown as Record<string, unknown>)[key] = prevValue;
      } else if (incomingValue !== undefined) {
        (merged as unknown as Record<string, unknown>)[key] = incomingValue;
      }
    }
    // 历史数据里的启用标记原样保留（仅兼容旧 providers.json；菜单已不再按它过滤）。
    // 历史勾选标记沿用本地；新拉到的模型默认打开（用户可在供应商里用拨片关掉不想看的）。
    merged.selected = prev?.selected ?? incoming.selected ?? true;
    models.push(merged);
  }
  const enrichedModels = models.filter((model) =>
    MODEL_CAPABILITY_KEYS.some((key) => model[key] !== undefined),
  ).length;
  return { models, upstreamModels, enrichedModels };
}
