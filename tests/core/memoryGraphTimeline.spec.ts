/**
 * 记忆图谱时间回放（M4）：按 at 过滤事实、按 at 判定失效、按 at 计算激活。
 */
import { describe, expect, it } from "vitest";
import { createFact, type MemoryFact } from "../../packages/core/src/memory/fact.ts";
import { buildMemoryGraph } from "../../packages/core/src/memory/graph.ts";

const NOW = 1_760_000_000_000;
const DAY = 86_400_000;
const ago = (days: number): number => NOW - days * DAY;

function fact(
  id: string,
  opts: { bornAt?: number; invalidatedAt?: number; session?: string; lastAccessed?: number } = {},
): MemoryFact {
  return createFact({
    id,
    content: id,
    category: "fact",
    timestamp: opts.bornAt ?? NOW,
    lastAccessed: opts.lastAccessed ?? opts.bornAt ?? NOW,
    invalidatedAt: opts.invalidatedAt,
    workspaceId: "ws-a",
    provenance: {
      workspaceId: "ws-a",
      ...(opts.session ? { sessionId: opts.session } : {}),
      trust: "user",
      capturedBy: "auto",
    },
  });
}

const sessions = [{ sessionId: "s1", title: "会话一", updatedAt: NOW }];

describe("记忆图谱时间回放（M4）", () => {
  it("只画回放时刻之前已经存在的事实", () => {
    const model = buildMemoryGraph({
      at: ago(5),
      sessions,
      facts: [
        fact("old", { bornAt: ago(10), session: "s1" }),
        fact("future", { bornAt: ago(1), session: "s1" }),
      ],
    });
    const ids = model.nodes.map((n) => n.id);
    expect(ids).toContain("fact:old");
    expect(ids).not.toContain("fact:future");
    expect(model.stats.facts).toBe(1);
  });

  it("回放时刻还没失效的条目保持实心（superseded 不置位）", () => {
    const model = buildMemoryGraph({
      at: ago(5),
      sessions,
      facts: [fact("f", { bornAt: ago(10), invalidatedAt: ago(1) })],
    });
    const node = model.nodes.find((n) => n.id === "fact:f");
    expect(node?.superseded).toBeUndefined();
  });

  it("回放时刻已经失效的条目仍留在图上，但标记为 superseded", () => {
    const model = buildMemoryGraph({
      at: ago(5),
      sessions,
      facts: [fact("f", { bornAt: ago(10), invalidatedAt: ago(6) })],
    });
    expect(model.nodes.find((n) => n.id === "fact:f")?.superseded).toBe(true);
  });

  it("游离层（无会话）同样按 at 过滤并标记失效", () => {
    const model = buildMemoryGraph({
      at: ago(5),
      sessions,
      facts: [
        fact("orphan-old", { bornAt: ago(10) }),
        fact("orphan-gone", { bornAt: ago(9), invalidatedAt: ago(6) }),
        fact("orphan-new", { bornAt: ago(2) }),
      ],
    });
    expect(model.nodes.find((n) => n.id === "fact:orphan-old")?.band).toBe("L2");
    expect(model.nodes.find((n) => n.id === "fact:orphan-gone")?.superseded).toBe(true);
    expect(model.nodes.find((n) => n.id === "fact:orphan-new")).toBeUndefined();
  });

  it("激活值按回放时刻计算：同一事实在越晚的时刻越旧、激活越低", () => {
    const facts = [fact("f", { bornAt: ago(40), session: "s1", lastAccessed: ago(20) })];
    const early = buildMemoryGraph({ at: ago(10), sessions, facts }).nodes.find((n) => n.id === "fact:f");
    const late = buildMemoryGraph({ at: NOW, sessions, facts }).nodes.find((n) => n.id === "fact:f");
    expect(early && late).toBeTruthy();
    expect((early as { activation: number }).activation).toBeGreaterThan((late as { activation: number }).activation);
  });

  it("晚于回放时刻的使用事件不计入激活", () => {
    const facts = [fact("f", { bornAt: ago(30), session: "s1", lastAccessed: ago(20) })];
    const model = buildMemoryGraph({
      at: ago(10),
      sessions,
      facts,
      usage: { "fact:f": [{ at: NOW, w: 1 }] },
    });
    const node = model.nodes.find((n) => n.id === "fact:f");
    const expected = Math.exp(-10 / 30) * (0.6 + 0.4 * (5 / 10));
    expect(node?.activation).toBeCloseTo(expected, 6);
  });

  it("不回放的默认行为不变：at 缺省时全部事实参与", () => {
    const model = buildMemoryGraph({
      now: NOW,
      sessions,
      facts: [fact("a", { bornAt: ago(10), session: "s1" }), fact("b", { bornAt: ago(1), session: "s1" })],
    });
    expect(model.stats.facts).toBe(2);
  });
});
