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
    const push = (model: { id: string; thinking?: boolean; vision?: boolean; contextWindow?: number; thinkingEfforts?: string[] }): void => {
      if (!model.id || models.some((existing) => existing.id === model.id)) return;
      const source = enabled.find((candidate) => candidate.id === model.id);
      models.push({
        id: model.id,
        thinking: model.thinking ?? source?.thinking,
        vision: model.vision ?? source?.vision,
        contextWindow: model.contextWindow ?? source?.contextWindow,
        thinkingEfforts: model.thinkingEfforts ?? source?.thinkingEfforts,
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
