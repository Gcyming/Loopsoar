/**
 * 记忆图谱（E-M0）：派生规则 + 确定性环带布局。
 */
import { describe, expect, it } from "vitest";
import { createFact } from "../../packages/core/src/memory/fact.ts";
import {
  buildMemoryGraph,
  layoutMemoryGraph,
  ORIGIN_NODE_ID,
  recencyActivation,
} from "../../packages/core/src/memory/graph.ts";

const NOW = 1_760_000_000_000;
const DAY = 86_400_000;

function fact(id: string, content: string, opts: {
  sessionId?: string;
  links?: string[];
  importance?: number;
  lastAccessed?: number;
  workspaceId?: string;
} = {}) {
  return createFact({
    id,
    content,
    category: "fact",
    importance: opts.importance ?? 5,
    lastAccessed: opts.lastAccessed ?? NOW,
    links: opts.links ?? [],
    workspaceId: opts.workspaceId ?? "ws-a",
    provenance: {
      workspaceId: opts.workspaceId ?? "ws-a",
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      trust: "user",
      capturedBy: "auto",
    },
  });
}

describe("记忆图谱派生（E-M0）", () => {
  it("会话事实挂 L1、无会话事实进 L2，并生成 owns/contains 边", () => {
    const model = buildMemoryGraph({
      now: NOW,
      facts: [
        fact("f1", "项目使用 pnpm", { sessionId: "s1" }),
        fact("f2", "旧版本遗留的事实", {}),
      ],
      sessions: [{ sessionId: "s1", title: "记忆设计", workspaceId: "ws-a", updatedAt: NOW }],
    });

    const ids = new Set(model.nodes.map((n) => n.id));
    expect(ids.has(ORIGIN_NODE_ID)).toBe(true);
    expect(ids.has("session:s1")).toBe(true);
    expect(ids.has("fact:f1")).toBe(true);
    expect(ids.has("fact:f2")).toBe(true);
    expect(model.nodes.find((n) => n.id === "fact:f1")?.band).toBe("L1");
    expect(model.nodes.find((n) => n.id === "fact:f2")?.band).toBe("L2");

    expect(model.edges.some((e) => e.kind === "owns" && e.to === "session:s1")).toBe(true);
    expect(model.edges.some((e) => e.kind === "contains" && e.to === "fact:f1")).toBe(true);
    expect(model.stats.sessions).toBe(1);
    expect(model.stats.orphanFacts).toBe(1);
  });

  it("每个会话上图事实有上限（按重要度与最近访问排序）", () => {
    const facts = Array.from({ length: 20 }, (_, i) =>
      fact(`f${i}`, `事实 ${i}`, { sessionId: "s1", importance: (i % 10) + 1 }),
    );
    const model = buildMemoryGraph({ now: NOW, facts, sessions: [{ sessionId: "s1" }], maxFactsPerSession: 5 });
    const shown = model.nodes.filter((n) => n.kind === "fact");
    expect(shown).toHaveLength(5);
    // 重要度 10 的条目必须优先出现
    expect(shown.some((n) => n.importance === 10)).toBe(true);
  });

  it("语义边只在两端都在图上时建立", () => {
    const model = buildMemoryGraph({
      now: NOW,
      facts: [
        fact("f1", "项目使用 pnpm", { sessionId: "s1", links: ["f2", "f3"] }),
        fact("f2", "项目使用 vitest", { sessionId: "s1" }),
        // f3 不存在 → 不建边
      ],
      sessions: [{ sessionId: "s1" }],
    });
    const semantic = model.edges.filter((e) => e.kind === "semantic");
    expect(semantic).toHaveLength(1);
    expect(model.stats.semanticLinks).toBe(1);
  });

  it("激活值随时间衰减且受重要度调制", () => {
    const fresh = recencyActivation(NOW, 5, NOW);
    const old = recencyActivation(NOW - 60 * DAY, 5, NOW);
    const important = recencyActivation(NOW, 10, NOW);
    expect(fresh).toBeGreaterThan(old);
    expect(important).toBeGreaterThan(fresh);
    expect(fresh).toBeLessThanOrEqual(1);
    expect(old).toBeGreaterThanOrEqual(0);
  });
});

describe("记忆图谱布局（E-M0）", () => {
  const model = buildMemoryGraph({
    now: NOW,
    facts: [
      fact("f1", "项目使用 pnpm", { sessionId: "s1" }),
      fact("f2", "项目使用 vitest", { sessionId: "s1" }),
      fact("f3", "旧版本遗留", {}),
    ],
    sessions: [
      { sessionId: "s1", title: "A", createdAt: NOW - 3000, updatedAt: NOW },
      { sessionId: "s2", title: "B", createdAt: NOW - 2000, updatedAt: NOW - DAY },
    ],
  });

  it("确定性：同一输入两次布局完全一致", () => {
    const a = layoutMemoryGraph(model, { width: 800, height: 600 });
    const b = layoutMemoryGraph(model, { width: 800, height: 600 });
    expect(a).toEqual(b);
  });

  it("所有点落在画布内，且原点在中心", () => {
    const points = layoutMemoryGraph(model, { width: 800, height: 600, padding: 16 });
    for (const p of points) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(800);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(600);
    }
    const origin = points.find((p) => p.id === ORIGIN_NODE_ID);
    expect(origin?.x).toBe(400);
    expect(origin?.y).toBe(300);
  });

  it("游离层半径大于第一分支（层边界不被穿越）", () => {
    const points = layoutMemoryGraph(model, { width: 800, height: 600 });
    const cx = 400;
    const cy = 300;
    const dist = (id: string): number => {
      const p = points.find((x) => x.id === id);
      return p ? Math.hypot(p.x - cx, p.y - cy) : 0;
    };
    const sessionR = Math.max(dist("session:s1"), dist("session:s2"));
    expect(dist("fact:f3")).toBeGreaterThan(sessionR);
  });
});
