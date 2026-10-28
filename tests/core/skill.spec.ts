/** 技能：frontmatter 解析 + 注册表 + 提示词注入（纯逻辑）。 */
import { describe, expect, it } from "vitest";
import { SkillRegistry, parseSkillMarkdown } from "../../packages/core/src/skill.ts";

const SAMPLE = `---
name: 代码评审
description: 按团队规范做 code review
whenToUse: 需要评审 diff 时
version: 0.1.0
tags: [review, style]
---

# 检查清单
- 命名是否清晰
- 是否有测试
`;

describe("技能解析与注册表", () => {
  it("解析 frontmatter（含数组）与正文", () => {
    const { frontmatter, body } = parseSkillMarkdown(SAMPLE);
    expect(frontmatter.name).toBe("代码评审");
    expect(frontmatter.tags).toEqual(["review", "style"]);
    expect(body).toContain("检查清单");
  });

  it("缺少 frontmatter 抛错", () => {
    expect(() => parseSkillMarkdown("# 没有元信息")).toThrow(/frontmatter/);
  });

  it("未命中只列清单；命中注入正文；禁用后不出现", () => {
    const reg = new SkillRegistry();
    reg.install("review", "C:/skills/review/SKILL.md", parseSkillMarkdown(SAMPLE).frontmatter, parseSkillMarkdown(SAMPLE).body);
    const listOnly = reg.promptFor("你好");
    expect(listOnly).toContain("可用技能");
    expect(listOnly).not.toContain("命名是否清晰");

    const hit = reg.promptFor("帮我做一次代码评审");
    expect(hit).toContain("检查清单");
    expect(hit).toContain("命名是否清晰");

    reg.setEnabled("review", false);
    expect(reg.promptFor("代码评审")).toBe("");
  });
});
