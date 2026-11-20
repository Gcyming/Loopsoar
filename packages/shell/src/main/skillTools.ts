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
    name: "skill_list",
    description:
      "列出本地技能（默认只看已启用；includeDisabled=true 可看候选草稿）。只返回元数据，不注入正文。",
    permissions: { read: true },
    schema: z.object({ includeDisabled: z.boolean().optional() }),
    execute: async (ctx): Promise<ToolResult> => {
      const params = ctx.params as { includeDisabled?: boolean };
      const items = skills
        .list()
        .filter((skill) => params.includeDisabled === true || skill.enabled)
        .map((skill) => `${skill.enabled ? "启用" : "禁用"} · ${skill.id} · ${skill.frontmatter.name}：${skill.frontmatter.description}`);
      return { ok: true, content: items.length > 0 ? items.join("\n") : "（没有匹配的技能）" };
    },
  });

  registry.register({
    name: "skill_read",
    description: "按 ID 读取本地技能正文（含 frontmatter），用于检查已有技能或候选草稿；只读，不启用/修改技能。",
    permissions: { read: true },
    schema: z.object({ id: z.string().min(1).max(120), maxChars: z.number().int().min(500).max(MAX_BODY_CHARS).optional() }),
    execute: async (ctx): Promise<ToolResult> => {
      const params = ctx.params as { id: string; maxChars?: number };
      const skill = skills.list().find((item) => item.id === params.id);
      if (!skill) return { ok: false, content: `[错误] 技能不存在：${params.id}` };
      const limit = params.maxChars ?? MAX_BODY_CHARS;
      const body = skill.body.length > limit ? `${skill.body.slice(0, limit)}\n…（已截断，全文 ${skill.body.length} 字符）` : skill.body;
      const allowed = skill.frontmatter.allowedTools?.length
        ? `\n工具白名单（技能声明）：${skill.frontmatter.allowedTools.join(", ")}`
        : "";
      const dir = skill.path.replace(/[\\/][^\\/]+$/, "");
      return {
        ok: true,
        content: `# ${skill.frontmatter.name}\n状态：${skill.enabled ? "启用" : "禁用"}\n描述：${skill.frontmatter.description}${allowed}\n目录：${dir}\n\n${body}`,
      };
    },
  });

  registry.register({
    name: "skill_candidate",
    description:
      "把一个可复用的工作流程沉淀为技能候选：写入 SKILL.md 草稿并默认禁用，需用户在设置·技能里审阅启用。传 replaceId 可修订未启用的已有候选；适合任务完成后由用户明确要求“把这个流程存成技能”。",
    permissions: { write: true },
    schema: z.object({
      replaceId: z.string().min(1).max(120).optional(),
      name: z.string().min(1).max(120),
      description: z.string().min(1).max(500),
      whenToUse: z.string().max(500).optional(),
      body: z.string().min(1).max(MAX_BODY_CHARS),
      tags: z.array(z.string().min(1).max(40)).max(20).optional(),
    }),
    execute: async (ctx): Promise<ToolResult> => {
      const params = ctx.params as {
        replaceId?: string;
        name: string;
        description: string;
        whenToUse?: string;
        body: string;
        tags?: string[];
      };
      try {
        const input = {
          name: params.name.trim(),
          description: params.description.trim(),
          whenToUse: params.whenToUse?.trim() || undefined,
          body: params.body,
          tags: params.tags?.map((tag) => tag.trim()).filter(Boolean),
        };
        const skill = params.replaceId
          ? skills.replaceCandidate(params.replaceId, input)
          : skills.createCandidate(input);
        if (!skill) return { ok: false, content: "[错误] 候选技能写入后未能被扫描到（已启用技能不允许改写）" };
        return {
          ok: true,
          content: `${params.replaceId ? "已修订候选技能" : "已生成候选技能"}：${skill.frontmatter.name}\nID：${skill.id}\n路径：${skill.path}\n状态：默认禁用\n\n到「设置 · 技能」审阅正文并启用后才会生效。`,
        };
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });

  registry.register({
    name: "skill_import",
    description:
      "从本机目录导入 Claude/Hermes 风格技能包（SKILL.md + scripts/references/assets）到技能库。只接受含 SKILL.md 的目录；不跟随符号链接；默认拒绝覆盖已有技能。写操作会触发权限确认。",
    permissions: { read: true, write: true },
    schema: z.object({
      path: z.string().min(1).max(4000),
      id: z.string().min(1).max(120).optional(),
      overwrite: z.boolean().optional(),
    }),
    execute: async (ctx): Promise<ToolResult> => {
      const params = ctx.params as { path: string; id?: string; overwrite?: boolean };
      const result = skills.importSkill(params.path, { id: params.id, overwrite: params.overwrite });
      if (!result.ok) return { ok: false, content: `[错误] ${result.error ?? "导入失败"}` };
      const skipped = result.skipped?.length ? `\n跳过（符号链接）：${result.skipped.join(", ")}` : "";
      const warnings = result.warnings?.length ? `\n解析提示：${result.warnings.join(" / ")}` : "";
      return {
        ok: true,
        content: `已导入技能：${result.id}\n目标：${result.target}\n文件：${result.files} 个 / ${result.bytes} 字节\n状态：已启用（用户显式安装）${warnings}${skipped}`,
      };
    },
  });
}
