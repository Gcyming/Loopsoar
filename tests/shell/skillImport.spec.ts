import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SkillHost } from "../../packages/shell/src/main/skills.ts";

let root = "";
let host: SkillHost;
let source = "";

function write(rel: string, content: string): void {
  const full = path.join(source, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

const SKILL = `---
name: 部署检查
description: 上线前核对清单
allowed-tools: [file_read, terminal]
---
# 部署检查

按步骤执行 references/checklist.md。
`;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-skill-import-"));
  host = new SkillHost(path.join(root, "skills"));
  source = path.join(root, "incoming", "deploy-check");
  fs.mkdirSync(source, { recursive: true });
});

afterEach(() => {
  host.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("技能资源包导入", () => {
  it("复制 SKILL.md 与脚本/参考文件，导入后立即启用并可被检索", () => {
    write("SKILL.md", SKILL);
    write("scripts/check.sh", "echo ok\n");
    write("references/checklist.md", "# checklist\n");
    write(".git/config", "should not copy");
    write("node_modules/x/index.js", "should not copy");

    const result = host.importSkill(source, { id: "deploy-check" });
    expect(result.ok).toBe(true);
    expect(result.id).toBe("deploy-check");
    expect(result.files).toBe(3);
    expect(fs.existsSync(path.join(result.target!, "scripts/check.sh"))).toBe(true);
    expect(fs.existsSync(path.join(result.target!, "references/checklist.md"))).toBe(true);
    expect(fs.existsSync(path.join(result.target!, ".git"))).toBe(false);
    expect(fs.existsSync(path.join(result.target!, "node_modules"))).toBe(false);

    const installed = host.list().find((skill) => skill.id === "deploy-check");
    expect(installed?.enabled).toBe(true);
    expect(installed?.frontmatter.allowedTools).toEqual(["file_read", "terminal"]);

    const prompt = host.promptFor("部署检查 上线前的清单");
    expect(prompt).toContain("部署检查");
    expect(prompt).toContain("目录：");
    expect(prompt).toContain("references/checklist.md");
  });

  it("空 SKILL.md 拒绝且不留半成品；缺 frontmatter 可导入但带警告", () => {
    const noSkill = host.importSkill(source, { id: "broken" });
    expect(noSkill.ok).toBe(false);
    expect(noSkill.error).toContain("SKILL.md");

    write("SKILL.md", "   \n");
    const empty = host.importSkill(source, { id: "empty" });
    expect(empty.ok).toBe(false);
    expect(empty.error).toContain("解析失败");
    expect(fs.existsSync(path.join(root, "skills", "empty"))).toBe(false);
    expect(fs.readdirSync(path.join(root, "skills")).filter((name) => name.startsWith(".import-"))).toEqual([]);

    write("SKILL.md", "没有 frontmatter 的正文，但描述可提取。");
    const loose = host.importSkill(source, { id: "loose" });
    expect(loose.ok).toBe(true);
    expect(loose.warnings?.join(" ")).toContain("缺少 frontmatter");
    expect(host.list().find((skill) => skill.id === "loose")?.enabled).toBe(true);
  });

  it("同名默认拒绝，overwrite 才替换（旧文件不残留）", () => {
    write("SKILL.md", SKILL);
    write("scripts/old.sh", "old\n");
    expect(host.importSkill(source, { id: "dup" }).ok).toBe(true);

    const second = host.importSkill(source, { id: "dup" });
    expect(second.ok).toBe(false);
    expect(second.error).toContain("已存在");

    fs.rmSync(path.join(source, "scripts"), { recursive: true, force: true });
    write("SKILL.md", SKILL.replace("部署检查", "部署检查 v2"));
    const replaced = host.importSkill(source, { id: "dup", overwrite: true });
    expect(replaced.ok).toBe(true);
    expect(fs.existsSync(path.join(root, "skills", "dup", "scripts", "old.sh"))).toBe(false);
    expect(host.list().find((skill) => skill.id === "dup")?.frontmatter.name).toBe("部署检查 v2");
  });

  it("非法 / 越界 id 被拒绝，源目录与技能库互相包含也拒绝", () => {
    write("SKILL.md", SKILL);
    expect(host.importSkill(source, { id: ".." }).ok).toBe(false);
    expect(host.importSkill(source, { id: "../escape" }).ok).toBe(false);
    expect(host.importSkill(source, { id: ".hidden" }).ok).toBe(false);

    const inside = path.join(root, "skills", "self");
    fs.mkdirSync(inside, { recursive: true });
    fs.writeFileSync(path.join(inside, "SKILL.md"), SKILL);
    expect(host.importSkill(inside).ok).toBe(false);
    expect(host.importSkill(root).ok).toBe(false);
  });

  it("文件数超限直接失败，不留目标目录", () => {
    write("SKILL.md", SKILL);
    for (let i = 0; i < 301; i += 1) write(`assets/${i}.txt`, "x");
    const result = host.importSkill(source, { id: "too-many" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("上限");
    expect(fs.existsSync(path.join(root, "skills", "too-many"))).toBe(false);
  });
});
