/**
 * 向量索引（纯 TS / 零依赖）：flat Float32Array 存储 + 余弦检索 + 确定性 hash embedding 兜底。
 *
 * 为什么是 flat 暴力检索而不是 sqlite-vec / LanceDB：
 *   · 本仓 v1 不允许为此新增原生依赖（better-sqlite3/sqlite-vec 需 Electron ABI 重编译与联网安装，
 *     按 ADR-0007 留到打包阶段裁决）；
 *   · 10 万条 × 256 维 = 102.4MB 连续 float 存储，单查询暴力余弦在 Node 里是 10ms 级
 *     （实测见 docs/research/memory-bench-ADR-0007.md），先满足「10 万条 P95 ≤ 50ms」再谈 ANN；
 *   · 接口保持可替换：后续接 sqlite-vec 只换实现，不改调用方（retrieval.ts / memoryService.ts）。
 *
 * 为什么 hash embedding 兜底：llama-server（BGE-M3, 127.0.0.1:8991）不可用时仍需可运行、
 * 可测试、可基准的向量能力；hash embedding 用 token 哈希 + 签名桶（hashing trick）做「词法向量」，
 * 它能反映 token 共现（检索质量明显弱于 BGE-M3 语义向量，报告中会明确标注这一点，不冒充语义检索）。
 *
 * 本文件刻意零 import（可被 `node scripts/memory-bench.mjs` 直接以 .ts 形式导入跑真实基准），
 * 且只使用可擦除的 TS 语法（无 enum / namespace / 构造参数属性）。
 */

/** 默认向量维度（256 维在 10 万条下约 102MB；384/768 的收益需真实 BGE-M3 才能验证）。 */
export const DEFAULT_EMBED_DIM = 256;

/** token 哈希（FNV-1a 32bit）：同一 token 恒同值，供 hash embedding 与基准脚本的关键词索引共用。 */
export function hashToken(token: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * 检索/嵌入统一分词：中文按「单字 + 相邻双字」，英文/数字按词（长度 ≥ 2，小写）。
 * 为什么不用空白分词：中文无空格，空白分词会丢失双字共现信号（与 fiveGate.jaccardCJK 同语义）；
 * 为什么保留重复 token：embedding 侧需要词频权重（tf），BM25 侧需要 tf。
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const cjkRuns = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g) ?? [];
  for (const run of cjkRuns) {
    for (let i = 0; i < run.length; i++) {
      tokens.push(run[i]);
      if (i + 1 < run.length) tokens.push(run.slice(i, i + 2));
    }
  }
  for (const word of text.split(/[^a-zA-Z0-9]+/)) {
    if (word.length >= 2) tokens.push(word.toLowerCase());
  }
  return tokens;
}

/** 原地 L2 归一化（零向量保持零），返回同一引用便于链式使用。 */
export function l2Normalize(vector: Float32Array): Float32Array {
  let normSq = 0;
  for (let i = 0; i < vector.length; i++) normSq += vector[i] * vector[i];
  if (normSq === 0) return vector;
  const inv = 1 / Math.sqrt(normSq);
  for (let i = 0; i < vector.length; i++) vector[i] *= inv;
  return vector;
}

function normalizedCopy(vector: Float32Array): Float32Array {
  const copy = new Float32Array(vector.length);
  copy.set(vector);
  return l2Normalize(copy);
}

/**
 * 确定性 hash embedding：token 哈希 → 桶下标，第二哈希决定符号，tf 权重取 1+log(tf)。
 * 同一文本永远得到同一向量（无随机种子），因此可持久化、可跨进程复现、可基准。
 */
export function hashEmbedding(text: string, dim: number = DEFAULT_EMBED_DIM): Float32Array {
  if (!Number.isInteger(dim) || dim <= 0) throw new Error(`向量维度必须是正整数，实际 ${dim}`);
  const vector = new Float32Array(dim);
  const tokens = tokenize(text);
  if (tokens.length === 0) return vector;
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  for (const [token, count] of counts) {
    const bucket = hashToken(token) % dim;
    const sign = (hashToken(token, 0x9e3779b1) & 1) === 0 ? 1 : -1;
    // 次线性 TF：避免长文本被高频词（「的/是」类 token）主导方向
    vector[bucket] += sign * (1 + Math.log(count));
  }
  return l2Normalize(vector);
}

/** 余弦相似度（通用实现，不要求输入已归一化；维度不一致直接抛错，fail-closed 不猜）。 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`向量维度不一致：${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** 只读命中结果。 */
export interface VectorSearchHit {
  id: string;
  score: number;
}

/** 索引统计（诊断/基准报告用）。 */
export interface VectorIndexStats {
  size: number;
  capacity: number;
  tombstones: number;
  dimension: number;
  memoryBytes: number;
}

/**
 * flat Float32Array 向量索引：
 *   · upsert/remove 增量维护（O(1) 写入；remove 打墓碑，墓碑过多自动 compact）；
 *   · 向量按「槽位 × 维度」连续存放，暴力余弦检索对 CPU cache 友好；
 *   · 存储的向量统一归一化 → 检索退化为点积（少一次 sqrt）。
 */
export class FlatVectorIndex {
  private dim: number;
  private capacity: number;
  private vectors: Float32Array;
  private slots: (string | null)[];
  private idToSlot: Map<string, number>;
  private liveCount: number;
  private tombstoneCount: number;
  /** 已使用槽位高水位（live + tombstones；compact 后回落）。 */
  private usedSlots: number;

  constructor(dim: number = DEFAULT_EMBED_DIM, initialCapacity = 64) {
    if (!Number.isInteger(dim) || dim <= 0) throw new Error(`向量维度必须是正整数，实际 ${dim}`);
    this.dim = dim;
    this.capacity = Math.max(1, Math.floor(initialCapacity));
    this.vectors = new Float32Array(this.capacity * dim);
    this.slots = new Array<string | null>(this.capacity).fill(null);
    this.idToSlot = new Map<string, number>();
    this.liveCount = 0;
    this.tombstoneCount = 0;
    this.usedSlots = 0;
  }

  get size(): number {
    return this.liveCount;
  }

  get dimension(): number {
    return this.dim;
  }

  get capacitySize(): number {
    return this.capacity;
  }

  has(id: string): boolean {
    return this.idToSlot.has(id);
  }

  /** 读取向量副本（外部修改不影响索引）；不存在返回 null。 */
  get(id: string): Float32Array | null {
    const slot = this.idToSlot.get(id);
    if (slot === undefined) return null;
    return this.vectors.slice(slot * this.dim, (slot + 1) * this.dim);
  }

  /** 增量写入/覆盖：已存在则原位更新，否则追加（必要时 compact/grow）。 */
  upsert(id: string, vector: Float32Array): void {
    if (!(vector instanceof Float32Array)) {
      throw new Error("向量必须是 Float32Array（避免 number[] 带来的隐式拷贝与精度问题）");
    }
    if (vector.length !== this.dim) {
      throw new Error(`向量维度不匹配：期望 ${this.dim}，实际 ${vector.length}`);
    }
    const normalized = normalizedCopy(vector);
    const existing = this.idToSlot.get(id);
    if (existing !== undefined) {
      this.vectors.set(normalized, existing * this.dim);
      return;
    }
    if (this.usedSlots >= this.capacity) {
      this.compact();
      if (this.usedSlots >= this.capacity) this.grow();
    }
    const slot = this.usedSlots;
    this.vectors.set(normalized, slot * this.dim);
    this.slots[slot] = id;
    this.idToSlot.set(id, slot);
    this.liveCount += 1;
    this.usedSlots += 1;
  }

  /** 删除：打墓碑（检索跳过），墓碑超过容量 1/4 时自动 compact 回收内存。 */
  remove(id: string): boolean {
    const slot = this.idToSlot.get(id);
    if (slot === undefined) return false;
    this.slots[slot] = null;
    this.idToSlot.delete(id);
    this.liveCount -= 1;
    this.tombstoneCount += 1;
    if (this.tombstoneCount > Math.max(64, this.capacity >> 2)) this.compact();
    return true;
  }

  clear(): void {
    this.vectors.fill(0);
    this.slots.fill(null);
    this.idToSlot.clear();
    this.liveCount = 0;
    this.tombstoneCount = 0;
    this.usedSlots = 0;
  }

  ids(): string[] {
    return [...this.idToSlot.keys()];
  }

  /**
   * 余弦 topK（降序）。query 无需预归一化；索引内向量已归一化，score 即余弦相似度。
   * 小 topK 用「有序插入」而不是全量 sort，避免 10 万级数组的额外分配。
   */
  search(query: Float32Array, topK = 10): VectorSearchHit[] {
    if (query.length !== this.dim) {
      throw new Error(`查询向量维度不匹配：期望 ${this.dim}，实际 ${query.length}`);
    }
    const k = Math.max(1, Math.floor(topK));
    let queryNormSq = 0;
    for (let i = 0; i < query.length; i++) queryNormSq += query[i] * query[i];
    if (queryNormSq === 0 || this.liveCount === 0) return [];
    const queryNorm = Math.sqrt(queryNormSq);

    const bestIds: string[] = [];
    const bestScores: number[] = [];
    const vectors = this.vectors;
    const dim = this.dim;
    for (let slot = 0; slot < this.usedSlots; slot++) {
      const id = this.slots[slot];
      if (!id) continue;
      const base = slot * dim;
      let dot = 0;
      for (let d = 0; d < dim; d++) dot += vectors[base + d] * query[d];
      const score = dot / queryNorm;
      // 有序插入：bestScores 保持降序且长度 ≤ k
      if (bestScores.length < k) {
        let pos = bestScores.length;
        while (pos > 0 && bestScores[pos - 1] < score) pos -= 1;
        bestScores.splice(pos, 0, score);
        bestIds.splice(pos, 0, id);
      } else if (score > bestScores[k - 1]) {
        let pos = k - 1;
        while (pos > 0 && bestScores[pos - 1] < score) pos -= 1;
        bestScores.splice(pos, 0, score);
        bestIds.splice(pos, 0, id);
        bestScores.length = k;
        bestIds.length = k;
      }
    }

    const hits: VectorSearchHit[] = [];
    for (let i = 0; i < bestIds.length; i++) hits.push({ id: bestIds[i], score: bestScores[i] });
    return hits;
  }

  /** 压缩墓碑（重建连续存储；容量不变，usedSlots 回落为存活数）。 */
  compact(): void {
    if (this.tombstoneCount === 0) return;
    const dim = this.dim;
    const nextVectors = new Float32Array(this.capacity * dim);
    const nextSlots: (string | null)[] = new Array<string | null>(this.capacity).fill(null);
    let write = 0;
    for (let slot = 0; slot < this.usedSlots; slot++) {
      const id = this.slots[slot];
      if (!id) continue;
      nextVectors.set(this.vectors.subarray(slot * dim, (slot + 1) * dim), write * dim);
      nextSlots[write] = id;
      this.idToSlot.set(id, write);
      write += 1;
    }
    this.vectors = nextVectors;
    this.slots = nextSlots;
    this.usedSlots = write;
    this.tombstoneCount = 0;
  }

  /** 内存占用估算（向量 + 槽位表 + id 映射；用于 10 万条基准的内存账）。 */
  memoryBytes(): number {
    let idBytes = 0;
    for (const id of this.idToSlot.keys()) idBytes += id.length * 2 + 48; // 字符串 + Map entry 近似开销
    return this.vectors.byteLength + this.slots.length * 8 + idBytes;
  }

  stats(): VectorIndexStats {
    return {
      size: this.liveCount,
      capacity: this.capacity,
      tombstones: this.tombstoneCount,
      dimension: this.dim,
      memoryBytes: this.memoryBytes(),
    };
  }

  private grow(): void {
    const nextCapacity = this.capacity * 2;
    const nextVectors = new Float32Array(nextCapacity * this.dim);
    nextVectors.set(this.vectors.subarray(0, this.usedSlots * this.dim));
    const nextSlots = this.slots.slice();
    while (nextSlots.length < nextCapacity) nextSlots.push(null);
    this.vectors = nextVectors;
    this.slots = nextSlots;
    this.capacity = nextCapacity;
  }
}
