/**
 * 四阶段检索（ADR-0007 W5）：召回门控 → BM25 关键词候选 → 向量重排 → 阈值 + limit。
 * 为什么这些断言：四阶段是「纯 TS 混合检索」的核心；排序公式还必须与旧 store.recall
 * 语义兼容（否则 memory_search 排序/结果会回归）。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MIN_SCORE,
  docEffectiveValue,
  fuseCandidates,
  keywordCandidates,
  retrieveMemory,
  stageGate,
  vectorRerank,
  type RetrievalDoc,
} from "../../packages/core/src/memory/retrieval.ts";
import { FlatVectorIndex, hashEmbedding } from "../../packages/core/src/memory/vector.ts";

const NOW = 1_780_000_000_000; // 固定时间，避免衰减导致断言漂移
const DAY = 86_400_000;

function doc(id: string, content: string, extra: Partial<RetrievalDoc> = {}): RetrievalDoc {
  return { id, content, importance: 5, lastAccessed: NOW, ...extra };
}

describe("① 召回门控阶段", () => {
  it("无信号 → hit=false；过去时/指代 → hit=true", () => {
    expect(stageGate("你好").hit).toBe(false);
    expect(stageGate("上次说的那个方案").hit).toBe(true);
    expect(stageGate("把它改成表格").hit).toBe(true);
  });
});

describe("② 关键词候选（BM25 简化）", () => {
  const docs = [
    doc("rare", "量子引力波的观测记录归档", { tags: ["物理"] }),
    doc("common", "用户偏好深色主题界面", { tags: ["偏好"] }),
    doc("middle", "记忆系统写入前需要去重", { tags: ["memory"] }),
  ];

  it("BM25 让包含稀有词（IDF 高）的文档排前", () => {
    const candidates = keywordCandidates(docs, "量子引力波", 10);
    expect(candidates[0].doc.id).toBe("rare");
    expect(candidates[0].bm25).toBeGreaterThan(0);
    expect(candidates[0].jaccard).toBeGreaterThan(0);
  });

  it("candidateLimit 生效；候选携带 jaccard（与五闸同口径）", () => {
    const candidates = keywordCandidates(docs, "记忆系统 去重", 1);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].doc.id).toBe("middle");
    expect(candidates[0].jaccard).toBeGreaterThan(0);
  });

  it("tokenCache 复用未变文档的分词；内容变化时按 source 失效重算", () => {
    const cache = new Map<string, { source: string; tokens: readonly string[] }>();
    keywordCandidates(docs, "量子引力波", 10, cache);
    const cachedTokens = cache.get("rare")?.tokens;
    expect(cachedTokens).toBeDefined();

    const second = keywordCandidates(docs, "深色主题", 10, cache);
    expect(second.map((c) => c.doc.id)).toEqual(keywordCandidates(docs, "深色主题", 10).map((c) => c.doc.id));
    expect(cache.get("rare")?.tokens).toBe(cachedTokens); // 未变文档不重新分词

    const changed = [doc("rare", "量子引力波的新观测记录", { tags: ["物理"] }), ...docs.slice(1)];
    keywordCandidates(changed, "观测", 10, cache);
    expect(cache.get("rare")?.source).toContain("新观测");
  });

  it("查询无可分词内容 → 按文档顺序回退（保持旧 search 的弱相关返回语义）", () => {
    const candidates = keywordCandidates(docs, "。。。", 2);
    expect(candidates).toHaveLength(2);
    expect(candidates.every((candidate) => candidate.bm25 === 0)).toBe(true);
  });
});

describe("③ 向量重排阶段", () => {
  it("向量重排补充余弦分；无向量时记 0（fail-safe，不中断检索）", () => {
    const candidates = keywordCandidates([doc("a", "记忆系统"), doc("b", "记忆系统")], "记忆系统", 10);
    const reranked = vectorRerank(candidates, new Float32Array([1, 0]), (id) =>
      id === "b" ? new Float32Array([1, 0]) : new Float32Array([0, 1]),
    );
    const b = reranked.find((item) => item.doc.id === "b")!;
    const a = reranked.find((item) => item.doc.id === "a")!;
    expect(b.vectorScore).toBeCloseTo(1, 5);
    expect(a.vectorScore).toBeCloseTo(0, 5);

    const withoutVectors = vectorRerank(candidates, undefined, undefined);
    expect(withoutVectors.every((item) => item.vectorScore === 0)).toBe(true);
  });
});

describe("④ 融合 + 阈值 + limit", () => {
  it("向量分参与融合排序（vectorWeight=1 时余弦决定顺序）", () => {
    const candidates = keywordCandidates([doc("a", "记忆系统"), doc("b", "记忆系统")], "记忆系统", 10);
    const reranked = vectorRerank(candidates, new Float32Array([1, 0]), (id) =>
      id === "b" ? new Float32Array([1, 0]) : new Float32Array([0, 1]),
    );
    const hits = fuseCandidates(reranked, { query: "记忆系统", limit: 5, vectorWeight: 1, minScore: 0, now: NOW });
    expect(hits[0].id).toBe("b");
    expect(hits[0].score).toBeGreaterThanOrEqual(hits[1].score);
  });

  it("阈值过滤 + limit 截断；无关键词命中时按有效值排序（兼容旧行为）", () => {
    const candidates = keywordCandidates(
      [doc("high", "完全无关的内容甲", { importance: 10 }), doc("low", "完全无关的内容乙", { importance: 1 })],
      "毫不相干查询",
      10,
    ).map((candidate) => ({ ...candidate, vectorScore: 0 }));
    const hits = fuseCandidates(candidates, { query: "毫不相干查询", limit: 1, now: NOW });
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe("high"); // 旧公式：score = 有效值×(0.3+相似度)
    // 高阈值 → 全部过滤
    const filtered = fuseCandidates(candidates, { query: "毫不相干查询", limit: 10, minScore: 10, now: NOW });
    expect(filtered).toEqual([]);
    expect(DEFAULT_MIN_SCORE).toBe(0.08);
  });

  it("docEffectiveValue：新近高重要 > 陈旧低重要；旧数据缺省字段按默认值", () => {
    const fresh = docEffectiveValue(doc("fresh", "x", { importance: 10, lastAccessed: NOW }), NOW);
    const old = docEffectiveValue(doc("old", "y", { importance: 2, lastAccessed: NOW - 90 * DAY }), NOW);
    expect(fresh).toBeGreaterThan(old);
    const legacy = docEffectiveValue({ id: "legacy", content: "z" }, NOW);
    expect(legacy).toBeGreaterThan(0);
  });
});

describe("retrieveMemory 完整四阶段", () => {
  const facts: RetrievalDoc[] = [
    doc("pref", "用户偏好深色主题界面，回复用中文", { importance: 8 }),
    doc("deploy", "部署前必须先跑契约检查", { importance: 9 }),
    doc("memory", "记忆系统写入前需要去重与合并", { importance: 10 }),
  ];
  const index = new FlatVectorIndex(256, 8);
  for (const fact of facts) index.upsert(fact.id, hashEmbedding(fact.content, 256));
  const lookup = (id: string) => index.get(id);

  it("显式检索（gate=false）：无门控信号也返回结果，相关条目排前", () => {
    const hits = retrieveMemory({
      query: "深色主题界面",
      docs: facts,
      vectors: lookup,
      vectorDim: 256,
      limit: 3,
      now: NOW,
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].id).toBe("pref");
    expect(hits[0].keywordScore).toBeGreaterThan(0);
    expect(hits[0].vectorScore).toBeGreaterThan(0);
  });

  it("自动召回（gate=true）：无信号返回空；有信号返回结果", () => {
    expect(
      retrieveMemory({ query: "你好", docs: facts, vectors: lookup, vectorDim: 256, gate: true, now: NOW }),
    ).toEqual([]);
    expect(
      retrieveMemory({ query: "上次说的那个深色主题", docs: facts, vectors: lookup, vectorDim: 256, gate: true, now: NOW })
        .length,
    ).toBeGreaterThan(0);
  });

  it("空库 / limit 收敛 / 无向量时退化为关键词检索", () => {
    expect(retrieveMemory({ query: "任何内容", docs: [], limit: 5 })).toEqual([]);
    const hits = retrieveMemory({ query: "记忆系统", docs: facts, limit: 1, now: NOW });
    expect(hits).toHaveLength(1);
    expect(hits[0].vectorScore).toBe(0); // 未传 vectors → 无向量阶段
  });
});
