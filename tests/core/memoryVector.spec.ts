/**
 * 向量索引（ADR-0007 W5）：deterministic hash embedding + FlatVectorIndex 的纯逻辑正确性。
 * 为什么这些断言：向量索引是「10 万条检索 P95 达标」的地基，增量 upsert/remove、维度校验、
 * 归一化与 topK 排序一旦错，基准数字就不可信；hash embedding 必须确定性可复现。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EMBED_DIM,
  FlatVectorIndex,
  cosineSimilarity,
  estimateVectorBytes,
  hashEmbedding,
  hashEmbeddings,
  l2Normalize,
  tokenize,
} from "../../packages/core/src/memory/vector.ts";

function norm(vector: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i];
  return Math.sqrt(sum);
}

describe("tokenize / hash embedding", () => {
  it("中文按单字+相邻双字、英文按词（长度 ≥2 小写）", () => {
    expect(tokenize("记忆系统")).toEqual(["记", "记忆", "忆", "忆系", "系", "系统", "统"]);
    expect(tokenize("Hello world 42")).toContain("hello");
    expect(tokenize("Hello world 42")).toContain("world");
    expect(tokenize("Hello world 42")).toContain("42");
  });

  it("hash embedding 确定性：同文本同向量、维度正确、L2 归一化", () => {
    const a = hashEmbedding("用户偏好深色主题");
    const b = hashEmbedding("用户偏好深色主题");
    expect(a.length).toBe(DEFAULT_EMBED_DIM);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(norm(a)).toBeCloseTo(1, 5);
    // 空文本 → 零向量（余弦返回 0，不产生 NaN）
    const empty = hashEmbedding("");
    expect(norm(empty)).toBe(0);
    expect(cosineSimilarity(empty, a)).toBe(0);
  });

  it("语义近的词法文本相似度更高（hash embedding 是词法向量）", () => {
    const base = hashEmbedding("记忆系统写入前需要去重");
    const similar = hashEmbedding("记忆系统写入前需要去重与合并");
    const unrelated = hashEmbedding("量子引力波观测记录");
    expect(cosineSimilarity(base, similar)).toBeGreaterThan(cosineSimilarity(base, unrelated));
    expect(cosineSimilarity(base, similar)).toBeGreaterThan(0.3);
  });

  it("批量 embedding 与单条一致；自定义维度生效", () => {
    const batch = hashEmbeddings(["记忆五闸", "工具循环"], 128);
    expect(batch).toHaveLength(2);
    expect(batch[0].length).toBe(128);
    expect(Array.from(batch[0])).toEqual(Array.from(hashEmbedding("记忆五闸", 128)));
    expect(() => hashEmbedding("x", 0)).toThrow(/维度/);
  });

  it("l2Normalize 原地归一化，零向量保持零", () => {
    const vector = new Float32Array([3, 4]);
    l2Normalize(vector);
    expect(vector[0]).toBeCloseTo(0.6, 6);
    expect(vector[1]).toBeCloseTo(0.8, 6);
    const zero = new Float32Array([0, 0]);
    l2Normalize(zero);
    expect(Array.from(zero)).toEqual([0, 0]);
  });

  it("cosineSimilarity：同向=1、反向=-1、正交=0、维度不一致抛错（fail-closed）", () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1, 0]))).toBeCloseTo(1, 6);
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([-1, 0]))).toBeCloseTo(-1, 6);
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0, 6);
    expect(() => cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1, 0, 0]))).toThrow(/维度不一致/);
  });

  it("estimateVectorBytes：count × dim × 4", () => {
    expect(estimateVectorBytes(100_000, 256)).toBe(100_000 * 256 * 4);
    expect(estimateVectorBytes(0, 256)).toBe(0);
  });
});

describe("FlatVectorIndex（增量/检索/内存）", () => {
  it("upsert + search：topK 按余弦降序、只返回存活条目", () => {
    const index = new FlatVectorIndex(4, 2);
    index.upsert("a", new Float32Array([1, 0, 0, 0]));
    index.upsert("b", new Float32Array([0.8, 0.2, 0, 0]));
    index.upsert("c", new Float32Array([0, 1, 0, 0]));
    expect(index.size).toBe(3);
    expect(index.dimension).toBe(4);

    const hits = index.search(new Float32Array([1, 0, 0, 0]), 2);
    expect(hits.map((hit) => hit.id)).toEqual(["a", "b"]);
    expect(hits[0].score).toBeCloseTo(1, 5);
    expect(hits[1].score).toBeLessThan(hits[0].score);

    // 覆盖面：topK > 存活数时只返回存活条目
    expect(index.search(new Float32Array([1, 0, 0, 0]), 10)).toHaveLength(3);
  });

  it("upsert 已存在 id → 原位覆盖（不重复计数）", () => {
    const index = new FlatVectorIndex(4, 2);
    index.upsert("a", new Float32Array([1, 0, 0, 0]));
    index.upsert("a", new Float32Array([0, 1, 0, 0]));
    expect(index.size).toBe(1);
    const hits = index.search(new Float32Array([0, 1, 0, 0]), 1);
    expect(hits[0].id).toBe("a");
    expect(hits[0].score).toBeCloseTo(1, 5);
  });

  it("remove：检索不再命中、幂等、墓碑可 compact 回收", () => {
    const index = new FlatVectorIndex(4, 2);
    index.upsert("a", new Float32Array([1, 0, 0, 0]));
    index.upsert("b", new Float32Array([0, 1, 0, 0]));
    expect(index.remove("a")).toBe(true);
    expect(index.remove("a")).toBe(false);
    expect(index.has("a")).toBe(false);
    expect(index.search(new Float32Array([1, 0, 0, 0]), 5).some((hit) => hit.id === "a")).toBe(false);
    expect(index.size).toBe(1);
    index.compact();
    expect(index.stats().tombstones).toBe(0);
    expect(index.stats().size).toBe(1);
  });

  it("get 返回副本（外部修改不污染索引）；clear 清空", () => {
    const index = new FlatVectorIndex(4, 2);
    index.upsert("a", new Float32Array([1, 0, 0, 0]));
    const vector = index.get("a")!;
    vector[0] = 123;
    const again = index.get("a")!;
    expect(again[0]).toBeCloseTo(1, 5);
    expect(index.get("missing")).toBeNull();

    index.clear();
    expect(index.size).toBe(0);
    expect(index.search(new Float32Array([1, 0, 0, 0]), 5)).toEqual([]);
  });

  it("维度校验 fail-closed：upsert/search 维度不匹配抛错", () => {
    const index = new FlatVectorIndex(4, 2);
    expect(() => index.upsert("bad", new Float32Array([1, 2]))).toThrow(/维度不匹配/);
    index.upsert("a", new Float32Array([1, 0, 0, 0]));
    expect(() => index.search(new Float32Array([1, 0]), 1)).toThrow(/查询向量维度不匹配/);
  });

  it("memoryBytes：随容量增长且 ≥ 向量原始字节", () => {
    const index = new FlatVectorIndex(8, 10);
    for (let i = 0; i < 10; i++) index.upsert(`id-${i}`, hashEmbedding(`记忆条目 ${i}`, 8));
    const stats = index.stats();
    expect(stats.size).toBe(10);
    expect(stats.dimension).toBe(8);
    expect(stats.memoryBytes).toBeGreaterThanOrEqual(10 * 8 * 4);
    expect(index.memoryBytes()).toBe(stats.memoryBytes);
  });

  it("容量自动扩容：写入超过初始容量仍全部可检索", () => {
    const index = new FlatVectorIndex(4, 2);
    for (let i = 0; i < 20; i++) {
      const vector = new Float32Array(4);
      vector[i % 4] = 1;
      index.upsert(`id-${i}`, vector);
    }
    expect(index.size).toBe(20);
    expect(index.capacitySize).toBeGreaterThanOrEqual(20);
    expect(index.search(new Float32Array([1, 0, 0, 0]), 10).length).toBe(10);
  });
});
