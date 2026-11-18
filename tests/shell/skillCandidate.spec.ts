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

  it("候选可修订/删除；已启用技能拒绝改写或删除", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-skill-lifecycle-"));
    try {
      const host = new SkillHost(path.join(root, "skills"));
      const registry = new ToolRegistry();
      registerSkillTools(registry, host);
      const created = await registry.get("skill_candidate")!.execute({
        agentId: "test",
        sessionId: "s1",
        params: { name: "候选生命周期", description: "旧描述", body: "旧正文" },
        platform: {},
      });
      expect(created.ok).toBe(true);
      const skill = host.list()[0];
      const revised = await registry.get("skill_candidate")!.execute({
        agentId: "test",
        sessionId: "s1",
        params: { replaceId: skill.id, name: "候选生命周期", description: "新描述", body: "新正文" },
        platform: {},
      });
      expect(revised.ok).toBe(true);
      expect(revised.content).toContain("已修订候选技能");
      expect(host.list()).toHaveLength(1);
      expect(host.list()[0].body).toContain("新正文");
      expect(host.remove(skill.id)).toBe(true);
      expect(host.list()).toHaveLength(0);

      const enabled = host.createCandidate({ name: "已启用", description: "x", body: "x" })!;
      host.setEnabled(enabled.id, true);
      expect(host.replaceCandidate(enabled.id, { name: "已启用", description: "y", body: "y" })).toBeNull();
      expect(host.remove(enabled.id)).toBe(false);
      expect(host.list().find((item) => item.id === enabled.id)?.enabled).toBe(true);

      const ordinary = path.join(host.dirPath(), "ordinary");
      fs.mkdirSync(ordinary, { recursive: true });
      fs.writeFileSync(path.join(ordinary, "SKILL.md"), "---\nname: 普通技能\ndescription: 不是候选\n---\n正文\n");
      host.scan();
      expect(host.remove("ordinary")).toBe(false);
      expect(host.replaceCandidate("ordinary", { name: "普通技能", description: "y", body: "y" })).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
