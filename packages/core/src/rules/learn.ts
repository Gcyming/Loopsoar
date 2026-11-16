/**
 * 规则候选抽取（纯逻辑，不碰 fs/模型）。
 *
 * 目标：只把「用户明确说出的硬约束」变成候选规则，交给人确认后再写入 AGENTS.md。
 * 不做自动改写 —— CLR-Bench 的教训是：把每条反馈都记成例外，列表会越来越长却学不到规则。
 */

export type RuleStrength = "hard" | "should" | "prefer";

export interface RuleCandidate {
  /** 去重键（去掉情态词/标点后的小写正文）。 */
  key: string;
  /** 可写入规则文件的规范文本（去掉「请/帮我」等口语前缀）。 */
  text: string;
  /** 用户原句（保留证据）。 */
  quote: string;
  strength: RuleStrength;
  /** 作用域提示：提到所有项目/全局 → global，否则 workspace。 */
  scopeHint: "workspace" | "global";
  confidence: number;
  tags: string[];
}

const HARD_ZH = ["必须", "只能", "禁止", "不得", "不允许", "严禁", "一律", "务必", "绝不", "永远不要", "不要再", "别再", "不能", "不要", "不准", "只可"];
const SHOULD_ZH = ["应该", "应当", "建议", "最好", "推荐", "尽量"];
const HARD_EN = [/\bmust\b/i, /\bnever\b/i, /\bonly\b/i, /\bdo not\b/i, /\bdon't\b/i, /\bcannot\b/i, /\bcan't\b/i, /\bprohibited\b/i, /\brequired\b/i, /\bshall\b/i];
const SHOULD_EN = [/\bshould\b/i, /\bprefer\b/i, /\bavoid\b/i, /\brecommend/i];
const QUESTION = /(吗|呢|是否|能不能|可不可以|要不要|为什么|怎么|如何|什么|哪|\?|？)$/;
/** 断句会丢掉问号；用疑问词兜底，避免「能不能用 npm」被当成规则。 */
const QUESTION_WORDS = /(能不能|可不可以|要不要|是不是|是否|为什么|怎么办|怎么|如何|吗|呢)/;
const UNCERTAIN = /(如果|假如|假设|可能|也许|大概|或许|我觉得|我认为这不一定|不确定)/;
const GLOBAL_SCOPE = /(所有项目|任何项目|每个项目|全部项目|全局|跨项目|all projects?|every project|across projects?)/i;
const STRIP_PREFIX = /^(请|帮我|麻烦|劳驾|记住|注意|以后|今后|从今以后|接下来|另外|还有|但|但是|而且|并且|同时|所以|因此|不过|然后)\s*/;

function hasAny(text: string, words: string[]): boolean {
  return words.some((w) => text.includes(w));
}

function strengthOf(text: string): RuleStrength | null {
  if (hasAny(text, HARD_ZH) || HARD_EN.some((re) => re.test(text))) return "hard";
  if (hasAny(text, SHOULD_ZH) || SHOULD_EN.some((re) => re.test(text))) return "should";
  return null;
}

function normalizeText(raw: string): string {
  let text = raw.trim().replace(/^[-*•\d.、)\s]+/, "");
  text = text.replace(STRIP_PREFIX, "");
  text = text.replace(/[\s，,]+/g, " ").replace(/\s+([。.!！?？])/g, "$1").trim();
  return text.replace(/[。.!！?？；;]+$/, "").trim();
}

function keyOf(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s，,。.!！?？:：;；"'“”‘’()（）\[\]【】]/g, "")
    .replace(/(必须|只能|禁止|不得|不允许|严禁|一律|务必|绝不|不要|不能|不准|应该|应当|建议|最好|推荐|尽量)/g, "")
    .replace(/\b(must|should|never|always|only|do not|don't|cannot|can't|prefer|avoid|recommend)\b/g, "")
    .trim();
}

function splitClauses(sentence: string): string[] {
  return sentence
    .split(/[，,]/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 4);
}

/** 从一段用户消息里抽候选规则；同一句只保留一条（按 key 去重）。 */
export function extractRuleCandidates(message: string): RuleCandidate[] {
  const cleaned = message.replace(/\x60{3}[\s\S]*?\x60{3}/g, " ").replace(/\r/g, "");
  const sentences = cleaned
    // 中文/感叹/问号/分号直接断句；英文句号只在「小写/数字 + 句号 + 空格 + 大写」时断，
    // 避免把 AGENTS.md、dist/ 这类文件名拆开。
    .replace(/[！？!?；;]/g, "。")
    .split(/。\s*|\n+/)
    .flatMap((s) => s.split(/(?<=[a-z0-9)])[.]\s+(?=[A-Z])/))
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 40);
  const out = new Map<string, RuleCandidate>();

  for (const sentence of sentences) {
    if (sentence.length < 4 || sentence.length > 400) continue;
    if (QUESTION.test(sentence.trim())) continue;
    if (UNCERTAIN.test(sentence)) continue;

    const clauses = splitClauses(sentence);
    const candidates = clauses.length > 0 ? clauses : [sentence];
    const sentenceBoost = /(记住|以后|今后|永远|始终)/.test(sentence) ? 0.05 : 0;
    for (const clause of candidates) {
      const strength = strengthOf(clause);
      if (!strength) continue;
      const text = normalizeText(clause);
      if (text.length < 4 || text.length > 240) continue;
      if (QUESTION.test(text) || QUESTION_WORDS.test(text)) continue;
      const key = keyOf(text);
      if (!key || key.length < 3) continue;

      const scopeHint = GLOBAL_SCOPE.test(text) ? "global" : "workspace";
      let confidence = strength === "hard" ? 0.86 : strength === "should" ? 0.6 : 0.45;
      confidence += sentenceBoost;
      confidence = Math.min(0.95, Math.round(confidence * 100) / 100);
      const candidate: RuleCandidate = {
        key,
        text,
        quote: sentence,
        strength,
        scopeHint,
        confidence,
        tags: [
          strength === "hard" ? "硬约束" : strength === "should" ? "建议" : "偏好",
          /[\p{Script=Han}]/u.test(text) ? "中文" : "English",
        ],
      };
      const existing = out.get(key);
      if (!existing || candidate.confidence > existing.confidence) out.set(key, candidate);
    }
  }

  return [...out.values()];
}
