import { describe, expect, it } from "vitest";
import { analyzeRuleConflicts, type RuleSource } from "../../packages/core/src/rules/health.ts";

const src = (id: string, scope: "global" | "workspace", text: string): RuleSource => ({
  id, scope, name: scope === "global" ? "全局规则" : "AGENTS.md", text,
});

describe("规则体检：冲突/重复", () => {
  it("同一约束一正一反 → conflict", () => {
    const out = analyzeRuleConflicts([
      src("g", "global", "# 规则\n- 必须使用 pnpm"),
      src("w", "workspace", "# 项目规则\n- 不要使用 pnpm"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("conflict");
    expect(out[0].a.text).toContain("必须");
    expect(out[0].b.text).toContain("不要");
  });

  it("措辞不同但同向 → 不误报冲突", () => {
    const out = analyzeRuleConflicts([
      src("a", "workspace", "- 只能使用 pnpm"),
      src("b", "workspace", "- 必须使用 pnpm"),
    ]);
    expect(out).toEqual([]);
  });

  it("同一规则出现在两处 → duplicate", () => {
    const out = analyzeRuleConflicts([
      src("a", "global", "- 提交信息用中文"),
      src("b", "workspace", "- 提交信息用中文"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("duplicate");
  });

  it("标题、复选框、问句、假设不进体检", () => {
    const out = analyzeRuleConflicts([
      src("a", "workspace", "# 规则\n- [ ] 必须使用 pnpm\n- 为什么不要用 npm？\n- 如果失败就重试"),
    ]);
    expect(out).toEqual([]);
  });

  it("同一来源内的重复不重复报（避免单文件自我冲突）", () => {
    const out = analyzeRuleConflicts([
      src("a", "workspace", "- 提交信息用中文\n- 提交信息用中文"),
    ]);
    expect(out).toEqual([]);
  });
});
