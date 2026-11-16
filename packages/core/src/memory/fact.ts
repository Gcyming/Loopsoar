/**
 * MemoryFact 数据模型 — 五闸骨架的记忆实体。
 * 为什么用完整字段（layer / accessCount / confidence / mergeTrail）：
 * 五闸需要「有效值打分」和「软归档」两道操作，需要 timestamp + lastAccessed + importance + confidence + repeated
 * 综合计算；mergeTrail 记录合并历史，防止合并循环；layer 区分 working/episodic/semantic，决定召回优先级。
 */

/** 记忆归属与信任级别（D1）：决定注入时如何标注来源，以及能否跨工作区使用。 */
export type MemoryTrust = "user" | "agent" | "tool" | "web";

/** 溯源（D1）：这条记忆从哪来。旧数据缺失时按「用户手写」归一。 */
export interface MemoryProvenance {
  sessionId?: string;
  messageId?: string;
  toolCallId?: string;
  workspaceId?: string;
  url?: string;
  file?: string;
  trust?: MemoryTrust;
  capturedBy?: "auto" | "tool" | "user" | "consolidation";
}

/** 默认工作区 id：旧数据与「未绑定工作区」的会话都归到这里。 */
export const DEFAULT_WORKSPACE_ID = "default";

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
  /**
   * 归属工作区（D1）。读取端必须按它过滤：A 项目的记忆不得进入 B 项目的召回。
   * 旧数据没有该字段 → 读取时按 DEFAULT_WORKSPACE_ID 归一，写回时补齐。
   */
  workspaceId: string;
  /** 溯源：会话/消息/工具调用/URL/文件 + 信任级别（网页抓取的记忆不能与用户指令同权）。 */
  provenance?: MemoryProvenance;
  /** 生效起点（可选）：事实在「世界上」开始为真的时间；缺省取 timestamp。 */
  validFrom?: number;
  /** 失效时刻（D2）：被新事实取代时写入。不物理删除，检索默认排除，可显式查回。 */
  invalidatedAt?: number;
  /** 取代它的条目 id（双向之一：新 → 旧）。 */
  supersededBy?: string;
  /** 它取代的旧条目 id 列表（旧 → 新）。 */
  supersedes?: string[];
  /** 待裁决的冲突：无法判定新旧时两边都保留，检索时提示存在冲突版本。 */
  conflictsWith?: string[];
  /** 归档原因（D3）：容量替换 / 长期未用 / 手动清理；可查回时展示。 */
  archivedReason?: string;
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
    workspaceId: partial.workspaceId ?? DEFAULT_WORKSPACE_ID,
    provenance: partial.provenance,
    validFrom: partial.validFrom,
    invalidatedAt: partial.invalidatedAt,
    supersededBy: partial.supersededBy,
    supersedes: partial.supersedes ?? [],
    conflictsWith: partial.conflictsWith,
  };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
