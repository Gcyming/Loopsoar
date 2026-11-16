/**
 * 记忆仓库（Obsidian 风格）：一条记忆 = 一个 Markdown 文件，元数据放 YAML frontmatter。
 *
 * 为什么这样存（ADR-0120）：
 *  - 文件是唯一真相：任何编辑器/Obsidian/git 都能读改，工具挂了数据仍在；
 *  - frontmatter 承载结构化字段，正文只放内容本身；
 *  - 链接用 [[id]] / [[id|标题]]，Obsidian 图谱、反链可直接消费；
 *  - 易变字段（accessCount / lastAccessed / confidence）不写进 md，避免"读一次就改文件"，
 *    由壳层 sidecar 持久化（见 memoryService），随时可丢弃重建。
 *
 * 本模块只做纯转换：不碰文件系统、不依赖 electron。
 */
import { dumpYaml, parseYamlLite } from "./yamlLite.js";
import { createFact, DEFAULT_WORKSPACE_ID, type MemoryFact, type MemoryTrust } from "./fact.js";

/** frontmatter 结构版本：将来字段变更靠它做迁移。 */
export const VAULT_SCHEMA_VERSION = 1;

export interface VaultParseResult {
  fact: MemoryFact;
  /** 解析中可恢复的问题（缺字段/类型不对），调用方决定是否告警。 */
  warnings: string[];
}

/** 文件名只允许安全字符：id 里的路径分隔符等统一替换（日志/兜底用）。 */
export function vaultFileName(id: string): string {
  const safe = id.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "");
  return `${safe || "memory"}.md`;
}

/** 把正文压成一段可读的文件名 slug（保留中文，去掉文件名非法字符）。 */
function slugOf(content: string): string {
  const cleaned = content
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/[，。！？、；：“”‘’（）【】《》,.!?;:'"()\[\]{}]/g, "");
  const cut = Array.from(cleaned).slice(0, 24).join("").trim();
  // Windows 不允许文件名以空格或点结尾
  return cut.replace(/[\s.]+$/g, "") || "memory";
}

/**
 * 人类可读的文件名：`2026-11-16-记忆原点代表-Loopsoar-本体.md`。
 * 只在「第一次落盘」时使用；之后沿用它（改名会让外部 markdown 链接失效）。
 * 链接仍写 [[id]]，靠 frontmatter 的 aliases 解析，因此改标题不会断链。
 */
export function memoryFileName(fact: MemoryFact): string {
  const day = new Date(fact.timestamp).toISOString().slice(0, 10);
  return `${day}-${slugOf(fact.content)}.md`;
}

/** 从文件名还原 id（仅当 frontmatter 缺 id 时兜底）。 */
export function idFromFileName(fileName: string): string {
  return fileName.replace(/\.md$/i, "");
}

function titleOf(content: string): string {
  const first = content.replace(/\s+/g, " ").trim();
  return first.length > 40 ? `${first.slice(0, 40)}…` : first;
}

function iso(ms: number | undefined): string | null {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 链接统一写成 [[id]] 或 [[id|标题]]：Obsidian 能解析，解析器也能还原成 id。 */
function linkTargets(links: readonly string[]): string[] {
  return links.map((id) => `[[${id}]]`);
}

/** 把一条记忆序列化为 Markdown（frontmatter + 正文）。 */
export function factToMarkdown(fact: MemoryFact): string {
  const fm: Record<string, unknown> = {
    schema: VAULT_SCHEMA_VERSION,
    id: fact.id,
    // 文件名会变，id 才是稳定锚点：Obsidian 里 [[m1]] 通过 alias 仍能解析到这条笔记
    aliases: [fact.id],
    title: titleOf(fact.content),
    category: fact.category,
    workspace: fact.workspaceId ?? DEFAULT_WORKSPACE_ID,
    importance: fact.importance,
    created: iso(fact.timestamp),
  };
  if (fact.tags.length > 0) fm.tags = [...fact.tags];
  if (fact.links.length > 0) fm.links = linkTargets(fact.links);
  if (fact.repeated > 0) fm.repeated = fact.repeated;
  if (fact.layer !== "working") fm.layer = fact.layer;
  if (fact.source) fm.source = fact.source;
  if (fact.status !== "active") fm.status = fact.status;
  if (fact.validFrom !== undefined) fm.valid_from = iso(fact.validFrom);
  if (fact.invalidatedAt !== undefined) fm.invalidated_at = iso(fact.invalidatedAt);
  if (fact.supersededBy) fm.superseded_by = fact.supersededBy;
  if (fact.supersedes?.length) fm.supersedes = [...fact.supersedes];
  if (fact.conflictsWith?.length) fm.conflicts_with = [...fact.conflictsWith];
  if (fact.archivedAt !== undefined) fm.archived_at = iso(fact.archivedAt);
  if (fact.mergeTrail.length > 0) {
    fm.merge_trail = fact.mergeTrail.map((entry) => ({ merged_at: iso(entry.mergedAt), reason: entry.reason }));
  }
  if (fact.agentId) fm.agent = fact.agentId;
  if (fact.crossAgentLinks?.length) fm.cross_agent_links = [...fact.crossAgentLinks];
  const provenance = fact.provenance;
  if (provenance) {
    const pm: Record<string, unknown> = {};
    if (provenance.trust) pm.trust = provenance.trust;
    if (provenance.sessionId) pm.session = provenance.sessionId;
    if (provenance.messageId) pm.message = provenance.messageId;
    if (provenance.toolCallId) pm.tool_call = provenance.toolCallId;
    if (provenance.url) pm.url = provenance.url;
    if (provenance.file) pm.file = provenance.file;
    if (provenance.capturedBy) pm.captured_by = provenance.capturedBy;
    if (Object.keys(pm).length > 0) fm.provenance = pm;
  }
  const yaml = dumpYaml(fm);
  return `---\n${yaml}\n---\n\n${fact.content.trim()}\n`;
}

/** 从 [[id|alias]] / [[id]] 里取回 id。 */
function linkId(raw: string): string {
  const match = /^\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]$/.exec(raw.trim());
  return (match ? match[1] : raw).trim();
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function asIsoMs(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return undefined;
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => asString(item) ?? "").filter(Boolean);
  const single = asString(value);
  return single ? [single] : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * 解析一条 vault 笔记。非法/缺正文返回 null（调用方跳过并记 warning）；
 * 缺 id 时用文件名兜底——保证手写文件也能进入库。
 */
export function markdownToFact(text: string, fileName: string): VaultParseResult | null {
  const warnings: string[] = [];
  const normalized = text.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) {
    warnings.push("缺少 frontmatter");
    return null;
  }
  const close = normalized.indexOf("\n---", 3);
  if (close < 0) {
    warnings.push("frontmatter 未闭合");
    return null;
  }
  const yamlText = normalized.slice(3, close);
  const body = normalized.slice(close + 4).replace(/^\s*\n/, "");
  let meta: unknown;
  try {
    meta = parseYamlLite(yamlText);
  } catch {
    warnings.push("frontmatter 不是合法 YAML");
    return null;
  }
  const record = asRecord(meta) ?? {};
  const id = asString(record.id) ?? idFromFileName(fileName);
  const content = body.trim();
  if (!content) {
    warnings.push("正文为空");
    return null;
  }
  const createdAt = asIsoMs(record.created) ?? Date.now();
  const provenance = asRecord(record.provenance);
  const trustRaw = asString(provenance?.trust);
  const trust: MemoryTrust | undefined =
    trustRaw === "user" || trustRaw === "agent" || trustRaw === "tool" || trustRaw === "web" ? trustRaw : undefined;

  const fact = createFact({
    id,
    content,
    category: asString(record.category) ?? "fact",
    tags: asStringList(record.tags),
    importance: asNumber(record.importance) ?? 5,
    timestamp: createdAt,
    lastAccessed: createdAt,
    links: asStringList(record.links).map(linkId),
    repeated: asNumber(record.repeated) ?? 0,
    layer: (asString(record.layer) as MemoryFact["layer"] | undefined) ?? "working",
    source: asString(record.source) ?? "vault",
    status: asString(record.status) ?? "active",
    archivedAt: asIsoMs(record.archived_at),
    mergeTrail: Array.isArray(record.merge_trail)
      ? record.merge_trail
          .map((entry) => asRecord(entry))
          .filter((entry): entry is Record<string, unknown> => Boolean(entry))
          .map((entry) => ({ mergedAt: asIsoMs(entry.merged_at) ?? createdAt, reason: asString(entry.reason) ?? "" }))
      : [],
    agentId: asString(record.agent),
    crossAgentLinks: asStringList(record.cross_agent_links),
    workspaceId: asString(record.workspace) ?? DEFAULT_WORKSPACE_ID,
    validFrom: asIsoMs(record.valid_from),
    invalidatedAt: asIsoMs(record.invalidated_at),
    supersededBy: asString(record.superseded_by),
    supersedes: asStringList(record.supersedes),
    conflictsWith: asStringList(record.conflicts_with),
    provenance: {
      ...(asString(provenance?.session) ? { sessionId: asString(provenance?.session) as string } : {}),
      ...(asString(provenance?.message) ? { messageId: asString(provenance?.message) as string } : {}),
      ...(asString(provenance?.tool_call) ? { toolCallId: asString(provenance?.tool_call) as string } : {}),
      ...(asString(record.workspace) ? { workspaceId: asString(record.workspace) as string } : {}),
      ...(asString(provenance?.url) ? { url: asString(provenance?.url) as string } : {}),
      ...(asString(provenance?.file) ? { file: asString(provenance?.file) as string } : {}),
      ...(trust ? { trust } : {}),
      ...(asString(provenance?.captured_by)
        ? { capturedBy: asString(provenance?.captured_by) as NonNullable<MemoryFact["provenance"]>["capturedBy"] }
        : {}),
    },
  });
  return { fact, warnings };
}

/** 索引笔记（vault/index.md）：给人看的目录，不参与解析（facts/ 与 archive/ 才是数据）。 */
export function renderVaultIndex(facts: readonly MemoryFact[], archived: readonly MemoryFact[], generatedAt = Date.now()): string {
  const active = facts.filter((f) => !f.archivedAt && f.status === "active");
  const byWorkspace = new Map<string, MemoryFact[]>();
  for (const fact of active) {
    const ws = fact.workspaceId ?? DEFAULT_WORKSPACE_ID;
    if (!byWorkspace.has(ws)) byWorkspace.set(ws, []);
    byWorkspace.get(ws)?.push(fact);
  }
  const lines = [
    "# Loopsoar 记忆索引",
    "",
    `> 自动生成，可直接在 Obsidian 里浏览；条目正文在 facts/ 与 archive/。生成：${day(generatedAt)}`,
    `> 活跃 ${active.length} 条 · 归档 ${archived.length} 条`,
    "",
  ];
  for (const [ws, items] of [...byWorkspace.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`## ${ws}`, "");
    for (const fact of items.sort((a, b) => b.importance - a.importance)) {
      lines.push(`- [[${fact.id}|${titleOf(fact.content)}]] · ${fact.category} · 重要度 ${fact.importance}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
