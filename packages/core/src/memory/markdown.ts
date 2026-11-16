/**
 * 记忆 Markdown 导出（只读投影）。
 *
 * 为什么要有它：memory.json 是机器格式（溯源、用法事件、合并轨迹都要结构化字段），
 * 但「人读、diff、放进 git 备份」这三件事 Markdown 更合适。这里只做「JSON → Markdown」
 * 的单向投影：不解析、不回写，避免两套格式互相打架。
 */
import type { MemoryFact } from "./fact.js";
import { DEFAULT_WORKSPACE_ID } from "./fact.js";

export interface MemoryMarkdownOptions {
  generatedAt?: number;
  title?: string;
}

/** 单行化：正文里的换行/制表符压成空格，保证一条记忆占一行（Markdown 列表项不能跨行）。 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function lineOf(fact: MemoryFact): string {
  const meta = [`重要度 ${fact.importance}`, `信任 ${fact.provenance?.trust ?? "user"}`];
  if (fact.provenance?.sessionId) meta.push(`会话 ${fact.provenance.sessionId.slice(0, 12)}`);
  if (fact.tags.length > 0) meta.push(`标签 ${fact.tags.join(",")}`);
  if (fact.invalidatedAt) meta.push(`已于 ${day(fact.invalidatedAt)} 失效`);
  if (fact.archivedAt) meta.push(`已于 ${day(fact.archivedAt)} 归档`);
  if (fact.links.length > 0) meta.push(`关联 ${fact.links.join(",")}`);
  meta.push(`id ${fact.id}`);
  return `- [${day(fact.timestamp)}] ${oneLine(fact.content)} — ${meta.join(" · ")}`;
}

/**
 * 渲染整库为 Markdown：工作区 → 分类 → 条目，归档条目单独一段放最后。
 * 排序固定（分类名 → 重要度 → 时间），同一份数据两次导出逐字节一致，便于 git diff。
 */
export function renderMemoryMarkdown(
  facts: readonly MemoryFact[],
  opts: MemoryMarkdownOptions = {},
): string {
  const generatedAt = opts.generatedAt ?? Date.now();
  const title = opts.title ?? "Loopsoar 记忆库";
  const active = facts.filter((f) => !f.archivedAt && f.status === "active");
  const archived = facts.filter((f) => f.archivedAt || f.status !== "active");
  const invalidated = facts.filter((f) => f.invalidatedAt);
  const workspaces = [...new Set(facts.map((f) => f.workspaceId ?? DEFAULT_WORKSPACE_ID))].sort();

  const out: string[] = [];
  out.push(`# ${title}`, "");
  out.push("> 由 Loopsoar 自动导出，仅供阅读与备份。写入仍以 memory.json 为准，直接编辑本文件不会生效。");
  out.push(
    `> 生成：${new Date(generatedAt).toISOString().replace("T", " ").slice(0, 19)} · 共 ${facts.length} 条（失效 ${invalidated.length} · 归档 ${archived.length}）`,
    "",
  );
  if (facts.length === 0) {
    out.push("（还没有记忆）", "");
    return out.join("\n");
  }

  for (const ws of workspaces) {
    out.push(`## ${ws}`, "");
    const inWs = active.filter((f) => (f.workspaceId ?? DEFAULT_WORKSPACE_ID) === ws);
    const categories = [...new Set(inWs.map((f) => f.category))].sort();
    for (const category of categories) {
      const items = inWs
        .filter((f) => f.category === category)
        .sort((a, b) => b.importance - a.importance || b.timestamp - a.timestamp || a.id.localeCompare(b.id));
      out.push(`### ${category} (${items.length})`, "");
      for (const fact of items) out.push(lineOf(fact));
      out.push("");
    }
    const archivedInWs = archived.filter((f) => (f.workspaceId ?? DEFAULT_WORKSPACE_ID) === ws);
    if (archivedInWs.length > 0) {
      out.push(`### 归档 (${archivedInWs.length})`, "");
      for (const fact of archivedInWs.sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))) {
        out.push(lineOf(fact));
      }
      out.push("");
    }
  }
  return out.join("\n");
}
