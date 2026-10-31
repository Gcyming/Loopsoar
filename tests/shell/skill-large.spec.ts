/**
 * 大技能不再被跳过：超过旧 32KB 上限的 SKILL.md 仍然安装、可启用、可注入（截断提示）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SKILL_MAX_BYTES } from "../../packages/core/src/skill.ts";
import { SkillHost } from "../../packages/shell/src/main/skills.ts";

function makeSkillDir(content: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-skill-large-"));
  const dir = path.join(root, "skills", "big-skill");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), content, "utf8");
  return root;
}

describe("技能大小限制", () => {
  it("超过旧 32KB 上限的技能仍会被安装（不再出现在 skipped 里）", () => {
    const body = "## 功能\n这是一个很大的技能，用于验证不再因大小被跳过。\n\n" + "细节说明。\n".repeat(8000);
    const root = makeSkillDir(body);
    try {
      expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(32768);
      const host = new SkillHost(path.join(root, "skills"));
      const result = host.scan();
      expect(result.installed).toBe(1);
      expect(result.skipped.some((s) => s.reason.includes("超过"))).toBe(false);
      const skill = host.list()[0];
      expect(skill.id).toBe("big-skill");
      expect(skill.body.length).toBeGreaterThan(30000);
      const prompt = host.promptFor("大技能");
      expect(prompt).toContain("big-skill");
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 20000);

  it("超过 2MB 的技能：读取前 2MB 并给出 warnings，仍然安装", () => {
    const body = "## 功能\n超大技能。\n\n" + "填充".repeat(Math.ceil(SKILL_MAX_BYTES / 2) + 1000);
    const root = makeSkillDir(body);
    try {
      expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(SKILL_MAX_BYTES);
      const host = new SkillHost(path.join(root, "skills"));
      const result = host.scan();
      expect(result.installed).toBe(1);
      const skill = host.list()[0];
      expect(skill.warnings?.some((w) => w.includes("过大"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30000);
});
