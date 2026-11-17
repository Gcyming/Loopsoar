import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { SkillHost } from "../../packages/shell/src/main/skills.ts";
import { registerSkillTools } from "../../packages/shell/src/main/skillTools.ts";

describe("技能候选（P1-7）", () => {
  it("写入 SKILL.md 且默认禁用；启用后才进入提示词", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-skill-"));
    try {
      const host = new SkillHost(path.join(root, "skills"));
      const registry = new ToolRegistry();
      registerSkillTools(registry, host);
      const result = await registry.get("skill_candidate")!.execute({
        agentId: "test",
        sessionId: "s1",
        params: {
          name: "发布前检查",
          description: "发布前跑测试与构建",
          whenToUse: "准备发布时",
          body: "1. pnpm test\n2. pnpm build",
          tags: ["release"],
        },
        platform: {},
      });
      expect(result.ok).toBe(true);
      const skill = host.list().find((item) => item.frontmatter.name === "发布前检查")!;
      expect(skill).toBeTruthy();
      expect(skill.enabled).toBe(false);
      expect(fs.existsSync(skill.path)).toBe(true);
      expect(host.promptFor("发布前检查")).not.toContain("pnpm test");

      host.setEnabled(skill.id, true);
      expect(host.promptFor("发布前检查")).toContain("pnpm test");

      const read = await registry.get("skill_read")!.execute({
        agentId: "test",
        sessionId: "s1",
        params: { id: skill.id },
        platform: {},
      });
      expect(read.ok).toBe(true);
      expect(read.content).toContain("pnpm test");
      expect(read.content).toContain("状态：启用");

      const listed = await registry.get("skill_list")!.execute({
        agentId: "test",
        sessionId: "s1",
        params: {},
        platform: {},
      });
      expect(listed.content).toContain("发布前检查");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
