/**
 * 会话级 LLM 回顾：把「失败 → 纠正 → 改对」的片段归纳成 0-3 条候选规则。
 * 只产出候选，不写规则文件；模型缺失/超时/输出不合法一律返回 null。
 */
import type { LlmClient } from "loopsoar-core/llm";

export interface ProposedRule {
  text: string;
  quote: string;
}

function shorten(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}

export function buildRuleReviewPrompt(messages: { role: string; text: string }[]): string {
  const lines = messages.map((message, index) => (index + 1) + ". " + message.role + "：" + shorten(message.text, 500));
  return [
    "你是 Loopsoar 的规则整理员。请从下面的会话中归纳 0-3 条「以后应当遵守」的行为规则。",
    "只归纳可复用的约束/偏好（例如工具选择、路径禁令、提交规范）；不要记录一次性的任务细节、错误堆栈或闲聊。",
    "每条规则用祈使句，中文不超过 80 字；quote 必须是会话里能支撑这条规则的原句。",
    "没有值得沉淀的规则就返回空数组。不要输出 Markdown 代码块或解释。",
    '输出 JSON 对象：{"rules":[{"text":"只能使用 pnpm 安装依赖","quote":"不对，应该用 pnpm"}]}。',
    "",
    ...lines,
  ].join("\n");
}

export function parseRuleReviewResponse(text: string): ProposedRule[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { rules?: unknown }).rules)) return [];
  const seen = new Set<string>();
  const out: ProposedRule[] = [];
  for (const item of (raw as { rules: unknown[] }).rules) {
    if (!item || typeof item !== "object") continue;
    const record = item as { text?: unknown; quote?: unknown };
    if (typeof record.text !== "string") continue;
    const textValue = record.text.replace(/\s+/g, " ").trim().replace(/[。.!！?？；;]+$/g, "");
    if (textValue.length < 4 || textValue.length > 160 || seen.has(textValue)) continue;
    seen.add(textValue);
    out.push({
      text: textValue,
      quote: typeof record.quote === "string" ? record.quote.replace(/\s+/g, " ").trim().slice(0, 200) : textValue,
    });
  }
  return out.slice(0, 3);
}

export async function reviewSessionRules(
  llm: LlmClient | undefined,
  messages: { role: string; text: string }[],
  timeoutMs = 25_000,
): Promise<ProposedRule[] | null> {
  if (!llm || messages.length === 0) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let text = "";
    for await (const chunk of llm.invoke({
      messages: [{ role: "user", content: buildRuleReviewPrompt(messages) }],
      maxTokens: 900,
      signal: controller.signal,
    })) {
      if (chunk.kind === "text") text += chunk.text;
      if (chunk.kind === "error") return null;
    }
    return parseRuleReviewResponse(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
