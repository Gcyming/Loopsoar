/**
 * 技能（Skill）模型 —— 与「扩展」「MCP」严格隔离的独立子系统。
 *
 * 技能 = 一份 SKILL.md（frontmatter + 正文），只影响「提示词注入」：
 *   - 与扩展的区别：扩展是可执行插件（清单 + 入口），技能是纯文本知识/流程沉淀；
 *   - 与 MCP 的区别：MCP 提供远程/子进程工具（JSON-RPC），技能不提供任何工具。
 *
 * 目录：<dataDir>/skills/<skill-id>/SKILL.md
 * frontmatter（--- 包裹，key: value）：
 *   name: 代码评审
 *   description: 按团队规范做 code review
 *   whenToUse: 需要评审 diff / 检查代码风格时
 *   version: 0.1.0
 *   tags: [review, style]
 * 正文：完整流程/检查清单（命中时注入给模型）。
 */
import { z } from "zod";

export const SKILL_FILE_NAME = "SKILL.md";
export const SKILL_MAX_BYTES = 32768;

export const SkillFrontmatterSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(500),
  whenToUse: z.string().max(500).optional(),
  version: z.string().max(40).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
});

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

export interface SkillRecord {
  id: string;
  path: string;
  frontmatter: SkillFrontmatter;
  /** 正文（frontmatter 之后）。 */
  body: string;
  bytes: number;
  enabled: boolean;
}

/** 极简 frontmatter 解析：不做完整 YAML，只支持 key: value / [a, b] / 多行 - item。 */
export function parseSkillMarkdown(raw: string): { frontmatter: SkillFrontmatter; body: string } {
  const text = raw.replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) throw new Error("缺少 frontmatter（--- 包裹的元信息）");
  const metaLines = match[1].split(/\r?\n/);
  const meta: Record<string, unknown> = {};
  let pendingKey: string | null = null;
  let pendingList: string[] = [];
  const flushList = (): void => {
    if (pendingKey) {
      meta[pendingKey] = pendingList;
      pendingKey = null;
      pendingList = [];
    }
  };
  for (const line of metaLines) {
    if (!line.trim()) continue;
    const listItem = /^\s*-\s+(.+)$/.exec(line);
    if (listItem && pendingKey) {
      pendingList.push(listItem[1].trim().replace(/^["']|["']$/g, ""));
      continue;
    }
    flushList();
    const kv = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2].trim();
    if (value === "") {
      pendingKey = key;
      continue;
    }
    if (value.startsWith("[") && value.endsWith("]")) {
      meta[key] = value
        .slice(1, -1)
        .split(",")
        .map((x) => x.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      meta[key] = value.replace(/^["']|["']$/g, "");
    }
  }
  flushList();
  return {
    frontmatter: SkillFrontmatterSchema.parse(meta),
    body: text.slice(match[0].length).trim(),
  };
}

export interface SkillRegistryDeps {
  /** 关键字命中阈值：用户消息包含 name/tags/whenToUse 的多少即视为命中。 */
  maxAlwaysListed?: number;
}

export class SkillRegistry {
  private items = new Map<string, SkillRecord>();

  constructor(private opts: SkillRegistryDeps = {}) {}

  static parseMarkdown(raw: string): { frontmatter: SkillFrontmatter; body: string } {
    return parseSkillMarkdown(raw);
  }

  install(id: string, path: string, frontmatter: SkillFrontmatter, body: string, enabled = true): SkillRecord {
    const record: SkillRecord = {
      id,
      path,
      frontmatter,
      body,
      bytes: new TextEncoder().encode(body).length,
      enabled,
    };
    this.items.set(id, record);
    return record;
  }

  list(): SkillRecord[] {
    return [...this.items.values()].sort((a, b) => a.frontmatter.name.localeCompare(b.frontmatter.name));
  }

  get(id: string): SkillRecord | undefined {
    return this.items.get(id);
  }

  setEnabled(id: string, enabled: boolean): SkillRecord | undefined {
    const item = this.items.get(id);
    if (!item) return undefined;
    item.enabled = enabled;
    return item;
  }

  enabled(): SkillRecord[] {
    return this.list().filter((s) => s.enabled);
  }

  clear(): void {
    this.items.clear();
  }

  /** 判断技能是否与用户消息相关（名称/标签/何时使用 任一命中）。 */
  matches(record: SkillRecord, userText: string): boolean {
    const text = userText.toLowerCase();
    const keys = [record.frontmatter.name, record.frontmatter.whenToUse ?? "", ...(record.frontmatter.tags ?? [])];
    return keys.some((k) => k && text.includes(String(k).toLowerCase()));
  }

  /**
   * 生成注入文本：
   *  - 默认只给「已启用技能的名称+描述」清单（token 友好）；
   *  - 与用户消息命中的技能注入完整正文；
   *  - 总量上限 maxAlwaysListed 个清单项。
   */
  promptFor(userText: string): string {
    const enabled = this.enabled();
    if (enabled.length === 0) return "";
    const matched = enabled.filter((s) => s.body && this.matches(s, userText));
    const listed = enabled.slice(0, this.opts.maxAlwaysListed ?? 20);
    if (matched.length === 0) {
      return ["## 可用技能（按需参考，未展开）", ...listed.map((s) => `- ${s.frontmatter.name}：${s.frontmatter.description}`)].join("\n");
    }
    const blocks = matched.map((s) => [`### 技能：${s.frontmatter.name}`, s.frontmatter.description, s.body].join("\n"));
    return ["## 已加载技能（与当前请求相关）", ...blocks].join("\n\n");
  }
}
