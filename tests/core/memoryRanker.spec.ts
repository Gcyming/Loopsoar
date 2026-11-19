/**
 * 混合召回排序（docs/规划/记忆召回-原点图与混合检索方案.md §3.3 / §9 P0）：
 * similarity 零回归、hybrid/distance 公式与资格门槛、L2/L3 层级规则、冷启动先验、确定性排序。
 */
import { describe, expect, it } from "vitest";
import { createFact, jaccardCJK, effectiveValue } from "../../packages/core/src/memory/index.ts";
import { MemoryStore } from "../../packages/core/src/memory/store.ts";
import {
  DEFAULT_RANK_MIN_SCORE,
  HYBRID_WEIGHTS,
  DISTANCE_WEIGHTS,
  detectExactHit,
  rankMemory,
} from "../../packages/core/src/memory/ranker.ts";

const NOW = Date.UTC(2026, 10, 19, 10, 0, 0);

function fact(id: string, content: string, extra: Record<string, unknown> = {}) {
  return createFact({ id, content, category: "note", lastAccessed: NOW, confidence: 1, ...extra });
}

describe("rankMemory：similarity 模式零回归", () => {
  it("复现旧公式 effectiveValue × (0.2 + jaccard) + tag 加分", () => {
    const hits = rankMemory([
      { id: "a", similarity: 0.5, value: 0.4 },
      { id: "b", similarity: 0.5, value: 0.4, tagHit: true },
    ]);
    expect(hits[0].id).toBe("b");
    expect(hits[0].score).toBeCloseTo(0.4 * 0.7 + 0.15, 10);
    expect(hits[1].score).toBeCloseTo(0.4 * 0.7, 10);
  });

  it("默认阈值 0.02：低于阈值的候选被丢弃（与旧 recall 一致）", () => {
    expect(DEFAULT_RANK_MIN_SCORE).toBe(0.02);
    const hits = rankMemory([{ id: "low", similarity: 0, value: 0.01 }]);
    expect(hits).toEqual([]);
  });

  it("不加资格门槛也不加层级惩罚（similarity 必须逐项等于旧实现）", () => {
    const hits = rankMemory([
      { id: "no-lexical", similarity: 0, value: 0.5 },
      { id: "l2", similarity: 0.3, value: 0.5, band: "L2" },
      { id: "l3", similarity: 0.3, value: 0.5, band: "L3" },
    ]);
    expect(hits.map((hit) => hit.id).sort()).toEqual(["l2", "l3", "no-lexical"]);
    for (const hit of hits) expect(hit.score).toBeCloseTo(0.5 * (0.2 + (hit.id === "no-lexical" ? 0 : 0.3)), 10);
  });
});

describe("rankMemory：hybrid / distance 公式", () => {
  it("hybrid = 0.55A + 0.35S + 0.10E + 0.05G", () => {
    const [hit] = rankMemory([{ id: "a", similarity: 0.5, activation: 0.8, exact: true, graph: 0.4 }], {
      mode: "hybrid",
    });
    const expected =
      HYBRID_WEIGHTS.activation * 0.8 + HYBRID_WEIGHTS.similarity * 0.5 + HYBRID_WEIGHTS.exact + HYBRID_WEIGHTS.graph * 0.4;
    expect(hit.score).toBeCloseTo(expected, 10);
    expect(hit.reasons).toContain("activation");
    expect(hit.reasons).toContain("graph");
    expect(hit.reasons).toContain("exact");
  });

  it("distance = 0.75A + 0.25S", () => {
    const [hit] = rankMemory([{ id: "a", similarity: 0.5, activation: 0.8 }], { mode: "distance" });
    expect(hit.score).toBeCloseTo(DISTANCE_WEIGHTS.activation * 0.8 + DISTANCE_WEIGHTS.similarity * 0.5, 10);
  });

  it("资格门槛：只靠激活值、相似度不足且非 exact 的候选不能进（§3.3 约束）", () => {
    expect(rankMemory([{ id: "hot-noise", similarity: 0.01, activation: 1 }], { mode: "hybrid" })).toEqual([]);
    expect(rankMemory([{ id: "hot-noise", similarity: 0.01, activation: 1 }], { mode: "distance" })).toEqual([]);
  });

  it("exact/tag 命中可越过相似度门槛", () => {
    const hits = rankMemory([{ id: "exact", similarity: 0, activation: 0.5, tagHit: true }], { mode: "hybrid" });
    expect(hits).toHaveLength(1);
    expect(hits[0].reasons).toContain("exact");
  });

  it("L2 乘 0.85；L3 默认排除，exact 或 includeL3 才放行（§3.2 / §7）", () => {
    const base = { id: "a", similarity: 0.5, activation: 0.6 };
    const l1 = rankMemory([{ ...base }], { mode: "hybrid" })[0].score;
    const l2 = rankMemory([{ ...base, band: "L2" }], { mode: "hybrid" })[0];
    expect(l2.score).toBeCloseTo(l1 * 0.85, 10);
    expect(l2.reasons).toContain("band:L2");

    expect(rankMemory([{ ...base, band: "L3" }], { mode: "hybrid" })).toEqual([]);
    expect(rankMemory([{ ...base, band: "L3", exact: true }], { mode: "hybrid" })).toHaveLength(1);
    expect(rankMemory([{ ...base, band: "L3" }], { mode: "hybrid", includeL3: true })).toHaveLength(1);
  });

  it("冷启动：没有 activation 时用 effectiveValue 兜底，并标注 cold-start（§10）", () => {
    const [hit] = rankMemory([{ id: "new", similarity: 0.5, value: 0.4 }], { mode: "hybrid" });
    expect(hit.score).toBeCloseTo(0.55 * 0.4 + 0.35 * 0.5, 10);
    expect(hit.reasons).toContain("cold-start");
  });

  it("分数相同按 id 升序，排序确定（不随插入顺序抖动）", () => {
    const hits = rankMemory(
      [
        { id: "z", similarity: 0.4, value: 0.5 },
        { id: "a", similarity: 0.4, value: 0.5 },
      ],
      { mode: "similarity" },
    );
    expect(hits.map((hit) => hit.id)).toEqual(["a", "z"]);
  });
});

describe("detectExactHit：字面精确命中", () => {
  it("引号内容 / 端口 / 路径 / tag 命中", () => {
    expect(detectExactHit('把 "localhost:8991" 记下来', "调试端口 localhost:8991")).toBe(true);
    expect(detectExactHit("端口 8991 是什么", "本地调试服务监听 8991")).toBe(true);
    expect(detectExactHit("D:\\tool\\repo 下的约定", "仓库在 D:\\tool\\repo")).toBe(true);
    expect(detectExactHit("看看 pnpm 约定", "无", ["pnpm"])).toBe(true);
  });

  it("无关短词不误判", () => {
    expect(detectExactHit("今天天气不错", "数据库索引优化")).toBe(false);
    expect(detectExactHit("吗", "吗")).toBe(false);
  });
});

describe("MemoryStore.recall 接入 ranker", () => {
  const q = "端口 8991 是什么";

  function store() {
    const s = new MemoryStore({ now: () => NOW });
    s.restore({
      facts: [
        fact("port", "本地调试服务监听端口 8991", { tags: ["端口"], importance: 8 }),
        fact("build", "构建脚本使用 pnpm 与 turbo", { importance: 3 }),
        fact("color", "用户偏好深色主题", { importance: 9 }),
      ],
    });
    return s;
  }

  it("默认 similarity：分数与旧公式逐项一致", () => {
    const s = store();
    const hits = s.recall(q, 6, { workspaceId: "default" });
    expect(hits.length).toBeGreaterThan(0);
    const port = hits.find((hit) => hit.fact.id === "port");
    expect(port).toBeTruthy();
    const expected =
      effectiveValue(s.get("port") as never, NOW) * (0.2 + jaccardCJK(q, "本地调试服务监听端口 8991")) + 0.15;
    expect(port?.score).toBeCloseTo(expected, 10);
  });

  it("recallDetailed 返回命中理由；recall 仍只返回 fact+score（兼容旧调用）", () => {
    const s = store();
    const detailed = s.recallDetailed("端口 8991 是什么", 6, { workspaceId: "default" });
    expect(detailed.length).toBeGreaterThan(0);
    expect(Array.isArray(detailed[0].reasons)).toBe(true);
    expect(detailed[0].reasons.length).toBeGreaterThan(0);
    const plain = s.recall("端口 8991 是什么", 6, { workspaceId: "default" });
    expect(Object.keys(plain[0]).sort()).toEqual(["fact", "score"]);
  });

  it("hybrid 模式：同样候选下由信号（激活值）改变排序", () => {
    const s = store();
    // 两条都命中关键词：让「旧但精确」的 port 与「新但次要」的 build 竞争。
    const hits = s.recall("pnpm 端口", 6, {
      workspaceId: "default",
      ranking: {
        mode: "hybrid",
        signal: (f) => ({ activation: f.id === "build" ? 0.95 : 0.35, band: "L1" }),
      },
    });
    expect(hits[0]?.fact.id).toBe("build");
  });
});
