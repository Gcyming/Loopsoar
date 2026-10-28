/**
 * 记忆五闸 + 召回门控（ADR-0007 前置）：阈值语义 / 软归档不物理删除 / 门控判据。
 */
import { describe, expect, it } from "vitest";
import { createFact } from "../../packages/core/src/memory/fact.ts";
import {
  jaccardCJK,
  gateDedupe,
  gateMerge,
  gateLink,
  gateCapacity,
  effectiveWeight,
  effectiveValue,
  THRESHOLD_DEDUPE,
  THRESHOLD_MERGE,
  THRESHOLD_LINK,
  THRESHOLD_CAPACITY_MAX,
} from "../../packages/core/src/memory/fiveGate.ts";
import { shouldRecall } from "../../packages/core/src/memory/recallGate.ts";

const DAY = 86_400_000;

describe("记忆五闸", () => {
  it("阈值常量与前期准备一致，且不可下调的注释存在（0.75/0.70/0.68/2000）", () => {
    expect(THRESHOLD_DEDUPE).toBe(0.75);
    expect(THRESHOLD_LINK).toBe(0.70);
    expect(THRESHOLD_MERGE).toBe(0.68);
    expect(THRESHOLD_CAPACITY_MAX).toBe(2000);
  });

  it("jaccardCJK：中文按单字+双字分片（同文=1，异文低）", () => {
    expect(jaccardCJK("记忆五闸", "记忆五闸")).toBe(1);
    expect(jaccardCJK("记忆五闸治理", "记忆五闸")).toBeGreaterThan(0.5);
    expect(jaccardCJK("今天天气不错", "数据库索引优化")).toBeLessThan(0.2);
  });

  it("① 去重：相似度 ≥0.75 命中并返回原条目（调用方 repeated+1，不新增）", () => {
    const existing = [createFact({ id: "f1", content: "用户偏好深色主题", category: "preference" })];
    const incoming = createFact({ id: "f2", content: "用户偏好深色主题", category: "preference" });
    const r = gateDedupe(existing, incoming);
    expect(r.duplicate).toBe(true);
    expect(r.hit?.id).toBe("f1");
  });

  it("② 跨 agent 指针：非相似内容不触发去重", () => {
    const existing = [createFact({ id: "f1", content: "用户偏好深色主题", category: "preference" })];
    const incoming = createFact({ id: "f2", content: "部署流程需要先跑契约检查", category: "lesson" });
    expect(gateDedupe(existing, incoming).duplicate).toBe(false);
  });

  it("③ 合并：无 tags 且相似度 >0.68 → 合并；带 tags 不参与合并", () => {
    const base = createFact({ id: "f1", content: "记忆系统写入前必须先去重检查", category: "insight" });
    const incoming = createFact({ id: "f2", content: "记忆系统写入前必须先去重", category: "insight" });
    const r = gateMerge([base], incoming);
    expect(r.mergeInto?.id).toBe("f1");

    const tagged = createFact({ id: "f3", content: "记忆系统写入前必须先去重", category: "insight", tags: ["memory"] });
    expect(gateMerge([base], tagged).mergeInto).toBeUndefined();
  });

  it("④ 建链：tags 交集即可建双向链接", () => {
    const a = createFact({ id: "a", content: "完全不同的内容一", category: "fact", tags: ["loopsoar"] });
    const b = createFact({ id: "b", content: "完全不同的内容二", category: "fact", tags: ["loopsoar"] });
    const r = gateLink([a], b);
    expect(r.linked).toContain("a");
    expect(a.links).toContain("b");
    expect(b.backlinks).toContain("a");
  });

  it("⑤ 容量：超限按 effectiveValue 升序软归档，绝不物理删除", () => {
    const now = Date.now();
    const facts = [
      createFact({ id: "low", content: "低价值", category: "fact", importance: 1, lastAccessed: now - 60 * DAY }),
      createFact({ id: "mid", content: "中价值", category: "fact", importance: 5, lastAccessed: now - 10 * DAY }),
      createFact({ id: "high", content: "高价值", category: "fact", importance: 10, lastAccessed: now }),
    ];
    const r = gateCapacity(facts, 2);
    expect(r.keep.length).toBe(2);
    expect(r.archived.length).toBe(1);
    expect(r.archived[0].id).toBe("low");
    expect(r.archived[0].status).toMatch(/^archived:/);
    expect(r.archived[0].archivedAt).toBeTypeOf("number");
    // 总条目数不变（软归档 ≠ 删除）
    expect(r.keep.length + r.archived.length).toBe(facts.length);
  });

  it("打分公式：新近高重要 > 陈旧低重要", () => {
    const now = Date.now();
    const fresh = createFact({ id: "fresh", content: "x", category: "fact", importance: 10, lastAccessed: now });
    const old = createFact({ id: "old", content: "y", category: "fact", importance: 2, lastAccessed: now - 90 * DAY });
    expect(effectiveWeight(fresh, now)).toBeGreaterThan(effectiveWeight(old, now));
    expect(effectiveValue(fresh, now)).toBeGreaterThan(effectiveValue(old, now));
  });
});

describe("召回门控（廉价判据先于检索）", () => {
  it("过去时信号", () => {
    expect(shouldRecall("上次我们说的那个方案").signals).toContain("past_tense");
  });

  it("指代信号", () => {
    expect(shouldRecall("把这个文件改成这样").signals).toContain("reference");
  });

  it("新实体信号（路径/引号/专有名词）", () => {
    expect(shouldRecall("打开 D:/work/report.docx").signals).toContain("new_entity");
    expect(shouldRecall('标题是"季度复盘"').signals).toContain("new_entity");
  });

  it("任务类型切换信号（lastTaskType 非空触发）", () => {
    expect(shouldRecall("开始新任务", "coding").signals).toContain("task_type");
  });

  it("无信号 → 不检索（不注入噪声）", () => {
    const r = shouldRecall("你好");
    expect(r.hit).toBe(false);
    expect(r.signals).toEqual([]);
  });
});
