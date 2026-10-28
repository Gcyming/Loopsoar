/**
 * 记忆抽取（启发式，零外部调用）：从一轮对话里抽取「值得长期记住」的候选。
 *
 * 为什么 v1 用规则而不是 LLM：抽取必须便宜且可离线（未配置供应商时也要工作）；
 * Mem0 式「抽取→比对→更新」的管线里，抽取这一步先用规则兜底，
 * 后续接入供应商后再把「语义抽取」插到同一入口（候选结构与存储不变）。
 *
 * 抽取信号（中文为主，兼顾英文）：
 *  - 偏好：偏好/喜欢/习惯/不要/别用/默认/风格
 *  - 约定：约定/决定/采用/以后/记住/规范/规则
 *  - 项目事实：项目/仓库/路径/端口/技术栈/框架/版本
 *  - 身份：我是/我的/叫我
 */
import type { MemoryCandidate } from "./store.js";

interface Rule {
  category: string;
  importance: number;
  pattern: RegExp;
  tags: string[];
}

const RULES: Rule[] = [
  { category: "preference", importance: 7, pattern: /(偏好|喜欢|习惯|不要|别用|默认|风格)/, tags: ["偏好"] },
  { category: "convention", importance: 8, pattern: /(约定|决定|采用|以后|记住|规范|规则|必须)/, tags: ["约定"] },
  { category: "project", importance: 9, pattern: /(项目|仓库|代码库|路径|端口|技术栈|框架|版本|模块)/, tags: ["项目"] },
  { category: "identity", importance: 6, pattern: /(我是|我的|叫我|用户是)/, tags: ["身份"] },
];

/** 单轮最多抽取条数（防刷屏）。 */
export const MAX_CANDIDATES_PER_TURN = 5;
/** 单条候选最大长度（超长句子截断，保留可召回性）。 */
export const MAX_CANDIDATE_CHARS = 300;

/** 句子切分：中英文句末标点 + 换行；过滤过短/纯标点/问句（问句通常不是事实）。 */
function splitSentences(text: string): string[] {
  return text
    .split(/[。！？!?；;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 6 && s.length <= 600)
    .filter((s) => !/[?？]$/.test(s));
}

/**
 * 从一轮对话抽取候选记忆。
 * 只从用户消息与助手最终答复里抽（工具输出噪声大，交给五闸去重即可，不主动抽）。
 */
export function extractMemoryCandidates(input: {
  userMessage: string;
  assistantReply?: string;
  maxCandidates?: number;
}): MemoryCandidate[] {
  const max = input.maxCandidates ?? MAX_CANDIDATES_PER_TURN;
  const sentences = [
    ...splitSentences(input.userMessage).map((s) => ({ text: s, source: "user" as const })),
    ...splitSentences(input.assistantReply ?? "").map((s) => ({ text: s, source: "assistant" as const })),
  ];

  const candidates: MemoryCandidate[] = [];
  for (const sentence of sentences) {
    if (candidates.length >= max) break;
    const matchers = RULES.filter((rule) => rule.pattern.test(sentence.text));
    if (matchers.length === 0) continue;
    const primary = matchers[0];
    const tags = [...new Set(matchers.flatMap((m) => m.tags))].slice(0, 4);
    const content = sentence.text.slice(0, MAX_CANDIDATE_CHARS).replace(/^[-*\s]+/, "");
    if (content.length < 6) continue;
    candidates.push({
      content,
      category: primary.category,
      importance: Math.max(...matchers.map((m) => m.importance)),
      tags,
      source: sentence.source,
      layer: primary.category === "project" ? "semantic" : "episodic",
    });
  }
  return candidates;
}
