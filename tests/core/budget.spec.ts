/**
 * 预算四闸：硬上限封顶 + 归因文案 + 预警。
 */
import { describe, expect, it } from "vitest";
import { clampLimits, budgetReason, warnThreshold } from "../../packages/core/src/budget.ts";
import { BUDGET_HARD } from "../../packages/contracts/src/security-policy.ts";

describe("预算四闸", () => {
  it("自定义限制只能收紧（min 封顶），不能突破 BUDGET_HARD", () => {
    const clamped = clampLimits({
      maxRounds: 10_000,
      maxToolCalls: 999_999,
      maxTotalTokens: 999_999_999,
      maxWallClockMs: 999_999_999,
    });
    expect(clamped.maxRounds).toBe(BUDGET_HARD.maxRounds);
    expect(clamped.maxToolCalls).toBe(BUDGET_HARD.maxToolCalls);
    expect(clamped.maxTotalTokens).toBe(BUDGET_HARD.maxTotalTokens);
    expect(clamped.maxWallClockMs).toBe(BUDGET_HARD.maxWallClockMs);
  });

  it("轮次闸命中 → 归因文案", () => {
    const reason = budgetReason(
      { rounds: 10, toolCalls: 0, totalTokens: 0, wallClockMs: 0 },
      { maxRounds: 10 },
    );
    expect(reason).toContain("轮次闸");
    expect(reason).toContain("已收集信息");
  });

  it("工具调用闸命中 → 归因文案", () => {
    const reason = budgetReason(
      { rounds: 0, toolCalls: 5, totalTokens: 0, wallClockMs: 0 },
      { maxToolCalls: 5 },
    );
    expect(reason).toContain("工具调用闸");
  });

  it("Token 闸命中 → 归因文案", () => {
    const reason = budgetReason(
      { rounds: 0, toolCalls: 0, totalTokens: 100, wallClockMs: 0 },
      { maxTotalTokens: 100 },
    );
    expect(reason).toContain("Token 闸");
  });

  it("墙钟闸命中 → 归因文案", () => {
    const reason = budgetReason(
      { rounds: 0, toolCalls: 0, totalTokens: 0, wallClockMs: 5000 },
      { maxWallClockMs: 5000 },
    );
    expect(reason).toContain("墙钟");
  });

  it("未命中 → null", () => {
    expect(
      budgetReason({ rounds: 1, toolCalls: 0, totalTokens: 0, wallClockMs: 0 }, { maxRounds: 10 }),
    ).toBeNull();
  });

  it("预警文案非空且提到轮次上限", () => {
    const warn = warnThreshold({ maxRounds: 100 });
    expect(warn).toContain("3 轮");
  });
});
