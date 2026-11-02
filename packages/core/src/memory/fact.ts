/**
 * MemoryFact 数据模型 — 五闸骨架的记忆实体。
 * 为什么用完整字段（layer / accessCount / confidence / mergeTrail）：
 * 五闸需要「有效值打分」和「软归档」两道操作，需要 timestamp + lastAccessed + importance + confidence + repeated
 * 综合计算；mergeTrail 记录合并历史，防止合并循环；layer 区分 working/episodic/semantic，决定召回优先级。
 */

export interface MemoryFact {
  id: string;
  content: string;
  category: string;
  tags: string[];
  importance: number; // 1..10
  timestamp: number;
  lastAccessed: number;
  links: string[];
  backlinks: string[];
  repeated: number;
  layer: "working" | "episodic" | "semantic";
  accessCount: number;
  confidence: number;
  source: string;
  status: "active" | string;
  archivedAt?: number;
  mergeTrail: { mergedAt: number; reason: string }[];
  /**
   * 归属 agent（可选、向后兼容：旧数据无此字段，读取时按 "loopsoar" 归一）。
   * 为什么需要：多 Agent 场景下「同一事实被不同 agent 各自记住」不应被去重/合并掉，
   * 而应保留各自条目并建立 crossAgentLinks 指针（见 fiveGate.gateCrossAgent / 第 5 闸）。
   */
  agentId?: string;
  /** 跨 agent 指针：同内容但属于其它 agent 的记忆 id（双向维护，不合并、不去重）。 */
  crossAgentLinks?: string[];
}

/** 工厂：从部分字段构造完整 MemoryFact（缺失字段给默认值，保持钢筋结构不塌）。 */
export function createFact(
  partial: Partial<MemoryFact> & { id: string; content: string; category: string }
): MemoryFact {
  const now = Date.now();
  return {
    id: partial.id,
    content: partial.content,
    category: partial.category,
    tags: partial.tags ?? [],
    importance: clamp(partial.importance ?? 5, 1, 10),
    timestamp: partial.timestamp ?? now,
    lastAccessed: partial.lastAccessed ?? now,
    links: partial.links ?? [],
    backlinks: partial.backlinks ?? [],
    repeated: partial.repeated ?? 0,
    layer: partial.layer ?? "working",
    accessCount: partial.accessCount ?? 0,
    confidence: clamp(partial.confidence ?? 0.8, 0, 1),
    source: partial.source ?? "t5-memory",
    status: partial.status ?? "active",
    archivedAt: partial.archivedAt,
    mergeTrail: partial.mergeTrail ?? [],
    // agentId 保持可选（旧数据/单 agent 场景不写字段，减小持久化体积）；
    // crossAgentLinks 恒有数组，读取方无需到处判空。
    agentId: partial.agentId,
    crossAgentLinks: partial.crossAgentLinks ?? [],
  };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
