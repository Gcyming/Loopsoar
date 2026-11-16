/**
 * 后台巩固（D3 后半）：近似重复合并 + 长期未用低价值条目软归档。
 */
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../packages/core/src/memory/store.ts";
import { createFact } from "../../packages/core/src/memory/fact.ts";

const NOW = 1_760_000_000_000;
const DAY = 86_400_000;

function fact(id: string, content: string, opts: { lastAccessed?: number; importance?: number; category?: string; workspaceId?: string } = {}) {
  return createFact({
    id,
    content,
    category: opts.category ?? "fact",
    importance: opts.importance ?? 5,
    lastAccessed: opts.lastAccessed ?? NOW,
    timestamp: opts.lastAccessed ?? NOW,
    workspaceId: opts.workspaceId ?? "ws-a",
    provenance: { workspaceId: opts.workspaceId ?? "ws-a", trust: "user", capturedBy: "auto" },
  });
}

describe("后台巩固（D3）", () => {
  it("近似重复（≥0.9）合并成一条并记录 mergeTrail", () => {
    const store = new MemoryStore({ now: () => NOW });
    store.restore({
      facts: [
        fact("a", "项目使用 pnpm 管理依赖并锁定版本"),
        fact("b", "项目使用 pnpm 管理依赖并锁定版本号", { lastAccessed: NOW - DAY }),
      ],
      archived: [],
    });
    const report = store.consolidate(NOW);
    expect(report.merged).toBe(1);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].mergeTrail.length).toBe(1);
  });

  it("内容不同的条目不会被合并", () => {
    const store = new MemoryStore({ now: () => NOW });
    store.write([
      { content: "项目使用 pnpm 管理依赖", category: "fact" },
      { content: "数据库迁移前先备份", category: "fact" },
    ]);
    expect(store.consolidate(NOW).merged).toBe(0);
    expect(store.list()).toHaveLength(2);
  });

  it("长期未用且价值极低的条目进归档（软删除，可查回原因）", () => {
    const store = new MemoryStore({ now: () => NOW });
    store.restore({
      facts: [
        fact("stale", "很久以前的一条低价值事实", { lastAccessed: NOW - 200 * DAY, importance: 1 }),
        fact("fresh", "最近还在用的事实"),
      ],
      archived: [],
    });
    const report = store.consolidate(NOW);
    expect(report.archived).toEqual(["stale"]);
    expect(store.list()).toHaveLength(1);
    expect(store.stats().archived).toBe(1);
    const archived = store.list({ includeArchived: true }).find((f) => f.id === "stale")!;
    expect(archived.status).toBe("archived:stale");
    expect(archived.archivedReason).toContain("长期未用");
  });

  it("按工作区巩固：只处理目标工作区", () => {
    const store = new MemoryStore({ now: () => NOW });
    store.restore({
      facts: [
        fact("a1", "工作区 A 的旧事实", { lastAccessed: NOW - 200 * DAY, importance: 1, workspaceId: "ws-a" }),
        fact("b1", "工作区 B 的旧事实", { lastAccessed: NOW - 200 * DAY, importance: 1, workspaceId: "ws-b" }),
      ],
      archived: [],
    });
    const report = store.consolidate(NOW, { workspaceId: "ws-a" });
    expect(report.archived).toEqual(["a1"]);
    expect(store.list({ workspaceId: "ws-b" })).toHaveLength(1);
  });
});
