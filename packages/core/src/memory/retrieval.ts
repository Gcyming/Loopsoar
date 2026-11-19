/**
 * 四阶段记忆检索（纯逻辑，零 IO）：
 *   ① 召回门控：shouldRecall（廉价字符串信号，决定「要不要检索」）；
 *   ② 关键词候选：BM25 简化版（带 IDF，避免「的/是/用户」类高频词淹没候选）；
 *   ③ 向量重排：余弦相似度对候选重排（hash embedding 或外部 BGE-M3 向量都走同一接口）；
 *   ④ 阈值 + limit：按「有效值 × 关键词相似度 × 向量相似度」融合排序后截断。
 *
 * 为什么四阶段而不是纯向量：BGE-M3 未接入时 hash embedding 只是「词法向量」，纯向量会把
 * 「同词不同义」也算相似；关键词阶段保底精确词命中，向量阶段补词序/搭配信号，二者互补。
 * 为什么融合公式延续 store.recall 的 `有效值 × (0.3 + 相似度)`：显式搜索的既有语义与排序
 * （importance/新近度参与排序）不能因加向量而突变，否则 memory_search 工具行为回归。
 */
import { jaccardCJK } from "./fiveGate.js";
import { shouldRecall } from "./recallGate.js";
import { DEFAULT_EMBED_DIM, cosineSimilarity, hashEmbedding, tokenize } from "./vector.js";

/** 单次检索默认召回候选数（BM25 阶段截断）。 */
export const DEFAULT_CANDIDATE_LIMIT = 60;
/** 默认 limit（与 store.recall / memory_search 默认值一致）。 */
export const DEFAULT_RETRIEVAL_LIMIT = 6;
/** 向量重排权重（0 = 纯关键词；1 = 向量与关键词等权）。 */
export const DEFAULT_VECTOR_WEIGHT = 0.5;
/** 最终分数阈值（与 store.recall 的 0.08 对齐，保证旧搜索语义兼容）。 */
export const DEFAULT_MIN_SCORE = 0.08;
/** 相似度项基数（与 store.recall 对齐）。 */
const SIMILARITY_BASE = 0.3;
/** tag 命中加分（与 store.recall 对齐）。 */
const TAG_BONUS = 0.15;
const DAY_MS = 86_400_000;

/** BM25 参数（简化版：k1=1.2 / b=0.75 是通用起点，未按中文语料再调）。 */
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/** 检索用的轻量文档结构（MemoryFact 结构兼容，便于直接传 facts）。 */
export interface RetrievalDoc {
  id: string;
  content: string;
  tags?: readonly string[];
  importance?: number;
  confidence?: number;
  repeated?: number;
  lastAccessed?: number;
}

export interface KeywordCandidate {
  doc: RetrievalDoc;
  /** BM25（未归一化，仅用于候选排序）。 */
  bm25: number;
  /** 与 query 的 Jaccard（与五闸同口径，用于融合打分）。 */
  jaccard: number;
}

export interface RetrievalHit {
  id: string;
  /** 融合后的最终分数（降序）。 */
  score: number;
  /** 关键词相似度（jaccard + tag 加分）。 */
  keywordScore: number;
  /** 向量余弦（未接入向量时为 0）。 */
  vectorScore: number;
}

export type VectorLookup = (id: string) => Float32Array | null;

export interface RetrievalTokenCacheEntry {
  /** 内容+标签的指纹；只有指纹一致才复用 token，避免陈旧缓存。 */
  source: string;
  tokens: readonly string[];
}

/** 只读缓存接口：让调用方把 tokenize 结果跨查询复用。 */
export interface RetrievalTokenCache {
  get(id: string): RetrievalTokenCacheEntry | undefined;
  set(id: string, entry: RetrievalTokenCacheEntry): unknown;
}

export interface RetrieveMemoryInput {
  query: string;
  docs: readonly RetrievalDoc[];
  /** 向量表查询（缺省 = 无向量阶段，退化为关键词检索）。 */
  vectors?: VectorLookup;
  /** 查询向量（缺省 = hashEmbedding(query)）。 */
  queryVector?: Float32Array;
  /** 向量维度（缺省取 queryVector/首条向量，再缺省 DEFAULT_EMBED_DIM）。 */
  vectorDim?: number;
  candidateLimit?: number;
  limit?: number;
  vectorWeight?: number;
  minScore?: number;
  /** 召回门控：true=先过 shouldRecall（recallPrompt 语义）；显式搜索默认 false。 */
  gate?: boolean;
  lastTaskType?: string;
  now?: number;
  /** 可选：同一批记忆在连续查询间复用 token（记忆服务持有，按 id+source 校验）。 */
  tokenCache?: RetrievalTokenCache;
}

/** 文档有效值（与 fiveGate.effectiveValue 公式一致；缺省 confidence=0.8/repeated=0）。 */
export function docEffectiveValue(doc: RetrievalDoc, nowMs: number): number {
  const days = Math.max(0, (nowMs - (doc.lastAccessed ?? nowMs)) / DAY_MS);
  const decay = Math.exp(-days / 5.0);
  const importanceNorm = Math.max(1, Math.min(10, doc.importance ?? 5)) / 10;
  const confidence = Math.max(0, Math.min(1, doc.confidence ?? 0.8));
  const repeated = Math.max(0, doc.repeated ?? 0);
  return decay * importanceNorm * confidence * (1 + repeated);
}

/** ① 召回门控阶段（暴露出来便于测试/诊断）。 */
export function stageGate(query: string, lastTaskType?: string): { hit: boolean; signals: string[] } {
  return shouldRecall(query, lastTaskType);
}

/**
 * ② 关键词候选阶段：简化 BM25 + top-limit。
 * 单遍扫描所有文档：只统计 query token 的 tf 与 df（内存 O(候选数×queryToken)，不建全量倒排），
 * 因此对 ≤几千条的记忆库足够便宜；10 万级规模由基准脚本的倒排索引版本来评估（见报告）。
 */
export function keywordCandidates(
  docs: readonly RetrievalDoc[],
  query: string,
  limit: number = DEFAULT_CANDIDATE_LIMIT,
  tokenCache?: RetrievalTokenCache,
): KeywordCandidate[] {
  const queryTokens = tokenize(query);
  const candidateLimit = Math.max(1, Math.floor(limit));
  if (queryTokens.length === 0) {
    // 查询无可分词内容（纯标点等）：保留旧 search 行为——按有效值候选，不做关键词过滤
    return docs.slice(0, candidateLimit).map((doc) => ({ doc, bm25: 0, jaccard: 0 }));
  }
  if (docs.length === 0) return [];
  const uniqueQueryTokens = [...new Set(queryTokens)];
  const tokenIndex = new Map<string, number>();
  for (let i = 0; i < uniqueQueryTokens.length; i++) tokenIndex.set(uniqueQueryTokens[i], i);

  const perDocTf: Uint16Array[] = [];
  const perDocLen: number[] = [];
  const df = new Uint32Array(uniqueQueryTokens.length);
  for (const doc of docs) {
    // tokenize 是候选阶段的固定成本；同一记忆连续查询时复用，内容/标签变了才重算。
    const source = `${doc.content} ${(doc.tags ?? []).join(" ")}`;
    const cached = tokenCache?.get(doc.id);
    const tokens = cached && cached.source === source ? cached.tokens : tokenize(source);
    if (tokenCache && (!cached || cached.source !== source)) tokenCache.set(doc.id, { source, tokens });
    const tf = new Uint16Array(uniqueQueryTokens.length);
    for (const token of tokens) {
      const index = tokenIndex.get(token);
      if (index !== undefined && tf[index] < 0xffff) tf[index] += 1;
    }
    for (let i = 0; i < tf.length; i++) if (tf[i] > 0) df[i] += 1;
    perDocTf.push(tf);
    perDocLen.push(tokens.length);
  }

  const docCount = docs.length;
  const totalLen = perDocLen.reduce((sum, len) => sum + len, 0);
  const avgDocLen = totalLen > 0 ? totalLen / docCount : 1;
  const idf = new Float64Array(uniqueQueryTokens.length);
  for (let i = 0; i < idf.length; i++) {
    const dfi = df[i];
    idf[i] = Math.log(1 + (docCount - dfi + 0.5) / (dfi + 0.5));
  }

  const scored: { index: number; bm25: number }[] = [];
  for (let d = 0; d < docCount; d++) {
    const tf = perDocTf[d];
    const lenNorm = 1 - BM25_B + BM25_B * (perDocLen[d] / avgDocLen);
    let score = 0;
    for (let i = 0; i < tf.length; i++) {
      if (tf[i] === 0) continue;
      score += idf[i] * ((tf[i] * (BM25_K1 + 1)) / (tf[i] + BM25_K1 * lenNorm));
    }
    // 不做 score>0 过滤：显式搜索旧语义是「返回最相关的前 N 条（含弱相关）」，
    // 由第 ④ 阶段阈值（0.08）兜底；否则无共享词时会把非空库判成空结果（memory_search 行为回归）。
    scored.push({ index: d, bm25: score });
  }
  scored.sort((a, b) => b.bm25 - a.bm25);
  const k = candidateLimit;
  const candidates: KeywordCandidate[] = [];
  for (const item of scored.slice(0, k)) {
    const doc = docs[item.index];
    candidates.push({ doc, bm25: item.bm25, jaccard: jaccardCJK(query, doc.content) });
  }
  return candidates;
}

/** ③ 向量重排阶段：对候选补充余弦分（无向量/维度不符时记 0，fail-safe 不中断检索）。 */
export function vectorRerank(
  candidates: readonly KeywordCandidate[],
  queryVector: Float32Array | undefined,
  vectors: VectorLookup | undefined,
): (KeywordCandidate & { vectorScore: number })[] {
  if (!queryVector || !vectors) {
    return candidates.map((candidate) => ({ ...candidate, vectorScore: 0 }));
  }
  return candidates.map((candidate) => {
    const vector = vectors(candidate.doc.id);
    let vectorScore = 0;
    if (vector && vector.length === queryVector.length) {
      vectorScore = cosineSimilarity(queryVector, vector);
    }
    return { ...candidate, vectorScore };
  });
}

/** ④ 融合 + 阈值 + limit。 */
export function fuseCandidates(
  candidates: readonly (KeywordCandidate & { vectorScore: number })[],
  opts: { query: string; limit?: number; vectorWeight?: number; minScore?: number; now?: number },
): RetrievalHit[] {
  const limit = Math.max(1, Math.floor(opts.limit ?? DEFAULT_RETRIEVAL_LIMIT));
  const vectorWeight = Math.max(0, opts.vectorWeight ?? DEFAULT_VECTOR_WEIGHT);
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
  const nowMs = opts.now ?? Date.now();
  const hits: RetrievalHit[] = [];
  for (const candidate of candidates) {
    const tagBonus = (candidate.doc.tags ?? []).some((tag) => tag.length > 0 && opts.query.includes(tag))
      ? TAG_BONUS
      : 0;
    const keywordScore = candidate.jaccard + tagBonus;
    const vectorContribution = vectorWeight * Math.max(0, candidate.vectorScore);
    const score =
      docEffectiveValue(candidate.doc, nowMs) * (SIMILARITY_BASE + candidate.jaccard + vectorContribution) +
      tagBonus;
    if (score > minScore) {
      hits.push({
        id: candidate.doc.id,
        score,
        keywordScore,
        vectorScore: candidate.vectorScore,
      });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

/**
 * 完整四阶段检索。显式搜索（memory_search）传 gate=false；自动召回注入传 gate=true。
 */
export function retrieveMemory(input: RetrieveMemoryInput): RetrievalHit[] {
  // ① 门控
  if (input.gate && !stageGate(input.query, input.lastTaskType).hit) return [];
  // ② 关键词候选
  const candidates = keywordCandidates(
    input.docs,
    input.query,
    input.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT,
    input.tokenCache,
  );
  if (candidates.length === 0) return [];
  // ③ 向量重排
  const dim = input.vectorDim ?? input.queryVector?.length ?? DEFAULT_EMBED_DIM;
  const queryVector = input.queryVector ?? (input.vectors ? hashEmbedding(input.query, dim) : undefined);
  const reranked = vectorRerank(candidates, queryVector, input.vectors);
  // ④ 融合 + 阈值 + limit
  return fuseCandidates(reranked, {
    query: input.query,
    limit: input.limit,
    vectorWeight: input.vectorWeight,
    minScore: input.minScore,
    now: input.now,
  });
}
