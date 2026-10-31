/**
 * 技能（Skill）模型 —— 与「扩展」「MCP」严格隔离的独立子系统。
 *
 * 技能 = 一份 SKILL.md（frontmatter 可选 + 正文），只影响「提示词注入」：
 *   - 与扩展的区别：扩展是可执行插件（清单 + 入口），技能是纯文本知识/流程沉淀；
 *   - 与 MCP 的区别：MCP 提供远程/子进程工具（JSON-RPC），技能不提供任何工具。
 *
 * 稳定性与命中质量（吸取 slime skill_engine 的经验）：
 *   - frontmatter 缺失/损坏 **不整库失败**：按目录名兜底 + 从正文提取描述；
 *   - 命中不靠"包含即命中"：名称精确 > 名称包含 > tags/whenToUse > description；
 *   - 中文按 2-gram 匹配；正文注入截断；清单只给摘要。
 */
import { z } from "zod";

export const SKILL_FILE_NAME = "SKILL.md";
/**
 * 单技能读取上限（2MB）。注意：这不是"超过就跳过"的限制——
 * 超过时只读取前 2MB 并标记 warnings，技能仍然可用（用户明确要求不要因大小被拒）。
 */
export const SKILL_MAX_BYTES = 2 * 1024 * 1024;
/** 命中后注入正文的最大字符数（防止单个超长技能灌爆上下文；未注入部分提示用 file_read 读原文件）。 */
export const SKILL_BODY_LIMIT = 12000;
/** 清单项描述截断长度。 */
export const SKILL_DESCRIPTION_LIMIT = 120;
/** 命中注入的最大技能数。 */
export const SKILL_MAX_MATCHES = 3;

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
  /** 容错过程中的非致命问题（frontmatter 缺失等）。 */
  warnings?: string[];
}

export interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  body: string;
  /** 容错过程中发现的问题（不致命）。 */
  warnings: string[];
}

/** 从正文提取描述（借鉴 slime：优先 `## 功能`，其次首个标题/首段；去 Markdown；截断）。 */
export function extractSkillDescription(body: string): string {
  const cleaned = body.replace(/^\uFEFF/, "");
  const section = /^##\s*功能\s*\n+([\s\S]*?)(?=\n##|\Z)/m.exec(cleaned);
  const raw = section
    ? section[1]
    : (() => {
        const heading = /^#\s+(.+?)(?:\n|$)/m.exec(cleaned);
        if (heading) return heading[1];
        const para = cleaned.split(/\n\s*\n/).find((p) => p.trim());
        return para ?? cleaned;
      })();
  const stripped = raw
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/`(.*?)`/g, "$1")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return (stripped || "未提供描述").slice(0, SKILL_DESCRIPTION_LIMIT);
}

/**
 * 解析 SKILL.md：frontmatter 可选；缺失或字段不全时兜底并记录 warnings（不抛错）。
 * 只有「整个文件无法读取/为空」才算失败。
 */
export function parseSkillMarkdown(raw: string, fallbackName = "skill"): ParsedSkill {
  const warnings: string[] = [];
  const text = raw.replace(/^\uFEFF/, "");
  if (!text.trim()) throw new Error("SKILL.md 为空");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const body = (match ? text.slice(match[0].length) : text).trim();
  let meta: Record<string, unknown> = {};
  if (match) {
    try {
      meta = parseFrontmatter(match[1]);
    } catch (err) {
      warnings.push(`frontmatter 解析失败（已忽略）：${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    warnings.push("缺少 frontmatter（已按目录名与正文提取描述）");
  }

  const name = typeof meta.name === "string" && meta.name.trim() ? String(meta.name).trim() : fallbackName;
  if (!meta.name) warnings.push("缺少 name（已使用目录名）");
  const description =
    typeof meta.description === "string" && meta.description.trim()
      ? String(meta.description).trim()
      : extractSkillDescription(body);
  if (!meta.description) warnings.push("缺少 description（已从正文提取）");

  const frontmatter: SkillFrontmatter = {
    name: name.slice(0, 120),
    description: description.slice(0, 500),
    whenToUse: typeof meta.whenToUse === "string" ? meta.whenToUse.slice(0, 500) : undefined,
    version: typeof meta.version === "string" ? meta.version.slice(0, 40) : undefined,
    tags: Array.isArray(meta.tags)
      ? (meta.tags as unknown[]).map((t) => String(t).slice(0, 40)).slice(0, 20)
      : undefined,
  };
  return { frontmatter, body, warnings };
}

/** 极简 frontmatter：key: value / [a, b] / 多行 - item。 */
function parseFrontmatter(block: string): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  let pendingKey: string | null = null;
  let pendingList: string[] = [];
  const flush = (): void => {
    if (pendingKey) {
      meta[pendingKey] = pendingList;
      pendingKey = null;
      pendingList = [];
    }
  };
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const listItem = /^\s*-\s+(.+)$/.exec(line);
    if (listItem && pendingKey) {
      pendingList.push(listItem[1].trim().replace(/^["']|["']$/g, ""));
      continue;
    }
    flush();
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
  flush();
  return meta;
}

/** 中文 2-gram + 英文单词，用于命中打分。 */
export function queryTokens(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens = new Set<string>();
  for (const word of lower.match(/[a-z0-9][a-z0-9._-]{1,}/g) ?? []) tokens.add(word);
  for (const run of lower.match(/[\u4e00-\u9fa5]{2,}/g) ?? []) {
    for (let i = 0; i < run.length - 1; i += 1) tokens.add(run.slice(i, i + 2));
  }
  return [...tokens];
}

export class SkillRegistry {
  private items = new Map<string, SkillRecord>();

  static parseMarkdown(raw: string, fallbackName = "skill"): ParsedSkill {
    return parseSkillMarkdown(raw, fallbackName);
  }

  install(id: string, path: string, parsed: ParsedSkill | SkillFrontmatter, body?: string, enabled = true): SkillRecord {
    const frontmatter = "frontmatter" in parsed ? parsed.frontmatter : parsed;
    const record: SkillRecord = {
      id,
      path,
      frontmatter,
      body: body ?? ("body" in parsed ? parsed.body : ""),
      bytes: new TextEncoder().encode(("body" in parsed ? parsed.body : body) ?? "").length,
      enabled,
      warnings: "warnings" in parsed ? parsed.warnings : [],
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

  /** 命中打分：名称精确 5 / 名称包含 4 / 名称 token 3 / tags & whenToUse 2 / description 1。 */
  score(record: SkillRecord, userText: string): number {
    const text = userText.toLowerCase();
    if (!text.trim()) return 0;
    const fm = record.frontmatter;
    const name = fm.name.toLowerCase();
    let score = 0;
    if (name === text.trim()) score += 5;
    else if (text.includes(name)) score += 4;
    const tokens = queryTokens(userText);
    if (tokens.some((t) => name.includes(t))) score += 3;
    const tagHit = (fm.tags ?? []).some((tag) => {
      const t = tag.toLowerCase();
      return text.includes(t) || tokens.some((tok) => t.includes(tok));
    });
    if (tagHit) score += 2;
    if (fm.whenToUse && tokens.some((t) => fm.whenToUse!.toLowerCase().includes(t))) score += 2;
    if (tokens.some((t) => fm.description.toLowerCase().includes(t))) score += 1;
    return score;
  }

  /** 关键词检索（按分数倒序，空查询返回全部截断）。 */
  search(query: string, limit = 10): { record: SkillRecord; score: number }[] {
    const enabled = this.enabled();
    if (!query.trim()) return enabled.slice(0, limit).map((record) => ({ record, score: 0 }));
    return enabled
      .map((record) => ({ record, score: this.score(record, query) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.record.frontmatter.name.localeCompare(b.record.frontmatter.name))
      .slice(0, limit);
  }

  /**
   * 注入文本：
   *  - 命中：Top-N 技能正文（截断 SKILL_BODY_LIMIT）；
   *  - 未命中：只给已启用技能清单（名称+描述，截断）。
   */
  promptFor(userText: string): string {
    const enabled = this.enabled();
    if (enabled.length === 0) return "";
    const hits = this.search(userText, SKILL_MAX_MATCHES).filter((x) => x.score > 0);
    if (hits.length === 0) {
      const lines = enabled
        .slice(0, 20)
        .map((s) => `- ${s.frontmatter.name}：${s.frontmatter.description.slice(0, SKILL_DESCRIPTION_LIMIT)}`);
      return ["## 可用技能（按需参考，未展开）", ...lines].join("\n");
    }
    const blocks = hits.map(({ record }) => {
      const body =
        record.body.length > SKILL_BODY_LIMIT
          ? `${record.body.slice(0, SKILL_BODY_LIMIT)}\n…（正文已截断；完整内容可用 file_read 读取：${record.path}）`
          : record.body;
      return [`### 技能：${record.frontmatter.name}`, record.frontmatter.description, body].filter(Boolean).join("\n");
    });
    return ["## 已加载技能（与当前请求相关）", ...blocks].join("\n\n");
  }
}
