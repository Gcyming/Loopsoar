/**
 * 模型视觉能力解析（设置·通用 imageInputEnabled + 供应商模型能力表）。
 *
 * 返回：
 *   · false：明确不支持（隐私开关关闭，或能力表明确 vision=false）；
 *   · true：能力表声明 vision=true 或 inputModalities 含 image；
 *   · undefined：能力表未填，交给上游尝试（自定义供应商的视觉模型不应被静默降级）。
 */
export interface VisionModelSpec {
  id: string;
  vision?: boolean;
  inputModalities?: string[];
}

export interface VisionProviderConfig {
  model?: string;
  models?: VisionModelSpec[];
}

export function resolveModelContextWindow(
  active: { model?: string; models?: { id: string; contextWindow?: number }[] } | null | undefined,
): number | undefined {
  return active?.models?.find((model) => model.id === active.model)?.contextWindow;
}

export function resolveModelVision(
  active: VisionProviderConfig | null | undefined,
  imageInputEnabled: boolean,
): boolean | undefined {
  if (!imageInputEnabled) return false;
  const spec = active?.models?.find((model) => model.id === active.model);
  if (!spec) return undefined;
  if (spec.vision === true) return true;
  if (spec.inputModalities?.includes("image")) return true;
  return spec.vision === false ? false : undefined;
}
