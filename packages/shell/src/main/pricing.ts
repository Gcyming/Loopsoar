/**
 * 模型参考价与成本估算。
 *
 * 为什么内置价目表：trace 面板要给出「大概花了多少」，而供应商/网关普遍不回传金额。
 * 价格是公开标价的近似值（USD / 1M tokens），随时会变；所以：
 *  - 只在拿到 input/output 拆分时估算，绝不拿 total 硬拆；
 *  - 未知模型返回 undefined，面板显示「未匹配定价」而不是伪造数字；
 *  - 展示处必须标注「参考价估算，非账单」。
 */
export interface ModelPrice {
  /** 匹配模型 id（小写子串/正则）。 */
  pattern: RegExp;
  inputPerM: number;
  outputPerM: number;
  label: string;
}

/** 参考价（USD / 1M tokens）。顺序敏感：先匹配更具体的型号。 */
export const MODEL_PRICES: ModelPrice[] = [
  { pattern: /gpt-4o-mini/, inputPerM: 0.15, outputPerM: 0.6, label: "gpt-4o-mini" },
  { pattern: /gpt-4o/, inputPerM: 2.5, outputPerM: 10, label: "gpt-4o" },
  { pattern: /gpt-4\.1-mini/, inputPerM: 0.4, outputPerM: 1.6, label: "gpt-4.1-mini" },
  { pattern: /gpt-4\.1/, inputPerM: 2, outputPerM: 8, label: "gpt-4.1" },
  { pattern: /gpt-4\.5/, inputPerM: 2, outputPerM: 8, label: "gpt-4.5" },
  { pattern: /o4-mini/, inputPerM: 1.1, outputPerM: 4.4, label: "o4-mini" },
  { pattern: /claude.*opus/, inputPerM: 15, outputPerM: 75, label: "claude-opus" },
  { pattern: /claude.*sonnet/, inputPerM: 3, outputPerM: 15, label: "claude-sonnet" },
  { pattern: /claude.*haiku/, inputPerM: 0.8, outputPerM: 4, label: "claude-haiku" },
  { pattern: /deepseek.*reasoner/, inputPerM: 0.55, outputPerM: 2.19, label: "deepseek-reasoner" },
  { pattern: /deepseek/, inputPerM: 0.27, outputPerM: 1.1, label: "deepseek-chat" },
  { pattern: /gemini.*flash/, inputPerM: 0.3, outputPerM: 2.5, label: "gemini-flash" },
  { pattern: /gemini.*pro/, inputPerM: 1.25, outputPerM: 10, label: "gemini-pro" },
];

export const PRICING_NOTE =
  "成本为内置参考价估算（USD / 1M tokens），非供应商账单；未知模型或缺少 input/output 拆分时不估算。";

export function priceFor(model: string | undefined): ModelPrice | undefined {
  if (!model) return undefined;
  const id = model.toLowerCase();
  return MODEL_PRICES.find((price) => price.pattern.test(id));
}

/** 只有 input/output 拆分齐全时才估算；缺失返回 undefined（不拿 total 硬拆）。 */
export function estimateCostUsd(
  model: string | undefined,
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number },
): number | undefined {
  const price = priceFor(model);
  if (!price) return undefined;
  if (usage.inputTokens === undefined || usage.outputTokens === undefined) return undefined;
  if (usage.inputTokens <= 0 && usage.outputTokens <= 0) return undefined;
  const usd = (usage.inputTokens * price.inputPerM + usage.outputTokens * price.outputPerM) / 1_000_000;
  // 保留 6 位小数：单轮常见成本在 1e-5 量级，取整到分就全是 0。
  return Math.round(usd * 1_000_000) / 1_000_000;
}
