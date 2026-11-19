/**
 * 混合召回排序（纯逻辑，零 IO）：docs/规划/记忆召回-原点图与混合检索方案.md §3.3 / §9 P0。
 *
 * 三种模式：
 *  - similarity：旧行为（effectiveValue × (0.2 + jaccard) + tag 加分），用于零回归与精确查询；
 *  - hybrid：0.55·A + 0.35·S + 0.10·E + 0.05·G（默认目标形态，P1 接图后启用）；
 *  - distance：0.75·A + 0.25·S，只在「上次那个 / 继续上一轮」这类模糊指代里显式开启。
 *
 * 资格规则（方案 §3.3 约束）：
 *  - hybrid / distance 的候选必须先过「相似度门槛」或 exact / tag 命中，
 *    不能只靠激活值把无关记忆排上来；
 *  - L2 游离层乘 0.85；L3 失真层默认不进入自动召回，只有 exact 命中（显式提及）才放行；
 *  - similarity 模式完全复现旧公式，不加资格门槛、不加层级惩罚（零回归）。
 *
 * 为什么 A 缺失时用 min(1, effectiveValue) 兜底：方案 §10「usage 稀疏 → 新记忆 A=0 永远排不上」，
 * effectiveValue 已含重要度 / 置信度 / 时间衰减，是现成的冷启动先验；不用再拍一个魔法常数。
 */

export type MemoryRankingMode = "similarity" | "hybrid" | "distance";

/** 图层级：L1 近端 / L2 游离 / L3 失真。 */
export type MemoryBand = "L1" | "L2" | "L3";

export interface RankCandidate {
  id: string;
  /** 词法相似度（Jaccard 或归一化 BM25），0..1。 */
  similarity: number;
  /** 旧公式里的 effectiveValue（similarity 模式专用；hybrid/distance 只用它做冷启动先验）。 */
  value?: number;
  /** 0..1 激活值（来自图 / usage 事件）；缺省 = 冷启动先验。 */
  activation?: number;
  /** 精确命中（实体名 / 路径 / 端口 / 命令 / 引号内容 / tag）。 */
  exact?: boolean;
  /** tag 命中（旧公式的 +0.15 项与 exact 判定的一个来源）。 */
  tagHit?: boolean;
  /** 0..1 图邻居加成（命中节点的 1 跳邻居）。 */
  graph?: number;
  /** 层级；缺省按 L1 处理。 */
  band?: MemoryBand;
}

export interface RankedHit {
  id: string;
  /** 融合后的最终分数（降序）。 */
  score: number;
  /** 命中理由：lexical / exact / activation / graph / band:L2 / cold-start。 */
  reasons: string[];
}

export interface RankOptions {
  /** 缺省 similarity：默认行为与旧实现完全一致。 */
  mode?: MemoryRankingMode;
  limit?: number;
  /** 最终分数下限（旧行为 0.02）。 */
  minScore?: number;
  /** hybrid/distance 的资格门槛：similarity ≥ 该值，或 exact/tag 命中。 */
  minSimilarity?: number;
  /** L2 层级惩罚（方案 §3.2：乘 0.85）。 */
  l2Penalty?: number;
  /** 是否放行 L3（方案 §7：默认排除，显式提及时才 rehydrate）。 */
  includeL3?: boolean;
}

/** 方案 §3.3 的权重。 */
export const HYBRID_WEIGHTS = { activation: 0.55, similarity: 0.35, exact: 0.1, graph: 0.05 } as const;
export const DISTANCE_WEIGHTS = { activation: 0.75, similarity: 0.25 } as const;
/** 旧公式的相似度基数与 tag 加分（与 store.recall 对齐）。 */
export const SIMILARITY_BASE = 0.2;
export const TAG_BONUS = 0.15;
/** 旧行为的分数下限（store.recall 的 0.02）。 */
export const DEFAULT_RANK_MIN_SCORE = 0.02;
/** hybrid/distance 的资格门槛：低于它且非 exact，视为「只靠激活值」的无关候选。 */
export const DEFAULT_MIN_SIMILARITY = 0.05;
/** L2 惩罚系数（方案 §3.2）。 */
export const DEFAULT_L2_PENALTY = 0.85;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** 冷启动先验：没有 usage 事件时，用 effectiveValue（含重要度/置信度/新近度）折算 0..1。 */
export function coldStartActivation(value: number | undefined): number {
  return clamp01(value ?? 0);
}

function scoreOf(
  candidate: RankCandidate,
  mode: MemoryRankingMode,
  l2Penalty: number,
  minSimilarity: number,
  includeL3: boolean,
): RankedHit | null {
  const similarity = clamp01(candidate.similarity);
  const band = candidate.band ?? "L1";
  const exact = Boolean(candidate.exact ?? candidate.tagHit);
  const tagHit = Boolean(candidate.tagHit);

  if (mode === "similarity") {
    // 旧公式：effectiveValue × (0.2 + jaccard) + tag 加分。不加资格门槛，保持零回归。
    const score = (candidate.value ?? 0) * (SIMILARITY_BASE + similarity) + (tagHit ? TAG_BONUS : 0);
    const reasons = [similarity > 0 ? "lexical" : "tag"];
    if (exact) reasons.push("exact");
    return { id: candidate.id, score, reasons };
  }

  // hybrid / distance：相似度（或 exact）是资格，激活值只是先验。
  const qualified = exact || similarity >= minSimilarity;
  if (!qualified) return null;
  if (band === "L3" && !exact && !includeL3) return null;

  const activation = clamp01(candidate.activation ?? coldStartActivation(candidate.value));
  const graph = clamp01(candidate.graph ?? 0);
  const raw =
    mode === "hybrid"
      ? HYBRID_WEIGHTS.activation * activation +
        HYBRID_WEIGHTS.similarity * similarity +
        HYBRID_WEIGHTS.exact * (exact ? 1 : 0) +
        HYBRID_WEIGHTS.graph * graph
      : DISTANCE_WEIGHTS.activation * activation + DISTANCE_WEIGHTS.similarity * similarity;

  const reasons: string[] = [];
  if (similarity > 0) reasons.push("lexical");
  if (exact) reasons.push("exact");
  if (candidate.activation === undefined) reasons.push("cold-start");
  else reasons.push("activation");
  if (graph > 0) reasons.push("graph");

  let score = raw;
  if (band === "L2") {
    score *= l2Penalty;
    reasons.push("band:L2");
  }
  return { id: candidate.id, score, reasons };
}

/**
 * 排序候选并截断。纯函数：给定同样的输入永远得到同样的顺序（分数相同按 id 升序，避免抖动）。
 */
export function rankMemory(candidates: readonly RankCandidate[], opts: RankOptions = {}): RankedHit[] {
  const mode = opts.mode ?? "similarity";
  const limit = Math.max(1, Math.floor(opts.limit ?? 6));
  const minScore = opts.minScore ?? DEFAULT_RANK_MIN_SCORE;
  const l2Penalty = opts.l2Penalty ?? DEFAULT_L2_PENALTY;
  const minSimilarity = Math.max(0, opts.minSimilarity ?? DEFAULT_MIN_SIMILARITY);
  const includeL3 = Boolean(opts.includeL3);
  const scored: RankedHit[] = [];
  for (const candidate of candidates) {
    const hit = scoreOf(candidate, mode, l2Penalty, minSimilarity, includeL3);
    if (hit && hit.score > minScore) scored.push(hit);
  }
  scored.sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id));
  return scored.slice(0, limit);
}

/**
 * 精确命中判定（exact/tag 的 exact 部分）：引号内容、类路径/端口/命令的 token、
 * 或 tag 直接命中。用于给 hybrid 一个「字面精确」资格，不参与 similarity 计算。
 */
export function detectExactHit(query: string, content: string, tags: readonly string[] = []): boolean {
  for (const tag of tags) {
    if (tag.length >= 2 && query.includes(tag)) return true;
  }
  const quoted = query.match(/["'“”「」『』]([^"'“”「」『』]{2,})["'“”「」『』]/);
  if (quoted && content.includes(quoted[1])) return true;
  // 端口 / 路径 / 命令 / 反引号片段：要求至少 3 个字符，避免单字误判。
  const tokens = query.match(/[A-Za-z]:[\\/][^\s，。；]+|(?:^|\s)(?:\d{2,5})(?:\s|$)|\/[A-Za-z0-9_.-]{2,}|[A-Za-z_][A-Za-z0-9_.-]{2,}/g);
  if (!tokens) return false;
  return tokens.some((token) => token.trim().length >= 3 && content.includes(token.trim()));
}
