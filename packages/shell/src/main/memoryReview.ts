/**
 * 记忆回顾命名（LLM）：像人隔一段时间翻笔记，给内容起更准确的短标题。
 *
 * 边界（刻意的）：只产出标题——不改正文、不合并、不删除、不重命名文件。
 * 应用由 MemoryService.applyTitles 负责；模型失败/输出不合法一律返回 null（规则标题兜底）。
 */
import type { LlmClient } from "loopsoar-core/llm";
import type { MemoryFact } from "loopsoar-core/memory";

export interface TitleSuggestion {
  id: string;
  title: string;
  /** 原正文（供 UI 预览对照，不写回）。 */
  content: string;
}

export interface MergeSuggestion {
  ids: string[];
  reason: string;
}

export interface ReviewResult {
  titles: TitleSuggestion[];
  merges: MergeSuggestion[];
}

function shorten(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** 构造回顾提示词：每条候选带 id 与截断正文，要求模型只回 JSON。 */
export function buildReviewPrompt(facts: readonly MemoryFact[]): string {
  const lines = facts.map(
    (fact, index) => `${index + 1}. id=${fact.id} | 分类=${fact.category} | ${shorten(fact.content, 180)}`,
  );
  return [
    "你是 Loopsoar 的记忆整理员。下面是用户长期记忆的候选条目。",
    "请为每条生成一个更准确的短标题：中文不超过 16 个字，英文不超过 8 个词。",
    "要求：不添加原文没有的信息；不使用引号、换行或标点结尾；保持原语言。",
    '输出 JSON 对象，格式：{"titles":[{"id":"m1","title":"pnpm 依赖管理约定"}],"merges":[{"ids":["m1","m2"],"reason":"同一约定"}]}。',
    "merges 只放你确信是同一事实的 2-3 条；没有就给空数组。不要解释、不要代码块。",
    "",
    ...lines,
  ].join("\n");
}

/** 从模型输出里提取 JSON 数组并校验（容忍代码块围栏/前后废话）。 */
export function parseReviewResponse(text: string, validIds: ReadonlySet<string>): TitleSuggestion[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: TitleSuggestion[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as { id?: unknown; title?: unknown };
    if (typeof record.id !== "string" || typeof record.title !== "string") continue;
    const id = record.id.trim();
    const title = record.title.replace(/\s+/g, " ").trim().replace(/[。.!?！？]+$/g, "");
    if (!validIds.has(id) || seen.has(id) || title.length === 0 || title.length > 60) continue;
    seen.add(id);
    out.push({ id, title, content: "" });
  }
  return out;
}

/** 合并建议校验：2-3 个已知 id、跨组不重复、理由截断；不合法整组丢弃。 */
function parseMerges(raw: unknown[], validIds: ReadonlySet<string>): MergeSuggestion[] {
  const used = new Set<string>();
  const out: MergeSuggestion[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as { ids?: unknown; reason?: unknown };
    if (!Array.isArray(record.ids)) continue;
    const ids = [
      ...new Set(record.ids.filter((id): id is string => typeof id === "string" && validIds.has(id))),
    ];
    if (ids.length < 2 || ids.length > 3) continue;
    if (ids.some((id) => used.has(id))) continue;
    const reason =
      typeof record.reason === "string" && record.reason.trim()
        ? record.reason.replace(/\s+/g, " ").trim().slice(0, 80)
        : "回顾判定为同一事实";
    for (const id of ids) used.add(id);
    out.push({ ids, reason });
  }
  return out;
}

/** 解析回顾输出：优先 JSON 对象（titles + merges），兼容旧的纯数组（只有标题）。 */
export function parseReviewPayload(text: string, validIds: ReadonlySet<string>): ReviewResult {
  // 只有「顶层就是对象」才走对象解析；数组里的 {} 不能被误判
  const head = text.replace(/^\s*```(?:json)?/i, "").trim();
  const objectStart = head.startsWith("{") ? text.indexOf("{") : -1;
  const objectEnd = text.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    try {
      const parsed = JSON.parse(text.slice(objectStart, objectEnd + 1)) as { titles?: unknown; merges?: unknown };
      if (parsed && typeof parsed === "object") {
        const titles = Array.isArray(parsed.titles)
          ? parsed.titles.map((item) => {
              if (!item || typeof item !== "object") return null;
              const record = item as { id?: unknown; title?: unknown };
              if (typeof record.id !== "string" || typeof record.title !== "string") return null;
              const id = record.id.trim();
              const title = record.title.replace(/\s+/g, " ").trim().replace(/[。.!?！？]+$/g, "");
              if (!validIds.has(id) || title.length === 0 || title.length > 60) return null;
              return { id, title, content: "" } satisfies TitleSuggestion;
            }).filter((item): item is TitleSuggestion => Boolean(item))
          : [];
        const seen = new Set<string>();
        const uniqueTitles = titles.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
        return { titles: uniqueTitles, merges: Array.isArray(parsed.merges) ? parseMerges(parsed.merges, validIds) : [] };
      }
    } catch {
      // 落到数组解析
    }
  }
  return { titles: parseReviewResponse(text, validIds), merges: [] };
}

/**
 * 调模型做一次回顾：标题 + 合并建议。llm 缺失/超时/输出非法 → null。
 * 用 AbortController 控制超时，避免回顾把设置页卡住。
 */
export async function reviewMemory(
  llm: LlmClient | undefined,
  facts: readonly MemoryFact[],
  timeoutMs = 20_000,
): Promise<ReviewResult | null> {
  if (!llm || facts.length === 0) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let text = "";
    for await (const chunk of llm.invoke({
      messages: [{ role: "user", content: buildReviewPrompt(facts) }],
      maxTokens: 1200,
      signal: controller.signal,
    })) {
      if (chunk.kind === "text") text += chunk.text;
      if (chunk.kind === "error") return null;
    }
    const byId = new Map(facts.map((fact) => [fact.id, fact]));
    const parsed = parseReviewPayload(text, new Set(byId.keys()));
    return {
      titles: parsed.titles.map((suggestion) => ({
        ...suggestion,
        content: byId.get(suggestion.id)?.content ?? "",
      })),
      merges: parsed.merges,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 兼容旧调用：只要标题。 */
export async function reviewTitles(
  llm: LlmClient | undefined,
  facts: readonly MemoryFact[],
  timeoutMs = 20_000,
): Promise<TitleSuggestion[] | null> {
  const result = await reviewMemory(llm, facts, timeoutMs);
  return result ? result.titles : null;
}
