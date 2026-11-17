import { describe, expect, it } from "vitest";
import { buildRuleReviewPrompt, parseRuleReviewResponse } from "../../packages/shell/src/main/ruleReview.ts";

describe("AI 规则回顾", () => {
  it("解析 JSON 并去重/截断", () => {
    const out = parseRuleReviewResponse('{"rules":[{"text":"只能使用 pnpm。","quote":"不对，应该用 pnpm"},{"text":"只能使用 pnpm","quote":"重复"}]}');
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("只能使用 pnpm");
    expect(out[0].quote).toContain("应该用");
  });

  it("代码块/废话能容忍，非法输出返回空", () => {
    expect(parseRuleReviewResponse('说明\n{"rules":[{"text":"不要修改 dist/ 下的文件"}]}\n结束')).toHaveLength(1);
    expect(parseRuleReviewResponse("不是 JSON")).toEqual([]);
    expect(parseRuleReviewResponse('{"rules":[{"text":"x"}]}')).toEqual([]);
  });

  it("prompt 带角色与会话内容", () => {
    const prompt = buildRuleReviewPrompt([{ role: "user", text: "应该用 pnpm" }]);
    expect(prompt).toContain("user：应该用 pnpm");
    expect(prompt).toContain('"rules"');
  });
});
