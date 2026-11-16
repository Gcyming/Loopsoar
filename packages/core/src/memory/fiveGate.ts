/**
 * 五闸骨架 — 纯逻辑、零 node 依赖、零外部调用。
 * 为什么纯函数：本模块在 node/web 双端都可直接 import，避免 Electron / browser 依赖。
 * 阈值校准来源：ADR-0007 前置 + 真实语料实验；0.75/0.70/0.68 不可下调，否则会产生重复/漏链/过度合并。
 */

import { MemoryFact } from "./fact.js";

/** 已按真实语料校准：0.75 / 0.70 / 0.68 不可下调（ADR-0007 前置）。 */
export const THRESHOLD_DEDUPE = 0.75;
export const THRESHOLD_LINK = 0.70;
export const THRESHOLD_MERGE = 0.68;
export const THRESHOLD_CAPACITY_MAX = 2000;

/**
 * jaccardCJK — 中文按单字 + 相邻双字分片（不用空白分词），英文按词。
 * 为什么不用空白分词：中文无空格，空白分词会把「记忆五闸」切成单字或整串，丢失双字共现信号，
 * 导致相似度虚高/虚低。单字+双字分片保留局部共现，英文按词保留词级信号。
 */
export function jaccardCJK(a: string, b: string): number {
  const setA = tokenSet(a);
  const setB = tokenSet(b);
  let inter = 0;
  for (const t of setA) {
    if (setB.has(t)) inter++;
  }
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

function tokenSet(s: string): Set<string> {
  const set = new Set<string>();
  // CJK 部分：单字 + 相邻双字（不按空白）
  const cjkChars = s.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? [];
  for (let i = 0; i < cjkChars.length; i++) {
    const ch = cjkChars[i];
    if (ch) set.add(ch);
    if (i + 1 < cjkChars.length) {
      const pair = ch + cjkChars[i + 1];
      if (pair) set.add(pair);
    }
  }
  // 英文部分：按词（alphabetic 序列，长度 >= 2，转小写）
  const words = s.split(/[^a-zA-Z]+/).filter((w) => w.length >= 2);
  for (const w of words) {
    set.add(w.toLowerCase());
  }
  return set;
}

/**
 * gateDedupe — 重复检测（命中则调用方 repeated+1，不新增）。
 * 对比 content 相似度；命中返回 hit 供调用方执行 repeated++。
 */
export function gateDedupe(
  existing: MemoryFact[],
  incoming: MemoryFact,
  threshold = THRESHOLD_DEDUPE
): { duplicate: boolean; hit?: MemoryFact } {
  for (const f of existing) {
    const sim = jaccardCJK(incoming.content, f.content);
    if (sim >= threshold) {
      return { duplicate: true, hit: f };
    }
  }
  return { duplicate: false };
}

/**
 * gateMerge — 无 tags 且相似度 > 0.68 → 合并；带 tags 不参与合并。
 * 为什么带 tags 不合并：tags 是分类标签，合并会丢失分类边界，导致语义混合。
 */
export function gateMerge(
  existing: MemoryFact[],
  incoming: MemoryFact,
  threshold = THRESHOLD_MERGE
): { mergeInto?: MemoryFact } {
  if (incoming.tags.length > 0) return {};
  for (const f of existing) {
    if (f.tags.length > 0) continue; // 只有无 tags 的参与合并
    const sim = jaccardCJK(incoming.content, f.content);
    if (sim > threshold) {
      return { mergeInto: f };
    }
  }
  return {};
}

/**
 * gateLink — tags 交集或相似度 > 0.70 → 建双向 links/backlinks。
 * 为什么双向：记忆图是无向关联（A 关联 B ⇔ B 关联 A），否则召回时只走单向会漏链。
 */
export function gateLink(
  existing: MemoryFact[],
  incoming: MemoryFact,
  threshold = THRESHOLD_LINK
): { linked: string[] } {
  const linked: string[] = [];
  for (const f of existing) {
    const tagOverlap = f.tags.some((t) => incoming.tags.includes(t));
    const sim = jaccardCJK(incoming.content, f.content);
    if (tagOverlap || sim > threshold) {
      linked.push(f.id);
      // 建双向 links / backlinks（纯对象操作，无外部依赖）
      if (!f.links.includes(incoming.id)) f.links.push(incoming.id);
      if (!f.backlinks.includes(incoming.id)) f.backlinks.push(incoming.id);
      if (!incoming.links.includes(f.id)) incoming.links.push(f.id);
      if (!incoming.backlinks.includes(f.id)) incoming.backlinks.push(f.id);
    }
  }
  return { linked };
}

/**
 * 第 5 闸：跨 agent 指针。
 * 同内容（相似度 ≥ 去重阈值）但归属不同 agent → 不合并、不去重，而是双向建立 crossAgentLinks 指针。
 * 为什么不能合并：合并会抹掉「谁记住的」这一等身份信息（影响权限/人格隔离/召回过滤）；
 * 指针既避免正文重复堆叠，又保留各自归属，召回时可按 agent 维度展开关联条目。
 */
export function gateCrossAgent(
  existing: MemoryFact[],
  incoming: MemoryFact,
  agentId: string = DEFAULT_AGENT_ID,
  threshold = THRESHOLD_DEDUPE
): { crossAgent: boolean; pointers: MemoryFact[] } {
  const incomingAgent = normalAgent(agentId);
  const pointers: MemoryFact[] = [];
  for (const fact of existing) {
    if (agentOf(fact) === incomingAgent) continue; // 同 agent 交给去重/合并闸处理
    if (jaccardCJK(incoming.content, fact.content) >= threshold) {
      pointers.push(fact);
    }
  }
  return { crossAgent: pointers.length > 0, pointers };
}

/** 默认 agent 归属（单 Agent / 旧数据归一后的身份）。 */
export const DEFAULT_AGENT_ID = "loopsoar";

/** 归一化 fact 的 agentId：旧数据（无字段/空串）视为默认 agent，保证向后兼容。 */
export function agentOf(fact: MemoryFact): string {
  return normalAgent(fact.agentId);
}

function normalAgent(agentId: string | undefined): string {
  const value = typeof agentId === "string" ? agentId.trim() : "";
  return value.length > 0 ? value : DEFAULT_AGENT_ID;
}

/**
 * effectiveWeight — 时间衰减 τ=5.0 + 重要性归一化。
 * 为什么 (1 + 0)：相似度项由调用方在外部加（例如与参照记忆的 jaccard），
 * 本函数只负责时间/重要性维度，避免把相似度混入基础权重（职责分离）。
 */
export function effectiveWeight(fact: MemoryFact, nowMs: number): number {
  const msPerDay = 1000 * 60 * 60 * 24;
  const daysSinceAccess = Math.max(0, (nowMs - fact.lastAccessed) / msPerDay);
  const decay = Math.exp(-daysSinceAccess / 5.0);
  const importanceNorm = Math.max(1, Math.min(10, fact.importance)) / 10;
  return decay * importanceNorm * (1 + 0); // 相似度项由调用方加
}

/**
 * effectiveValue = effectiveWeight * confidence * (1 + repeated) * usageBoost。
 * D3：真实使用次数做温和加成（对数，封顶 +50%），避免爆款通吃；只由显式检索命中累加。
 */
export function effectiveValue(fact: MemoryFact, nowMs: number): number {
  const usageBoost = 1 + Math.min(0.5, 0.1 * Math.log1p(Math.max(0, fact.accessCount)));
  return effectiveWeight(fact, nowMs) * fact.confidence * (1 + fact.repeated) * usageBoost;
}

/**
 * gateCapacity — 超限时按 effectiveValue 升序软归档，绝不物理删除。
 * 为什么软归档（status=archived:<category> 而非删除）：记忆可被恢复，且 audit 需要保留历史记录。
 */
export function gateCapacity(
  facts: MemoryFact[],
  max = THRESHOLD_CAPACITY_MAX
): { archived: MemoryFact[]; keep: MemoryFact[] } {
  if (facts.length <= max) {
    return { archived: [], keep: facts.slice() };
  }
  const nowMs = Date.now();
  const sorted = facts.slice().sort((a, b) => effectiveValue(a, nowMs) - effectiveValue(b, nowMs));
  const toArchive = sorted.length - max;
  const archived = sorted.slice(0, toArchive);
  const keep = sorted.slice(toArchive);
  for (const f of archived) {
    f.status = `archived:${f.category}`;
    f.archivedAt = nowMs;
  }
  return { archived, keep };
}
