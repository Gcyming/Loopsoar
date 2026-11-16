/**
 * 访问信号（D3）：只有显式检索命中才累加 accessCount；自动注入不算。
 */
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../packages/core/src/memory/store.ts";
import { effectiveValue } from "../../packages/core/src/memory/fiveGate.ts";

const NOW = 1_760_000_000_000;

describe("记忆访问信号（D3）", () => {
  it("touch 累加 accessCount / 刷新 lastAccessed / 小幅提升 confidence", () => {
    const store = new MemoryStore({ now: () => NOW });
    store.write([{ content: "项目使用 pnpm 管理依赖", category: "fact", workspaceId: "ws-a" }]);
    const id = store.list()[0].id;
    const before = store.get(id)!;
    const confidenceBefore = before.confidence;

    expect(store.touch([id])).toBe(1);
    const after = store.get(id)!;
    expect(after.accessCount).toBe(1);
    expect(after.lastAccessed).toBe(NOW);
    expect(after.confidence).toBeGreaterThan(confidenceBefore);
  });

  it("访问次数提升 effectiveValue（对数加成，封顶 +50%）", () => {
    const store = new MemoryStore({ now: () => NOW });
    store.write([{ content: "项目使用 pnpm 管理依赖", category: "fact" }]);
    const id = store.list()[0].id;
    const base = effectiveValue(store.get(id)!, NOW);
    for (let i = 0; i < 20; i += 1) store.touch([id]);
    const boosted = effectiveValue(store.get(id)!, NOW);
    expect(boosted).toBeGreaterThan(base);
    // 两个来源：usageBoost 封顶 1.5、confidence 从 0.8 涨到 1.0（+25%）→ 合计上限约 1.875
    expect(boosted / base).toBeLessThanOrEqual(1.875 + 1e-9);
  });

  it("失效条目不再被 touch 计入", () => {
    const store = new MemoryStore({ now: () => NOW });
    store.write([{ content: "项目使用 pnpm 管理依赖", category: "fact" }]);
    store.write([{ content: "项目改为使用 npm 管理依赖", category: "fact" }]);
    const oldFact = store.list({ includeInvalidated: true }).find((f) => f.invalidatedAt);
    expect(store.touch([oldFact!.id])).toBe(0);
  });
});
