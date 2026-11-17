import { describe, expect, it } from "vitest";
import { extractCorrectionCandidates } from "../../packages/core/src/rules/learn.ts";

describe("纠正句 → 规则候选", () => {
  it("不对，应该用 pnpm → 弱候选", () => {
    const items = extractCorrectionCandidates("不对，应该用 pnpm 安装依赖。");
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe("用 pnpm 安装依赖");
    expect(items[0].strength).toBe("should");
    expect(items[0].tags).toContain("纠正");
  });

  it("带硬约束的纠正保留 hard", () => {
    const items = extractCorrectionCandidates("错了，不要用 npm。");
    expect(items[0].text).toBe("不要用 npm");
    expect(items[0].strength).toBe("hard");
  });

  it("问句/无纠正词不抽", () => {
    expect(extractCorrectionCandidates("用 pnpm 吗？")).toEqual([]);
    expect(extractCorrectionCandidates("用 pnpm 安装依赖")).toEqual([]);
  });
});
