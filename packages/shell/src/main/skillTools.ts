/**
 * 技能候选工具（P1-7 第一步）：把一段可复用流程写成 SKILL.md 草稿。
 *
 * 安全边界：候选默认禁用，只写入 skills 目录，不注册工具、不改规则；
 * 用户在「设置 · 技能」审阅并启用后才会进入提示词注入。工具自身声明 write，
 * 因此首次调用会走沙箱确认，避免 Agent 静默写用户技能库。
 */
import { z } from "zod";
import type { ToolRegistry, ToolResult } from "loopsoar-core/tools/registry";
import type { SkillHost } from "./skills.js";

const MAX_BODY_CHARS = 20_000;

export function registerSkillTools(registry: ToolRegistry, skills: SkillHost): void {
  registry.register({
    name: "skill_candidate",
    description:
      "把一个可复用的工作流程沉淀为技能候选：写入 SKILL.md 草稿并默认禁用，需用户在设置·技能里审阅启用。适合任务完成后由用户明确要求“把这个流程存成技能”。",
    permissions: { write: true },
    schema: z.object({
      name: z.string().min(1).max(120),
      description: z.string().min(1).max(500),
      whenToUse: z.string().max(500).optional(),
      body: z.string().min(1).max(MAX_BODY_CHARS),
      tags: z.array(z.string().min(1).max(40)).max(20).optional(),
    }),
    execute: async (ctx): Promise<ToolResult> => {
      const params = ctx.params as {
        name: string;
        description: string;
        whenToUse?: string;
        body: string;
        tags?: string[];
      };
      try {
        const skill = skills.createCandidate({
          name: params.name.trim(),
          description: params.description.trim(),
          whenToUse: params.whenToUse?.trim() || undefined,
          body: params.body,
          tags: params.tags?.map((tag) => tag.trim()).filter(Boolean),
        });
        if (!skill) return { ok: false, content: "[错误] 候选技能写入后未能被扫描到" };
        return {
          ok: true,
          content: `已生成候选技能：${skill.frontmatter.name}\nID：${skill.id}\n路径：${skill.path}\n状态：默认禁用\n\n到「设置 · 技能」审阅正文并启用后才会生效。`,
        };
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });
}
