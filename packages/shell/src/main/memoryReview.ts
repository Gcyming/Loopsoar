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
    '只输出 JSON 数组，例如 [{"id":"m1","title":"pnpm 依赖管理约定"}]，不要解释、不要代码块。',
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

/**
 * 调模型生成标题建议。llm 缺失/超时/输出非法 → null（调用方保留规则标题）。
 * 用 AbortController 控制超时，避免回顾把设置页卡住。
 */
export async function reviewTitles(
  llm: LlmClient | undefined,
  facts: readonly MemoryFact[],
  timeoutMs = 20_000,
): Promise<TitleSuggestion[] | null> {
  if (!llm || facts.length === 0) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let text = "";
    for await (const chunk of llm.invoke({
      messages: [{ role: "user", content: buildReviewPrompt(facts) }],
      maxTokens: 900,
      signal: controller.signal,
    })) {
      if (chunk.kind === "text") text += chunk.text;
      if (chunk.kind === "error") return null;
    }
    const byId = new Map(facts.map((fact) => [fact.id, fact]));
    return parseReviewResponse(text, new Set(byId.keys())).map((suggestion) => ({
      ...suggestion,
      content: byId.get(suggestion.id)?.content ?? "",
    }));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
