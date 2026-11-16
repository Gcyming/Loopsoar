/**
 * 使用事件与失真层（E-M1）：事件上限 / ACT-R 激活 / ghost 降级 / 图谱使用事件。
 */
import { describe, expect, it } from "vitest";
import { MemoryStore, USAGE_EVENT_CAP } from "../../packages/core/src/memory/store.ts";
import { createFact } from "../../packages/core/src/memory/fact.ts";
import {
  activationFromEvents,
  activationOf,
  buildMemoryGraph,
  recencyActivation,
} from "../../packages/core/src/memory/graph.ts";

const NOW = 1_760_000_000_000;
const DAY = 86_400_000;
const store = (): MemoryStore => new MemoryStore({ now: () => NOW, workspaceId: "ws-a" });

describe("使用事件（E-M1）", () => {
  it("每键最多保留 50 条事件（丢最旧）", () => {
    const s = store();
    for (let i = 0; i < 60; i += 1) s.recordUsage("fact:f1", "search", NOW + i);
    const events = s.usageSnapshot()["fact:f1"] ?? [];
    expect(events).toHaveLength(USAGE_EVENT_CAP);
    expect(events[events.length - 1].at).toBe(NOW + 59);
  });

  it("事件权重复：mention 1.0 > tool 0.8 > search 0.6 > view 0.3", () => {
    const s = store();
    s.recordUsage("k", "mention");
    s.recordUsage("k", "tool");
    s.recordUsage("k", "search");
    s.recordUsage("k", "view");
    expect(s.usageSnapshot()["k"].map((e) => e.w)).toEqual([1, 0.8, 0.6, 0.3]);
  });

  it("ACT-R 激活：越常用越高、越久远越低", () => {
    const recent = activationFromEvents([{ at: NOW, w: 1, kind: "mention" }], NOW);
    const old = activationFromEvents([{ at: NOW - 60 * DAY, w: 1, kind: "mention" }], NOW);
    const repeated = activationFromEvents(
      [
        { at: NOW, w: 1, kind: "mention" },
        { at: NOW - DAY, w: 1, kind: "tool" },
        { at: NOW - 2 * DAY, w: 1, kind: "search" },
      ],
      NOW,
    );
    expect(recent).toBeGreaterThan(old);
    expect(repeated).toBeGreaterThan(recent);
    expect(repeated).toBeLessThanOrEqual(1);
  });

  it("有事件时 activationOf 用事件，没有则回落新近度", () => {
    const withEvents = activationOf("fact:f1", NOW - 200 * DAY, 3, NOW, {
      "fact:f1": [{ at: NOW, w: 1, kind: "mention" }],
    });
    const fallback = activationOf("fact:f1", NOW - 200 * DAY, 3, NOW, {});
    expect(withEvents).toBeGreaterThan(fallback);
    expect(fallback).toBeCloseTo(recencyActivation(NOW - 200 * DAY, 3, NOW), 6);
  });

  it("90 天未用的 episode 降级为 ghost（内容截断 + ghost 标签），活跃条目不降级", () => {
    const s = store();
    s.write([
      { content: "很久以前的会话摘要，包含大量细节需要被压缩掉".repeat(4), category: "episode", importance: 8 },
      { content: "最近用过的会话摘要", category: "episode", importance: 8 },
      { content: "普通事实不应被降级", category: "fact", importance: 8 },
    ]);
    const all = s.list();
    const oldEpisode = all.find((f) => f.content.startsWith("很久以前"))!;
    oldEpisode.lastAccessed = NOW - 120 * DAY;
    const freshEpisode = all.find((f) => f.content.startsWith("最近"))!;

    const demoted = s.demoteGhosts(NOW);
    expect(demoted).toEqual([oldEpisode.id]);
    const ghost = s.list({ includeInvalidated: true }).find((f) => f.id === oldEpisode.id)!;
    expect(ghost.category).toBe("ghost");
    expect(ghost.content.length).toBeLessThanOrEqual(120);
    expect(ghost.tags).toContain("ghost");
    expect(freshEpisode.category).toBe("episode");
  });

  it("图谱节点使用事件抬高激活值（同一事实，有事件 > 无事件）", () => {
    const fact = createFact({
      id: "m1",
      content: "项目使用 pnpm 管理依赖",
      category: "fact",
      workspaceId: "ws-a",
      lastAccessed: NOW - 100 * DAY,
      provenance: { sessionId: "s1", trust: "user", capturedBy: "auto", workspaceId: "ws-a" },
    });
    const base = buildMemoryGraph({ now: NOW, facts: [fact], sessions: [{ sessionId: "s1" }] });
    const boosted = buildMemoryGraph({
      now: NOW,
      facts: [fact],
      sessions: [{ sessionId: "s1" }],
      usage: { "fact:m1": [{ at: NOW, w: 1, kind: "mention" }] },
    });
    const a = base.nodes.find((n) => n.factId === "m1")!.activation;
    const b = boosted.nodes.find((n) => n.factId === "m1")!.activation;
    expect(b).toBeGreaterThan(a);
  });
});
