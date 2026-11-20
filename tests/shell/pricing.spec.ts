import { describe, expect, it } from "vitest";
import { MODEL_PRICES, PRICING_NOTE, estimateCostUsd, priceFor } from "../../packages/shell/src/main/pricing.ts";

describe("定价与成本估算", () => {
  it("按模型匹配参考价（具体型号优先）", () => {
    expect(priceFor("gpt-4o-mini")?.label).toBe("gpt-4o-mini");
    expect(priceFor("gpt-4o-2024-08-06")?.label).toBe("gpt-4o");
    expect(priceFor("claude-sonnet-4-5")?.label).toBe("claude-sonnet");
    expect(priceFor("deepseek-reasoner")?.label).toBe("deepseek-reasoner");
    expect(priceFor("unknown-model")).toBeUndefined();
    expect(MODEL_PRICES.length).toBeGreaterThan(5);
  });

  it("输入/输出拆分齐全才估算，金额按 1M token 单价折算", () => {
    // gpt-4o：输入 2.5、输出 10（USD / 1M）
    expect(estimateCostUsd("gpt-4o", { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(2.5, 6);
    expect(estimateCostUsd("gpt-4o", { inputTokens: 0, outputTokens: 1_000_000 })).toBeCloseTo(10, 6);
    expect(estimateCostUsd("gpt-4o", { inputTokens: 1000, outputTokens: 500 })!).toBeCloseTo(0.0075, 6);
  });

  it("缺拆分 / 未知模型 / 零用量时不给数字（不拿 total 硬拆）", () => {
    expect(estimateCostUsd("gpt-4o", { totalTokens: 1234 })).toBeUndefined();
    expect(estimateCostUsd("gpt-4o", { inputTokens: 1000 })).toBeUndefined();
    expect(estimateCostUsd("mystery", { inputTokens: 1000, outputTokens: 1000 })).toBeUndefined();
    expect(estimateCostUsd(undefined, { inputTokens: 1, outputTokens: 1 })).toBeUndefined();
    expect(estimateCostUsd("gpt-4o", { inputTokens: 0, outputTokens: 0 })).toBeUndefined();
  });

  it("定价说明明确「参考价、非账单」", () => {
    expect(PRICING_NOTE).toContain("参考价");
    expect(PRICING_NOTE).toContain("非");
  });
});
