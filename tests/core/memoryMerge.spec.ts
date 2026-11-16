/**
 * 回顾合并：保留者选择、失效标记、信息并集与边界。
 */
import { describe, expect, it } from "vitest";
import { createFact } from "../../packages/core/src/memory/fact.ts";
import { MemoryStore } from "../../packages/core/src/memory/store.ts";

const NOW = 1_760_000_000_000;
const fact = (id: string, content: string, extra: Partial<Parameters<typeof createFact>[0]> = {}) =>
  createFact({ id, content, category: "fact", workspaceId: "default", timestamp: NOW, ...extra });

function storeWith(facts: ReturnType<typeof fact>[]): MemoryStore {
  const store = new MemoryStore();
  store.restore({ facts });
  return store;
}

describe("记忆回顾合并（mergeGroup）", () => {
  it("保留重要度最高者，其余标记失效并指向保留者", () => {
    const store = storeWith([fact("a", "项目使用 pnpm", { importance: 5 }), fact("b", "项目使用 pnpm 管理依赖", { importance: 9 })]);
    const result = store.mergeGroup(["a", "b"], "同一约定");
    expect(result).toEqual({ kept: "b", merged: ["a"] });
    const all = store.list({ includeArchived: true, includeInvalidated: true });
    const loser = all.find((item) => item.id === "a");
    expect(loser?.invalidatedAt).toBeTruthy();
    expect(loser?.supersededBy).toBe("b");
    expect(loser?.status).toBe("merged:fact");
    expect(store.list().map((item) => item.id)).toEqual(["b"]);
  });

  it("合并时取 tags/links 并集并记录 mergeTrail 原因", () => {
    const store = storeWith([
      fact("a", "同一件事 A", { tags: ["x"], links: ["m9"], importance: 9 }),
      fact("b", "同一件事 B", { tags: ["y"], links: ["m8"] }),
    ]);
    store.mergeGroup(["a", "b"], "回顾合并");
    const kept = store.list()[0];
    expect(kept?.tags.sort()).toEqual(["x", "y"]);
    expect(kept?.links.sort()).toEqual(["m8", "m9"]);
    expect(kept?.mergeTrail.at(-1)?.reason).toBe("回顾合并");
  });

  it("少于两条或 id 不存在 → null（不做破坏性操作）", () => {
    const store = storeWith([fact("a", "唯一")]);
    expect(store.mergeGroup(["a"], "x")).toBeNull();
    expect(store.mergeGroup(["a", "missing"], "x")).toBeNull();
  });
});
