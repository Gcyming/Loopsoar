/**
 * 记忆取代与时效（D2）：变更标记 / 否定翻转 / 数字变化 → 旧条目失效（不删除），召回默认排除。
 */
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../packages/core/src/memory/store.ts";
import { detectSupersede } from "../../packages/core/src/memory/supersede.ts";
import { createFact } from "../../packages/core/src/memory/fact.ts";

const NOW = 1_760_000_000_000;

function store(): MemoryStore {
  return new MemoryStore({ now: () => NOW, workspaceId: "ws-a" });
}

describe("记忆取代（D2）", () => {
  it("「改为 npm」让旧的「使用 pnpm」失效，且不删除旧条目", () => {
    const s = store();
    s.write([{ content: "项目使用 pnpm 管理依赖", category: "fact" }]);
    const result = s.write([{ content: "项目改为使用 npm 管理依赖", category: "fact" }]);

    expect(result.superseded).toHaveLength(1);
    const all = s.list({ includeInvalidated: true });
    // 注意：「pnpm」包含子串「npm」，不能用 includes("npm 管理") 找新条目
    const old = all.find((f) => f.invalidatedAt !== undefined);
    const next = all.find((f) => (f.supersedes ?? []).length > 0);
    expect(old?.invalidatedAt).toBe(NOW);
    expect(old?.supersededBy).toBe(next?.id);
    expect(next?.supersedes).toContain(old?.id);
  });

  it("失效条目不再参与召回；显式 includeInvalidated 可查回", () => {
    const s = store();
    s.write([{ content: "项目使用 pnpm 管理依赖", category: "fact" }]);
    s.write([{ content: "项目改为使用 npm 管理依赖", category: "fact" }]);

    expect(s.recall("pnpm 依赖", 6).some((h) => h.fact.content.includes("pnpm"))).toBe(false);
    expect(s.list()).toHaveLength(1);
    expect(s.list({ includeInvalidated: true })).toHaveLength(2);
    expect(s.stats().invalidated).toBe(1);
  });

  it("否定翻转（使用 vs 不再使用）同样触发取代", () => {
    const existing = [createFact({ id: "old", content: "使用 pnpm 安装依赖", category: "convention" })];
    const hits = detectSupersede({ content: "不再使用 pnpm 安装依赖", category: "convention" }, existing);
    expect(hits).toHaveLength(1);
    // 「不再」同时命中变更标记，具体归因不影响「必须取代」这个结论
    expect(["negation", "marker"]).toContain(hits[0].reason);
  });

  it("数字变化（端口）触发取代", () => {
    const existing = [createFact({ id: "old", content: "本地调试端口是 19444", category: "project" })];
    const hits = detectSupersede({ content: "本地调试端口改成 19555", category: "project" }, existing);
    expect(hits).toHaveLength(1);
    expect(hits[0].reason).toBe("number");
  });

  it("无关的新约定不会误取代（相似度不足）", () => {
    const s = store();
    s.write([{ content: "项目使用 pnpm 管理依赖", category: "fact" }]);
    const result = s.write([{ content: "单元测试统一改用 vitest 运行", category: "fact" }]);
    expect(result.superseded).toHaveLength(0);
    expect(s.list()).toHaveLength(2);
  });

  it("不同工作区之间不互相取代", () => {
    const s = store();
    s.write([{ content: "项目使用 pnpm 管理依赖", category: "fact", workspaceId: "ws-a" }]);
    const result = s.write([{ content: "项目改为使用 npm 管理依赖", category: "fact", workspaceId: "ws-b" }]);
    expect(result.superseded).toHaveLength(0);
  });
});
