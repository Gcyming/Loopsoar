/**
 * 规则体检：冲突、重复与可读性（纯逻辑）。
 *
 * 冲突的判定刻意保守：只把「同一条约束、一正一反」算冲突。
 * 例如「必须使用 pnpm」与「不要使用 pnpm」；「只能使用 pnpm」与「必须使用 pnpm」
 * 只是措辞不同，不算冲突（留给重复/人工合并）。
 */
import { parseRuleDocument, ruleDocumentBody, type RulePolarity } from "./document.js";

export interface RuleSource {
  id: string;
  scope: "global" | "workspace";
  name: string;
  text: string;
}

export interface RuleLine {
  sourceId: string;
  scope: "global" | "workspace";
  name: string;
  text: string;
  key: string;
  polarity: RulePolarity;
}

export interface RuleConflict {
  type: "conflict" | "duplicate";
  a: { text: string; scope: "global" | "workspace"; name: string };
  b: { text: string; scope: "global" | "workspace"; name: string };
  reason: string;
}

function linesOf(source: RuleSource): RuleLine[] {
  return parseRuleDocument(source.text).filter((line) => line.key.length >= 3).map((line) => ({
    sourceId: source.id,
    scope: source.scope,
    name: source.name,
    text: line.text,
    key: line.key,
    polarity: line.polarity,
  }));
}

export function analyzeRuleConflicts(sources: RuleSource[]): RuleConflict[] {
  const lines = sources.flatMap(linesOf);
  const out: RuleConflict[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i += 1) {
    for (let j = i + 1; j < lines.length; j += 1) {
      const a = lines[i];
      const b = lines[j];
      if (a.key !== b.key) continue;
      if (a.polarity !== "neutral" && b.polarity !== "neutral" && a.polarity !== b.polarity) {
        const id = "conflict:" + [a.text, b.text].sort().join("|");
        if (!seen.has(id)) {
          seen.add(id);
          out.push({
            type: "conflict",
            a: { text: a.text, scope: a.scope, name: a.name },
            b: { text: b.text, scope: b.scope, name: b.name },
            reason: "同一条约束同时出现正向与禁止表述",
          });
        }
      } else if (ruleDocumentBody(a.text) === ruleDocumentBody(b.text) && a.sourceId !== b.sourceId) {
        const id = "duplicate:" + ruleDocumentBody(a.text);
        if (!seen.has(id)) {
          seen.add(id);
          out.push({
            type: "duplicate",
            a: { text: a.text, scope: a.scope, name: a.name },
            b: { text: b.text, scope: b.scope, name: b.name },
            reason: "同一条规则出现在多个位置，建议保留一处",
          });
        }
      }
    }
  }
  return out.slice(0, 20);
}
