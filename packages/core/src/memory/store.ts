/**
 * 记忆库（纯逻辑）：在五闸之上做增删改查与检索。
 *
 * 设计依据（各家权威做法的交集）：
 *  - MemGPT（Packer et al. 2023）：分层记忆（工作/情景/语义）+ 显式读写与容量管理；
 *  - Mem0：写入前先「抽取候选 → 与已有记忆比对 → 更新/合并/新增」（不是无脑追加）；
 *  - Anthropic 记忆工具文档：记忆是外部持久化存储，检索按需注入，不塞满上下文；
 *  - 记忆类型（semantic / episodic / procedural）：本库用 category + layer 表达语义与情景两类，
 *    procedural（技能/流程）暂以 category 区分（导入技能库后单独分层）。
 *
 * 本模块零 node 依赖：文件读写由壳层负责，这里只处理状态与规则。
 */
import { createFact, type MemoryFact } from "./fact.js";
import {
  gateDedupe,
  gateMerge,
  gateLink,
  gateCapacity,
  effectiveValue,
  jaccardCJK,
  THRESHOLD_CAPACITY_MAX,
} from "./fiveGate.js";

export interface MemoryCandidate {
  content: string;
  category: string;
  tags?: string[];
  importance?: number;
  source?: string;
  layer?: MemoryFact["layer"];
}

export interface MemoryStats {
  total: number;
  active: number;
  archived: number;
  links: number;
  totalAccess: number;
  byCategory: Record<string, number>;
}

export interface MemoryStoreState {
  facts: MemoryFact[];
  /** 已归档条目单独存放（软归档：可恢复，不物理删除）。 */
  archived: MemoryFact[];
}

export class MemoryStore {
  private facts: MemoryFact[] = [];
  private archived: MemoryFact[] = [];
  private seq = 0;

  constructor(private opts: { capacity?: number; now?: () => number } = {}) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  snapshot(): MemoryStoreState {
    return { facts: [...this.facts], archived: [...this.archived] };
  }

  /** 从持久化状态恢复（文件损坏时由壳层保证传入空状态）。 */
  restore(state: Partially<MemoryStoreState>): void {
    this.facts = Array.isArray(state?.facts) ? state.facts : [];
    this.archived = Array.isArray(state?.archived) ? state.archived : [];
    this.seq = this.facts.length + this.archived.length;
  }

  size(): number {
    return this.facts.length;
  }

  /**
   * 写入候选（Mem0 式「抽取后写入」）：
   * ① 去重命中 → 命中项 repeated+1、lastAccessed 刷新（不新增）；
   * ② 合并命中（无 tags 且高相似）→ 合并内容与标签、记录 mergeTrail；
   * ③ 否则新增；④ 建链；⑤ 容量超限软归档。
   * 返回本次动作明细（供 UI/审计展示）。
   */
  write(candidates: MemoryCandidate[]): {
    added: MemoryFact[];
    merged: { into: string; content: string }[];
    deduped: { id: string; content: string }[];
    archived: string[];
    linked: number;
  } {
    const nowMs = this.now();
    const added: MemoryFact[] = [];
    const merged: { into: string; content: string }[] = [];
    const deduped: { id: string; content: string }[] = [];
    let linked = 0;

    for (const candidate of candidates) {
      const content = candidate.content.trim();
      if (!content) continue;
      const incoming = createFact({
        id: `mem-${++this.seq}-${nowMs.toString(36)}`,
        content,
        category: candidate.category,
        tags: candidate.tags ?? [],
        importance: candidate.importance ?? 5,
        lastAccessed: nowMs,
        source: candidate.source ?? "chat",
        layer: candidate.layer ?? "semantic",
      });

      // ① 去重
      const dedupe = gateDedupe(this.facts, incoming);
      if (dedupe.duplicate && dedupe.hit) {
        dedupe.hit.repeated += 1;
        dedupe.hit.lastAccessed = nowMs;
        dedupe.hit.confidence = Math.min(1, dedupe.hit.confidence + 0.05);
        deduped.push({ id: dedupe.hit.id, content: dedupe.hit.content });
        continue;
      }

      // ② 合并
      const merge = gateMerge(this.facts, incoming);
      if (merge.mergeInto) {
        const target = merge.mergeInto;
        target.content = `${target.content}；${incoming.content}`;
        target.lastAccessed = nowMs;
        target.repeated += 1;
        target.mergeTrail.push({ mergedAt: nowMs, reason: `相似度合并（${incoming.source}）` });
        merged.push({ into: target.id, content: incoming.content });
        continue;
      }

      // ③ 新增
      this.facts.push(incoming);
      added.push(incoming);

      // ④ 建链（与已有条目）
      const link = gateLink(this.facts.filter((f) => f.id !== incoming.id), incoming);
      linked += link.linked.length;
    }

    // ⑤ 容量治理（软归档，不物理删除）
    const cap = this.opts.capacity ?? THRESHOLD_CAPACITY_MAX;
    if (this.facts.length > cap) {
      const result = gateCapacity(this.facts, cap);
      this.facts = result.keep;
      for (const fact of result.archived) this.archived.push(fact);
    }

    return { added, merged, deduped, archived: this.archived.slice(-(added.length + 1)).map((f) => f.id), linked };
  }

  /** 手动新增（UI「新增记忆」入口）。 */
  add(input: MemoryCandidate): MemoryFact {
    const result = this.write([{ ...input, source: input.source ?? "manual" }]);
    return result.added[0] ?? this.facts[this.facts.length - 1];
  }

  update(id: string, patch: Partial<Pick<MemoryFact, "content" | "category" | "tags" | "importance">>): MemoryFact | null {
    const fact = this.facts.find((f) => f.id === id);
    if (!fact) return null;
    if (patch.content !== undefined) fact.content = patch.content.trim().slice(0, 5000);
    if (patch.category !== undefined) fact.category = patch.category;
    if (patch.tags !== undefined) fact.tags = patch.tags;
    if (patch.importance !== undefined) fact.importance = Math.max(1, Math.min(10, patch.importance));
    fact.lastAccessed = this.now();
    return fact;
  }

  remove(id: string): boolean {
    const before = this.facts.length;
    this.facts = this.facts.filter((f) => f.id !== id);
    for (const fact of this.facts) {
      fact.links = fact.links.filter((l) => l !== id);
      fact.backlinks = fact.backlinks.filter((l) => l !== id);
    }
    return this.facts.length !== before;
  }

  clear(): void {
    this.facts = [];
    this.archived = [];
    this.seq = 0;
  }

  get(id: string): MemoryFact | null {
    return this.facts.find((f) => f.id === id) ?? this.archived.find((f) => f.id === id) ?? null;
  }

  list(opts: { includeArchived?: boolean; sortBy?: "updated" | "value" | "importance" } = {}): MemoryFact[] {
    const nowMs = this.now();
    const base = opts.includeArchived ? [...this.facts, ...this.archived] : [...this.facts];
    const sortBy = opts.sortBy ?? "updated";
    return base.sort((a, b) => {
      if (sortBy === "importance") return b.importance - a.importance;
      if (sortBy === "value") return effectiveValue(b, nowMs) - effectiveValue(a, nowMs);
      return b.lastAccessed - a.lastAccessed;
    });
  }

  /**
   * 召回：先用「召回门控」决定要不要检索（廉价字符串信号，见 recallGate），
   * 命中后按 effectiveValue（时间衰减×重要度×置信度×重复次数）排序取前 N 条。
   * 为什么不由调用方传入全量：记忆会增长，检索必须自带预算。
   */
  recall(query: string, limit = 6): { fact: MemoryFact; score: number }[] {
    const nowMs = this.now();
    const scored = this.facts.map((fact) => {
      const similarity = jaccardCJK(query, fact.content);
      const tagBonus = fact.tags.some((tag) => query.includes(tag)) ? 0.15 : 0;
      const score = effectiveValue(fact, nowMs) * (0.3 + similarity) + tagBonus;
      return { fact, score };
    });
    return scored
      .filter((item) => item.score > 0.08)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** 召回结果格式化为提示词片段（空 = 不注入）。 */
  recallPrompt(query: string, limit = 6): string {
    const hits = this.recall(query, limit);
    if (hits.length === 0) return "";
    const lines = hits.map(({ fact }) => `- [${fact.category}] ${fact.content}`);
    return `以下是过往会话中记住的相关信息（可能过时，按需使用）：\n${lines.join("\n")}`;
  }

  stats(): MemoryStats {
    const all = this.facts;
    const byCategory: Record<string, number> = {};
    for (const fact of all) byCategory[fact.category] = (byCategory[fact.category] ?? 0) + 1;
    return {
      total: all.length + this.archived.length,
      active: all.length,
      archived: this.archived.length,
      links: all.reduce((sum, f) => sum + f.links.length, 0),
      totalAccess: all.reduce((sum, f) => sum + f.accessCount, 0),
      byCategory,
    };
  }
}

type Partially<T> = { [K in keyof T]?: T[K] };
