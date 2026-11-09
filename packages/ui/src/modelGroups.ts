/**
 * 模型选择列表的数据整备（纯逻辑）：把"多供应商配置"整理成按供应商分组的可选模型。
 *
 * 背景：输入区的模型菜单只展示当前供应商，用户无法直接切到另一个供应商的模型。
 * 这里以 providers 列表为唯一输入：默认模型必须在、被停用的模型不展示、活动供应商置顶。
 */
import type { ProviderItem } from "./types.js";

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
  models: ModelChoice[];
}

/** 生成模型菜单分组；activeId 缺省时按列表顺序。 */
export function buildModelGroups(items: ProviderItem[], activeId: string | null): ModelGroup[] {
  const groups: ModelGroup[] = [];
  for (const item of items) {
    const enabled = (item.models ?? []).filter((model) => typeof model.id === "string" && model.id.trim() && model.selected !== false);
    const models: ModelChoice[] = [];
    const push = (model: {
      id: string;
      thinking?: boolean;
      vision?: boolean;
      contextWindow?: number;
      thinkingEfforts?: string[];
      inputModalities?: Array<"text" | "image" | "audio" | "video">;
    }): void => {
      if (!model.id || models.some((existing) => existing.id === model.id)) return;
      const source = enabled.find((candidate) => candidate.id === model.id);
      models.push({
        id: model.id,
        thinking: model.thinking ?? source?.thinking,
        vision: model.vision ?? source?.vision,
        contextWindow: model.contextWindow ?? source?.contextWindow,
        thinkingEfforts: model.thinkingEfforts ?? source?.thinkingEfforts,
        inputModalities: model.inputModalities ?? source?.inputModalities,
      });
    };
    // 默认模型始终显示（即使设置里未勾选），其余只展示启用项
    push({ id: item.model });
    for (const model of enabled) push(model);
    groups.push({
      providerId: item.id,
      provider: item.provider,
      baseUrl: item.baseUrl,
      active: item.id === activeId,
      models: models.slice(0, 200),
    });
  }
  // 活动供应商置顶，其余保持配置顺序
  return groups.sort((a, b) => Number(b.active) - Number(a.active));
}
