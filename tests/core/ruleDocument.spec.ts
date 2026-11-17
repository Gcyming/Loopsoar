import { describe, expect, it } from "vitest";
import { parseRuleDocument, ruleDocumentBody, ruleDocumentKey, rulePolarity } from "../../packages/core/src/rules/document.ts";

describe("规则文档解析", () => {
  it("去 bullet、跳过标题/复选框/问句/假设/代码围栏", () => {
    const lines = parseRuleDocument("# 规则\n- [ ] 已完成\n- 必须使用 pnpm\n- 为什么不要用 npm？\n- 如果失败就重试\n\x60\x60\x60\n必须 A\n\x60\x60\x60");
    expect(lines.map((line) => line.text)).toEqual(["必须使用 pnpm"]);
  });

  it("key 去情态词/标点，body 只去标点", () => {
    expect(ruleDocumentKey("必须使用 pnpm。")).toBe(ruleDocumentKey("只能使用 pnpm"));
    expect(ruleDocumentBody("必须使用 pnpm。")).not.toBe(ruleDocumentBody("只能使用 pnpm"));
  });

  it("极性：正向/禁止/中性", () => {
    expect(rulePolarity("必须使用 pnpm")).toBe("positive");
    expect(rulePolarity("不要使用 npm")).toBe("negative");
    expect(rulePolarity("提交信息用中文")).toBe("neutral");
  });

  it("maxLength 过滤超长行", () => {
    expect(parseRuleDocument("必须 " + "x".repeat(200), { maxLength: 160 })).toHaveLength(0);
  });
});
