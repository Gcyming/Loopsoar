/**
 * 工作区隔离（D1）：五闸只在同工作区内生效；召回/统计/列表按工作区过滤；旧数据归一。
 */
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../packages/core/src/memory/store.ts";
import { DEFAULT_WORKSPACE_ID } from "../../packages/core/src/memory/fact.ts";

const NOW = 1_760_000_000_000;

describe("记忆工作区隔离（D1）", () => {
  it("同内容在两个工作区各自新增，不跨区去重/合并且不建跨 agent 指针", () => {
    const store = new MemoryStore({ now: () => NOW });
    store.write([{ content: "项目使用 pnpm 管理依赖", category: "fact", workspaceId: "ws-a" }]);
    store.write([{ content: "项目使用 pnpm 管理依赖", category: "fact", workspaceId: "ws-b" }]);

    expect(store.list({ workspaceId: "ws-a" })).toHaveLength(1);
    expect(store.list({ workspaceId: "ws-b" })).toHaveLength(1);
    const all = store.list();
    expect(all).toHaveLength(2);
    expect(all.every((f) => (f.crossAgentLinks ?? []).length === 0)).toBe(true);
  });

  it("recall 只返回指定工作区的条目（不传则不隔离，调用方必须显式传）", () => {
    const store = new MemoryStore({ now: () => NOW });
    store.write([{ content: "深色主题界面的偏好", category: "preference", workspaceId: "ws-a" }]);
    store.write([{ content: "深色主题界面的偏好", category: "preference", workspaceId: "ws-b" }]);

    expect(store.recall("深色主题", 6, { workspaceId: "ws-a" })).toHaveLength(1);
    expect(store.recall("深色主题", 6, { workspaceId: "ws-b" })).toHaveLength(1);
    expect(store.recall("深色主题")).toHaveLength(2);
  });

  it("stats 支持工作区过滤并给出 byWorkspace 分布", () => {
    const store = new MemoryStore({ now: () => NOW });
    store.write([
      { content: "A 项目使用 pnpm", category: "fact", workspaceId: "ws-a" },
      { content: "A 项目的端口是 19444", category: "project", workspaceId: "ws-a" },
      { content: "B 项目使用 npm", category: "fact", workspaceId: "ws-b" },
    ]);
    expect(store.stats("ws-a").active).toBe(2);
    expect(store.stats("ws-b").active).toBe(1);
    expect(store.stats().byWorkspace).toEqual({ "ws-a": 2, "ws-b": 1 });
  });

  it("容量按工作区独立：一个工作区超限不影响另一个", () => {
    const store = new MemoryStore({ capacity: 2, now: () => NOW });
    // 三条内容必须彼此不同（否则会先被去重/合并，容量闸根本不会触发）
    store.write([{ content: "A 区：数据库迁移前必须先备份", category: "fact", workspaceId: "ws-a" }]);
    store.write([{ content: "A 区：终端默认使用 pwsh 而不是 cmd", category: "convention", workspaceId: "ws-a" }]);
    store.write([{ content: "A 区：本地调试页面端口是 19444", category: "project", workspaceId: "ws-a" }]);
    store.write([{ content: "B 区：包管理器使用 npm 工作区", category: "fact", workspaceId: "ws-b" }]);
    store.write([{ content: "B 区：单元测试框架是 vitest", category: "fact", workspaceId: "ws-b" }]);

    const a = store.stats("ws-a");
    const b = store.stats("ws-b");
    expect(a.active).toBe(2);
    expect(a.archived).toBe(1);
    expect(b.active).toBe(2);
    expect(b.archived).toBe(0);
  });

  it("restore 归一旧数据：补 workspaceId=default 与 provenance.trust=user", () => {
    const store = new MemoryStore({ now: () => NOW });
    store.restore({
      facts: [
        {
          id: "mem-legacy",
          content: "旧版本留下的记忆",
          category: "fact",
          tags: [],
          importance: 5,
          timestamp: NOW - 1000,
          lastAccessed: NOW - 1000,
          links: [],
          backlinks: [],
          repeated: 0,
          layer: "semantic",
          accessCount: 0,
          confidence: 0.8,
          source: "chat",
          status: "active",
          mergeTrail: [],
          agentId: "loopsoar",
        } as never,
      ],
      archived: [],
    });
    const fact = store.list()[0];
    expect(fact.workspaceId).toBe(DEFAULT_WORKSPACE_ID);
    expect(fact.provenance?.trust).toBe("user");
  });
});
