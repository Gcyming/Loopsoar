import { describe, expect, it } from "vitest";
import { extractRuleCandidates } from "../../packages/core/src/rules/learn.ts";

const texts = (message: string) => extractRuleCandidates(message).map((c) => c.text);

describe("规则候选抽取", () => {
  it("中文硬约束：只能 / 不要 分别成条", () => {
    const items = extractRuleCandidates("以后只能使用 pnpm 管理依赖，不要再用 npm。");
    expect(items.map((c) => c.text)).toEqual(["只能使用 pnpm 管理依赖", "不要再用 npm"]);
    expect(items.every((c) => c.strength === "hard")).toBe(true);
  });

  it("所有项目 → 全局作用域；单项目默认 workspace", () => {
    expect(extractRuleCandidates("所有项目都必须加中文注释。")[0].scopeHint).toBe("global");
    expect(extractRuleCandidates("这个项目必须用 pnpm。")[0].scopeHint).toBe("workspace");
  });

  it("问句、假设、纯建议不误判为硬规则", () => {
    expect(texts("能不能用 npm 安装？")).toEqual([]);
    expect(texts("如果失败就重试")).toEqual([]);
    const soft = extractRuleCandidates("建议用 pnpm 管理依赖。");
    expect(soft).toHaveLength(1);
    expect(soft[0].strength).toBe("should");
    expect(soft[0].confidence).toBeLessThan(0.7);
  });

  it("英文 must/never/only 能抽到", () => {
    const items = extractRuleCandidates("You must always run tests before commit. Never edit dist/.");
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items.every((c) => c.strength === "hard")).toBe(true);
  });

  it("同一条约束重复出现只保留一条，并取更高置信度", () => {
    const items = extractRuleCandidates("必须用 pnpm。以后都记住，必须用 pnpm。");
    expect(items.filter((c) => c.key.includes("pnpm"))).toHaveLength(1);
    expect(items.find((c) => c.key.includes("pnpm"))?.confidence).toBeGreaterThan(0.86);
  });

  it("代码块里的示例不会被当成规则", () => {
    expect(texts("看这个示例：\n\n\x60\x60\x60\n# 必须使用 npm\n\x60\x60\x60\n")).toEqual([]);
  });
});
