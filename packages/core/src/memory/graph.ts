/**
 * 记忆图谱（纯逻辑）：把记忆 + 会话派生成「原点—分支—游离」的节点/边，并给出确定性布局。
 *
 * 设计见 docs/规划/记忆图谱-原点与三层.md：
 *  - origin = Loopsoar 本体，唯一中心；
 *  - L1 第一分支 = 会话（硬性），事实挂在所属会话周围；
 *  - L2 游离层 = 没有存活会话的记忆（旧数据 / 已删除会话留下的条目）；
 *  - L3 失真层 = M1 才启用（本模块先留空 band，保证后续迁移只改判定）。
 *
 * 零 node 依赖：节点/边/坐标都是纯数据，渲染与 IPC 各自消费。
 */
import type { MemoryFact } from "./fact.js";
import { DEFAULT_WORKSPACE_ID } from "./fact.js";
import type { UsageEvent } from "./store.js";

export type MemoryNodeKind = "origin" | "session" | "fact";

export interface MemoryGraphSession {
  sessionId: string;
  title?: string;
  workspaceId?: string | null;
  updatedAt?: number;
  createdAt?: number;
}

export interface MemoryGraphNode {
  id: string;
  kind: MemoryNodeKind;
  label: string;
  workspaceId: string;
  band: "L1" | "L2" | "L3";
  /** 事实节点才有：对应记忆条目 id。 */
  factId?: string;
  /** 事实/会话节点才有：来源会话 id。 */
  sessionId?: string;
  importance: number;
  /** 0..1 的激活值（M0：新近度 × 重要度；M1 换成使用事件）。 */
  activation: number;
  createdAt: number;
  lastUsedAt: number;
  /** M4 回放：在回放时刻已经失效（被取代），渲染成空心节点。 */
  superseded?: boolean;
  /** 展示半径（CSS 像素）。 */
  size: number;
}

export interface MemoryGraphEdge {
  id: string;
  kind: "owns" | "contains" | "semantic";
  from: string;
  to: string;
  strength: number;
}

export interface MemoryGraphModel {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  stats: {
    sessions: number;
    facts: number;
    orphanFacts: number;
    semanticLinks: number;
    workspaces: string[];
  };
}

export interface BuildMemoryGraphInput {
  facts: readonly MemoryFact[];
  sessions: readonly MemoryGraphSession[];
  /** 使用事件（E-M1）：key = fact:<id> / session:<id>；有事件时优先于「新近度」估算。 */
  usage?: Record<string, UsageEvent[]>;
  /** 每个会话最多上图多少条事实（其余靠点开查看）。 */
  maxFactsPerSession?: number;
  now?: number;
  /** M4 时间回放：只显示该时刻之前产生的事实，并用该时刻计算激活值（缺省 = 现在）。 */
  at?: number;
}

const DAY = 86_400_000;
export const ORIGIN_NODE_ID = "origin";
export const DEFAULT_MAX_FACTS_PER_SESSION = 12;

/** 激活值（M0）：指数新近度 × 重要度修正，落在 [0,1]。 */
export function recencyActivation(lastUsedAt: number, importance: number, now = Date.now()): number {
  const days = Math.max(0, (now - lastUsedAt) / DAY);
  const recency = Math.exp(-days / 30);
  return Math.max(0, Math.min(1, recency * (0.6 + 0.4 * (importance / 10))));
}

/**
 * 激活值（E-M1，ACT-R 形式）：R = Σ w·exp(-Δt/τ) → B = ln(1+R) → A = B/(B+1)。
 * 与 recencyActivation 的区别：它把「被用了几次」也编码进来，而不仅是「最后一次何时」。
 */
export function activationFromEvents(events: readonly UsageEvent[], now: number, tauDays = 30): number {
  if (events.length === 0) return 0;
  let r = 0;
  for (const event of events) {
    // M4 回放：晚于回放时刻的使用事件还没发生，不能计入激活（否则未来会「提前回忆」）。
    if (event.at > now) continue;
    const days = Math.max(0, (now - event.at) / DAY);
    r += event.w * Math.exp(-days / tauDays);
  }
  const b = Math.log1p(r);
  return b / (b + 1);
}

/** 有事件用事件算；没有事件回落到「新近度 × 重要度」。 */
export function activationOf(
  key: string,
  lastUsedAt: number,
  importance: number,
  now: number,
  usage?: Record<string, UsageEvent[]>,
): number {
  const events = usage?.[key];
  if (events && events.length > 0) {
    const fromEvents = activationFromEvents(events, now);
    if (fromEvents > 0) return fromEvents;
  }
  return recencyActivation(lastUsedAt, importance, now);
}

function factNodesOf(
  facts: readonly MemoryFact[],
  sessionId: string,
  max: number,
  now: number,
  usage?: Record<string, UsageEvent[]>,
): MemoryGraphNode[] {
  return facts
    .filter((f) => f.provenance?.sessionId === sessionId)
    .sort((a, b) => b.importance - a.importance || b.lastAccessed - a.lastAccessed)
    .slice(0, max)
    .map((fact) => {
      const activation = activationOf(`fact:${fact.id}`, fact.lastAccessed, fact.importance, now, usage);
      return {
        id: `fact:${fact.id}`,
        kind: "fact" as const,
        label: fact.content.slice(0, 60),
        workspaceId: fact.workspaceId ?? DEFAULT_WORKSPACE_ID,
        band: "L1" as const,
        factId: fact.id,
        sessionId,
        importance: fact.importance,
        activation,
        createdAt: fact.timestamp,
        lastUsedAt: fact.lastAccessed,
        size: 4 + Math.round(fact.importance / 2.5),
        ...(fact.invalidatedAt !== undefined && fact.invalidatedAt <= now ? { superseded: true } : {}),
      };
    });
}

/**
 * 派生图谱。规则（M0）：
 *  - 有存活会话的事实 → 挂在该会话下（L1）；每会话最多 maxFactsPerSession 条；
 *  - 找不到会话的事实（旧数据/已删会话）→ 游离层（L2）；
 *  - 事实之间的 links → semantic 边（只连两端都在图上的）。
 */
export function buildMemoryGraph(input: BuildMemoryGraphInput): MemoryGraphModel {
  const now = input.at ?? input.now ?? Date.now();
  const max = input.maxFactsPerSession ?? DEFAULT_MAX_FACTS_PER_SESSION;
  const sessionIds = new Set(input.sessions.map((s) => s.sessionId));
  // M4：回放时只保留「当时已经存在」的事实；还没发生的条目不上图，图才有生长感。
  const facts = input.at === undefined ? input.facts : input.facts.filter((f) => f.timestamp <= now);
  const isSuperseded = (f: MemoryFact): boolean => f.invalidatedAt !== undefined && f.invalidatedAt <= now;

  const nodes: MemoryGraphNode[] = [
    {
      id: ORIGIN_NODE_ID,
      kind: "origin",
      label: "Loopsoar",
      workspaceId: DEFAULT_WORKSPACE_ID,
      band: "L1",
      importance: 10,
      activation: 1,
      createdAt: 0,
      lastUsedAt: now,
      size: 18,
    },
  ];
  const edges: MemoryGraphEdge[] = [];

  for (const session of input.sessions) {
    const sessionNodeId = `session:${session.sessionId}`;
    const updatedAt = session.updatedAt ?? session.createdAt ?? now;
    nodes.push({
      id: sessionNodeId,
      kind: "session",
      label: session.title?.trim() || session.sessionId.slice(0, 12),
      workspaceId: session.workspaceId ?? DEFAULT_WORKSPACE_ID,
      band: "L1",
      sessionId: session.sessionId,
      importance: 6,
      activation: activationOf(`session:${session.sessionId}`, updatedAt, 6, now, input.usage),
      createdAt: session.createdAt ?? updatedAt,
      lastUsedAt: updatedAt,
      size: 7,
    });
    edges.push({
      id: `owns:${sessionNodeId}`,
      kind: "owns",
      from: ORIGIN_NODE_ID,
      to: sessionNodeId,
      strength: 1,
    });

    const children = factNodesOf(facts, session.sessionId, max, now, input.usage);
    for (const child of children) {
      nodes.push(child);
      edges.push({
        id: `contains:${child.id}`,
        kind: "contains",
        from: sessionNodeId,
        to: child.id,
        strength: child.activation,
      });
    }
  }

  // 游离层：没有存活会话的事实（被删除的会话留下的条目 / 旧数据）
  const orphans = facts
    .filter((f) => !f.provenance?.sessionId || !sessionIds.has(f.provenance.sessionId))
    .sort((a, b) => b.importance - a.importance || b.lastAccessed - a.lastAccessed)
    .slice(0, max * 4);
  for (const fact of orphans) {
    const activation = activationOf(`fact:${fact.id}`, fact.lastAccessed, fact.importance, now, input.usage);
    nodes.push({
      id: `fact:${fact.id}`,
      kind: "fact",
      label: fact.content.slice(0, 60),
      workspaceId: fact.workspaceId ?? DEFAULT_WORKSPACE_ID,
      band: "L2",
      factId: fact.id,
      importance: fact.importance,
      activation,
      createdAt: fact.timestamp,
      lastUsedAt: fact.lastAccessed,
      size: 4 + Math.round(fact.importance / 2.5),
      ...(isSuperseded(fact) ? { superseded: true } : {}),
    });
  }

  // 语义边：两端都在图上才连
  const byFactId = new Map(nodes.filter((n) => n.factId).map((n) => [n.factId as string, n.id]));
  let semanticLinks = 0;
  for (const fact of facts) {
    const from = byFactId.get(fact.id);
    if (!from) continue;
    for (const linkId of fact.links) {
      const to = byFactId.get(linkId);
      if (!to || to <= from) continue;
      edges.push({ id: `semantic:${from}:${to}`, kind: "semantic", from, to, strength: 0.5 });
      semanticLinks += 1;
    }
  }

  return {
    nodes,
    edges,
    stats: {
      sessions: input.sessions.length,
      facts: nodes.filter((n) => n.kind === "fact").length,
      orphanFacts: orphans.length,
      semanticLinks,
      workspaces: [...new Set(nodes.map((n) => n.workspaceId))],
    },
  };
}

/* ───────────────────────────── 布局 ───────────────────────────── */

export interface MemoryGraphPoint {
  id: string;
  x: number;
  y: number;
  radius: number;
}

export interface LayoutOptions {
  width: number;
  height: number;
  padding?: number;
}

const BAND_RATIO: Record<"L1" | "L2" | "L3", [number, number]> = {
  L1: [0.30, 0.54],
  L2: [0.64, 0.82],
  L3: [0.87, 0.96],
};

function hashAngle(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 3600) / 3600;
}

/**
 * 确定性环带布局：会话占扇区、事实挂在会话扇区内、游离节点按 hash 均匀铺在外环。
 * 同一份图两次布局结果相同；激活值只影响半径（层内连续），不影响角度。
 */
export function layoutMemoryGraph(model: MemoryGraphModel, opts: LayoutOptions): MemoryGraphPoint[] {
  const width = Math.max(200, opts.width);
  const height = Math.max(200, opts.height);
  const padding = opts.padding ?? 16;
  const cx = width / 2;
  const cy = height / 2;
  const R = (Math.min(width, height) / 2 - padding) * 1;

  const points: MemoryGraphPoint[] = [];
  const push = (node: MemoryGraphNode, angle: number, radius: number): void => {
    const r = Math.max(0, Math.min(R, radius));
    points.push({
      id: node.id,
      x: cx + Math.cos(angle) * r,
      y: cy + Math.sin(angle) * r,
      radius: node.size,
    });
  };

  const origin = model.nodes.find((n) => n.kind === "origin");
  if (origin) points.push({ id: origin.id, x: cx, y: cy, radius: origin.size });

  const sessions = model.nodes
    .filter((n) => n.kind === "session")
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const facts = model.nodes.filter((n) => n.kind === "fact" && n.band === "L1");
  const orphans = model.nodes.filter((n) => n.kind === "fact" && n.band !== "L1");

  // 每个会话的扇区宽度 ∝ 子节点数 + 1（空会话也占位）
  const childrenOf = (id: string): MemoryGraphNode[] => facts.filter((f) => f.sessionId === id.slice("session:".length));
  const weights = sessions.map((s) => childrenOf(s.id).length + 1);
  const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
  const gap = sessions.length > 1 ? Math.min(0.12, (Math.PI * 2) / sessions.length / 4) : 0;
  let cursor = -Math.PI / 2;

  sessions.forEach((session, index) => {
    const span = (Math.PI * 2 * weights[index]) / totalWeight;
    const start = cursor + gap / 2;
    const width = Math.max(0.01, span - gap);
    const [inR, outR] = BAND_RATIO.L1;
    const radius = (inR + (outR - inR) * (1 - session.activation)) * R;
    push(session, start + width / 2, radius);

    const kids = childrenOf(session.id).sort((a, b) => b.activation - a.activation);
    kids.forEach((child, i) => {
      const angle = start + ((i + 0.5) * width) / Math.max(1, kids.length);
      const childRadius = Math.min(outR * R, radius + 18 + (i % 3) * 12);
      push(child, angle, childRadius);
    });
    cursor += span;
  });

  // 游离层：整个 2π 均匀铺，按激活值决定半径（越活跃越靠内）
  const [l2in, l2out] = BAND_RATIO.L2;
  orphans
    .slice()
    .sort((a, b) => b.activation - a.activation)
    .forEach((node, i) => {
      const angle = (i / Math.max(1, orphans.length)) * Math.PI * 2 + hashAngle(node.id) * 0.05;
      const radius = (l2in + (l2out - l2in) * (1 - node.activation)) * R;
      push(node, angle, radius);
    });

  return points;
}
