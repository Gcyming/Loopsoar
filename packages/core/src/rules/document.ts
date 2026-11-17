/**
 * 规则文档的统一解析层：所有规则消费者（守卫/体检/清单/命令）都从这里取行。
 *
 * 为什么需要：五个模块各自切行、去 bullet、判问句，语义漂移时会出现
 * 「体检认为重复、守卫没编译、清单又列出来」的不一致。
 */

export type RulePolarity = "positive" | "negative" | "neutral";

export interface RuleDocumentLine {
  /** 去 bullet、压缩空白后的规则文本。 */
  text: string;
  /** 去情态词/标点后的去重键。 */
  key: string;
  polarity: RulePolarity;
  /** 原始行（保留来源审计用）。 */
  raw: string;
}

const NEGATIVE = /(不要|禁止|不得|不能|不允许|严禁|别再|请勿|绝不|never|do not|don't|must not|cannot|can't)/i;
const POSITIVE = /(必须|只能|一律|务必|始终|总是|must|always|only|required|shall)/i;
const MODAL = /(必须|只能|禁止|不得|不能|不允许|严禁|一律|务必|绝不|不要|不准|应该|应当|请|别再|始终|总是|must|should|never|always|only|do not|don't|cannot|can't|required|shall)/gi;
const PUNCT = /[\s，,。.!！?？:：;；"'“”‘’()（）\[\]【】]/g;
const QUESTION = /(吗|呢|是否|能不能|可不可以|要不要|为什么|怎么|如何|什么|哪|\?|？)$/;
const HYPOTHETICAL = /^(如果|假如|假设|为什么|怎么|如何|是否|能不能|要不要)/;

export function stripRuleLine(raw: string): string {
  return raw.replace(/^\s*[-*]\s*/, "").trim();
}

export function ruleDocumentKey(text: string): string {
  return text
    .toLowerCase()
    .replace(PUNCT, "")
    .replace(MODAL, "")
    .replace(PUNCT, "")
    .trim();
}

export function ruleDocumentBody(text: string): string {
  return text.toLowerCase().replace(PUNCT, "").trim();
}

export function rulePolarity(text: string): RulePolarity {
  if (NEGATIVE.test(text)) return "negative";
  if (POSITIVE.test(text)) return "positive";
  return "neutral";
}

function isCandidateLine(text: string): boolean {
  if (text.length < 4) return false;
  if (/^#/.test(text) || /^\x60{3}/.test(text) || /^<!--/.test(text)) return false;
  if (/^(?:[-*]\s*)?\[[ xX]\]/.test(text)) return false;
  if (QUESTION.test(text) || HYPOTHETICAL.test(text)) return false;
  return true;
}

/** 解析规则文档；默认上限 240 字，超出由调用方决定是否截断/忽略。 */
export function parseRuleDocument(text: string, options: { maxLength?: number } = {}): RuleDocumentLine[] {
  const maxLength = options.maxLength ?? 240;
  const out: RuleDocumentLine[] = [];
  let inFence = false;
  for (const raw of text.split(/\r?\n/)) {
    const stripped = stripRuleLine(raw);
    if (/^\x60{3}/.test(stripped)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const line = stripped;
    if (!line || line.length > maxLength || !isCandidateLine(line)) continue;
    const key = ruleDocumentKey(line);
    out.push({ text: line, key, polarity: rulePolarity(line), raw: line });
  }
  return out;
}
