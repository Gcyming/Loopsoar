/** 技能：容错解析 + 命中打分 + 注入截断（纯逻辑）。 */
import { describe, expect, it } from "vitest";
import { SkillRegistry, parseSkillMarkdown } from "../../packages/core/src/skill.ts";

const FULL = `---
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

const NO_FRONTMATTER = `# 发布流程
打包 → 签名 → 上传。`;

describe("技能解析（容错）", () => {
  it("解析 frontmatter（含数组）与正文", () => {
    const parsed = parseSkillMarkdown(FULL, "review");
    expect(parsed.frontmatter.name).toBe("代码评审");
    expect(parsed.frontmatter.tags).toEqual(["review", "style"]);
    expect(parsed.body).toContain("检查清单");
    expect(parsed.warnings).toEqual([]);
  });

  it("缺少 frontmatter → 目录名兜底 + 正文提取描述（不再抛错）", () => {
    const parsed = parseSkillMarkdown(NO_FRONTMATTER, "release");
    expect(parsed.frontmatter.name).toBe("release");
    expect(parsed.frontmatter.description).toContain("发布流程");
    expect(parsed.body).toContain("打包");
    expect(parsed.warnings.length).toBeGreaterThan(0);
  });

  it("空文件才抛错", () => {
    expect(() => parseSkillMarkdown("   ", "x")).toThrow(/为空/);
  });

  it("兼容 allowed-tools：数组与逗号串两种写法", () => {
    const arrayForm = parseSkillMarkdown(
      `---\nname: a\ndescription: d\nallowed-tools: [file_read, terminal_run]\n---\n正文`,
      "a",
    );
    expect(arrayForm.frontmatter.allowedTools).toEqual(["file_read", "terminal_run"]);

    const stringForm = parseSkillMarkdown(
      `---\nname: b\ndescription: d\nallowedTools: "file_read, file_write"\n---\n正文`,
      "b",
    );
    expect(stringForm.frontmatter.allowedTools).toEqual(["file_read", "file_write"]);

    const none = parseSkillMarkdown(`---\nname: c\ndescription: d\n---\n正文`, "c");
    expect(none.frontmatter.allowedTools).toBeUndefined();
  });
});

describe("技能命中质量", () => {
  const build = (): SkillRegistry => {
    const reg = new SkillRegistry();
    reg.install("review", "C:/skills/review/SKILL.md", parseSkillMarkdown(FULL, "review"));
    reg.install(
      "release",
      "C:/skills/release/SKILL.md",
      parseSkillMarkdown(
        `---\nname: 发布流程\ndescription: 打包签名上传\ntags: [release]\n---\n\n# 步骤\n1. 构建\n2. 签名`,
        "release",
      ),
    );
    return reg;
  };

  it("名称命中权重最高；中文查询（2-gram）能命中", () => {
    const reg = build();
    expect(reg.score(reg.get("review")!, "代码评审")).toBeGreaterThanOrEqual(4);
    expect(reg.score(reg.get("release")!, "代码评审")).toBeLessThan(reg.score(reg.get("review")!, "代码评审"));
    expect(reg.search("帮我做一次代码评审")[0].record.id).toBe("review");
    expect(reg.search("发布")[0].record.id).toBe("release");
  });

  it("未命中只列清单；命中注入正文", () => {
    const reg = build();
    const listOnly = reg.promptFor("今天天气怎么样");
    expect(listOnly).toContain("可用技能");
    expect(listOnly).not.toContain("命名是否清晰");

    const hit = reg.promptFor("评审一下这段代码");
    expect(hit).toContain("已加载技能");
    expect(hit).toContain("命名是否清晰");
  });

  it("超长正文被截断（SKILL_BODY_LIMIT）", () => {
    const reg = new SkillRegistry();
    const long = `---\nname: 大技能\ndescription: 很长的技能\n---\n\n${"内容".repeat(10000)}`;
    reg.install("big", "C:/skills/big/SKILL.md", parseSkillMarkdown(long, "big"));
    expect(reg.promptFor("大技能")).toContain("正文已截断");
  });

  it("禁用后不参与命中与清单", () => {
    const reg = build();
    reg.setEnabled("review", false);
    expect(reg.promptFor("代码评审")).not.toContain("代码评审");
    expect(reg.promptFor("今天天气怎么样")).not.toContain("代码评审");
  });

  it("allowedToolsFor：命中技能的工具声明取并集，未声明返回 undefined", () => {
    const reg = new SkillRegistry();
    reg.install(
      "safe",
      "C:/skills/safe/SKILL.md",
      parseSkillMarkdown(`---\nname: 安全评审\ndescription: 审代码\nallowed-tools: [file_read, terminal_run]\n---\n正文`, "safe"),
    );
    expect(reg.allowedToolsFor("安全评审")).toEqual(["file_read", "terminal_run"]);
    expect(reg.allowedToolsFor("今天天气怎么样")).toBeUndefined();

    reg.install(
      "other",
      "C:/skills/other/SKILL.md",
      parseSkillMarkdown(`---\nname: 安全评审助手\ndescription: 审代码\nallowedTools: file_write\n---\n正文`, "other"),
    );
    expect(reg.allowedToolsFor("安全评审")!.sort()).toEqual(["file_read", "file_write", "terminal_run"]);
  });
});
