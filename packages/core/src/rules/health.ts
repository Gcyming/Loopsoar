/**
 * 规则体检：冲突、重复与可读性（纯逻辑）。
 *
 * 冲突的判定刻意保守：只把「同一条约束、一正一反」算冲突。
 * 例如「必须使用 pnpm」与「不要使用 pnpm」；「只能使用 pnpm」与「必须使用 pnpm」
 * 只是措辞不同，不算冲突（留给重复/人工合并）。
 */

export type RulePolarity = "positive" | "negative" | "neutral";

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

const NEGATIVE = /(不要|禁止|不得|不能|不允许|严禁|别再|请勿|绝不|never|do not|don't|must not|cannot|can't)/i;
const POSITIVE = /(必须|只能|一律|务必|始终|总是|must|always|only|required|shall)/i;
const MODAL = /(必须|只能|禁止|不得|不能|不允许|严禁|一律|务必|绝不|不要|不准|应该|应当|请|别再|始终|总是|must|should|never|always|only|do not|don't|cannot|can't|required|shall)/gi;
const PUNCT = /[\s，,。.!！?？:：;；"'“”‘’()（）\[\]【】]/g;

function polarityOf(text: string): RulePolarity {
  if (NEGATIVE.test(text)) return "negative";
  if (POSITIVE.test(text)) return "positive";
  return "neutral";
}

function keyOf(text: string): string {
  return text.toLowerCase().replace(PUNCT, "").replace(MODAL, "").replace(PUNCT, "").trim();
}

function bodyOf(text: string): string {
  return text.toLowerCase().replace(PUNCT, "").trim();
}

function isRuleLine(text: string): boolean {
  const t = text.trim();
  if (t.length < 4 || t.length > 240) return false;
  if (/^#/.test(t) || /^\x60{3}/.test(t) || /^<!--/.test(t)) return false;
  // 自检清单和引用不是独立规则
  if (/^[-*]\s*\[[ xX]\]/.test(t)) return false;
  if (/[?？]$/.test(t)) return false;
  if (/^(如果|假如|假设|为什么|怎么|如何|是否|能不能|要不要)/.test(t)) return false;
  return true;
}

function linesOf(source: RuleSource): RuleLine[] {
  return source.text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter(isRuleLine)
    .map((text) => ({
      sourceId: source.id,
      scope: source.scope,
      name: source.name,
      text,
      key: keyOf(text),
      polarity: polarityOf(text),
    }))
    .filter((line) => line.key.length >= 3);
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
      } else if (bodyOf(a.text) === bodyOf(b.text) && a.sourceId !== b.sourceId) {
        const id = "duplicate:" + bodyOf(a.text);
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
