/**
 * 规则文件（AGENTS.md）合并逻辑：顺序 / 上限 / 跳过原因 / 护栏声明。
 * 依据：OpenCode Rules（项目根逐级向上 + 全局规则 + CLAUDE.md 兼容回退）。
 */
import { describe, expect, it } from "vitest";
import {
  mergeRules,
  validateRuleContent,
  rulesForPrompt,
  RULES_MAX_FILE_BYTES,
  RULES_MAX_TOTAL_BYTES,
  RULES_GUARDRAIL,
  type RuleSource,
} from "../../packages/core/src/rules.ts";

function source(partial: Partial<RuleSource> & { scope: RuleSource["scope"]; path: string }): RuleSource {
  return { enabled: true, content: "", ...partial };
}

describe("规则内容校验", () => {
  it("超大文件拒绝（32KB 上限）", () => {
    const big = "a".repeat(RULES_MAX_FILE_BYTES + 1);
    expect(validateRuleContent(big).join()).toMatch(/内容过大/);
    expect(validateRuleContent("a".repeat(100))).toEqual([]);
  });

  it("包含 NUL 字节拒绝（疑似二进制）", () => {
    expect(validateRuleContent("abc\u0000def").join()).toMatch(/NUL/);
  });
});

describe("规则合并", () => {
  it("顺序：全局 → 项目（后者更贴近当前任务）", () => {
    const merged = mergeRules([
      source({ scope: "workspace", path: "/ws/AGENTS.md", content: "项目规则内容" }),
      source({ scope: "global", path: "/data/rules/AGENTS.md", content: "全局规则内容" }),
    ]);
    expect(merged.included.map((i) => i.scope)).toEqual(["global", "workspace"]);
    const globalIndex = merged.text.indexOf("全局规则内容");
    const workspaceIndex = merged.text.indexOf("项目规则内容");
    expect(globalIndex).toBeGreaterThan(-1);
    expect(workspaceIndex).toBeGreaterThan(globalIndex);
  });

  it("禁用/空内容跳过并记录原因", () => {
    const merged = mergeRules([
      source({ scope: "global", path: "/g.md", enabled: false, content: "x" }),
      source({ scope: "workspace", path: "/w.md", content: "   " }),
    ]);
    expect(merged.text).toBe("");
    expect(merged.skipped.map((s) => s.reason)).toEqual(["已停用", "内容为空"]);
  });

  it("总量超限时后续文件不再注入（不截断半截规则）", () => {
    const chunk = "b".repeat(RULES_MAX_FILE_BYTES);
    const merged = mergeRules([
      source({ scope: "global", path: "/g.md", content: chunk }),
      source({ scope: "workspace", path: "/w.md", content: chunk }),
      source({ scope: "workspace", path: "/w2.md", content: chunk }),
    ]);
    expect(merged.included.length).toBe(2); // 32 + 32 = 64KB，第三份超限
    expect(merged.skipped[0].reason).toMatch(/总量上限/);
    expect(merged.totalBytes).toBeLessThanOrEqual(RULES_MAX_TOTAL_BYTES);
  });

  it("空规则 → 提示词为空串（不注入多余内容）", () => {
    const merged = mergeRules([]);
    expect(rulesForPrompt(merged)).toBe("");
  });

  it("有规则时带护栏声明（规则不得覆盖身份铁律/安全策略）", () => {
    const merged = mergeRules([source({ scope: "workspace", path: "/w.md", content: "用中文回答" })]);
    const prompt = rulesForPrompt(merged);
    expect(prompt).toContain(RULES_GUARDRAIL);
    expect(prompt).toContain("用中文回答");
    expect(prompt).toContain("## 规则文件");
  });
});
