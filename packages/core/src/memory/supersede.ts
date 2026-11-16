/**
 * 取代判定（D2）：新记忆是否让旧记忆「失效」。
 *
 * 为什么单独成模块：去重（相似=同一条）与取代（相似但语义相反/更新）是两种判断，
 * 用同一个阈值会误伤（「喜欢 X」与「不喜欢 X」相似度极高但语义相反）。
 *
 * 判据（保守，宁可不取代也不误取代）：
 *  - 新内容带明确变更标记（改为/换成/不再/停止…）→ 相似度 ≥ 0.5 即取代；
 *  - 否定翻转（一方有「不/没/别」另一方没有）→ 相似度 ≥ 0.7 才取代；
 *  - 数字变化（端口/版本）→ 相似度 ≥ 0.45 且骨架相同。
 */
import { jaccardCJK } from "./fiveGate.js";
import type { MemoryFact } from "./fact.js";

const CHANGE_MARKER = /(改为|改成|换成|改用|不再|停止使用|取消|废弃|弃用|替代|instead of|switch(?:ed)? to|no longer|deprecated)/i;
const NEGATION = /(不|没|别|无需|禁止|不要)/;
const NUMBER = /\d+/g;

function numbersOf(text: string): Set<string> {
  return new Set(text.match(NUMBER) ?? []);
}

export interface SupersedeCandidate {
  fact: MemoryFact;
  reason: "marker" | "negation" | "number";
  similarity: number;
}

export function detectSupersede(
  incoming: { content: string; category: string },
  existing: readonly MemoryFact[],
): SupersedeCandidate[] {
  const text = incoming.content.trim();
  if (!text) return [];
  const hasMarker = CHANGE_MARKER.test(text);
  const incomingNeg = NEGATION.test(text);
  const incomingNumbers = numbersOf(text);
  const out: SupersedeCandidate[] = [];

  for (const fact of existing) {
    if (fact.status !== "active" || fact.invalidatedAt) continue;
    if (fact.category !== incoming.category) continue;
    const similarity = jaccardCJK(text, fact.content);
    const factNeg = NEGATION.test(fact.content);
    const factNumbers = numbersOf(fact.content);

    // 数字变化：「端口 8080」→「端口 9090」
    const numberChanged =
      incomingNumbers.size > 0 &&
      factNumbers.size > 0 &&
      [...incomingNumbers].some((n) => !factNumbers.has(n)) &&
      similarity >= 0.45;
    if (numberChanged && (hasMarker || similarity >= 0.6)) {
      out.push({ fact, reason: "number", similarity });
      continue;
    }
    if (hasMarker && similarity >= 0.5) {
      out.push({ fact, reason: "marker", similarity });
      continue;
    }
    if (incomingNeg !== factNeg && similarity >= 0.7) {
      out.push({ fact, reason: "negation", similarity });
    }
  }
  return out;
}
