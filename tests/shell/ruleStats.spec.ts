import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RuleStatsStore } from "../../packages/shell/src/main/ruleStats.ts";

let root: string;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe("规则命中统计", () => {
  it("同一条规则累加次数，保留最近工具/目标", () => {
    root = mkdtempSync(path.join(tmpdir(), "loopsoar-rule-stats-"));
    let now = 1000;
    const store = new RuleStatsStore(path.join(root, "stats.json"), () => now++);
    store.record({ text: "不要修改 dist/ 下的文件", toolName: "write_file", target: "dist/a.js" });
    store.record({ text: "不要修改 dist/ 下的文件", toolName: "edit", target: "dist/b.js" });
    const hits = store.list();
    expect(hits).toHaveLength(1);
    expect(hits[0].count).toBe(2);
    expect(hits[0].lastTool).toBe("edit");
    expect(hits[0].lastTarget).toBe("dist/b.js");
  });

  it("重载后统计还在", () => {
    root = mkdtempSync(path.join(tmpdir(), "loopsoar-rule-stats-"));
    const file = path.join(root, "stats.json");
    new RuleStatsStore(file, () => 1).record({ text: "禁止读取 .env" });
    const again = new RuleStatsStore(file, () => 2);
    expect(again.list()[0].text).toBe("禁止读取 .env");
    expect(again.list()[0].count).toBe(1);
  });

  it("注入计数去重合并，flush 后可重载", () => {
    root = mkdtempSync(path.join(tmpdir(), "loopsoar-rule-stats-"));
    const file = path.join(root, "stats.json");
    const store = new RuleStatsStore(file);
    store.recordInjection(["必须用 pnpm", "必须用 pnpm", "提交信息用中文"]);
    store.recordInjection(["必须用 pnpm"]);
    store.flush();
    const again = new RuleStatsStore(file);
    expect(again.list().find((hit) => hit.text === "必须用 pnpm")?.injected).toBe(2);
    expect(again.list().find((hit) => hit.text === "提交信息用中文")?.injected).toBe(1);
  });

  it("旧 stats 没有 injected 字段也能读（迁移为 0）", () => {
    root = mkdtempSync(path.join(tmpdir(), "loopsoar-rule-stats-"));
    const file = path.join(root, "stats.json");
    require("node:fs").writeFileSync(file, JSON.stringify({ version: 1, hits: [{ text: "旧规则", count: 2, firstAt: 1, lastAt: 2 }] }));
    const store = new RuleStatsStore(file);
    expect(store.list()[0]).toMatchObject({ text: "旧规则", count: 2, injected: 0 });
  });

  it("空文本忽略；clear 清空", () => {
    root = mkdtempSync(path.join(tmpdir(), "loopsoar-rule-stats-"));
    const store = new RuleStatsStore(path.join(root, "stats.json"));
    store.record({ text: "  " });
    expect(store.list()).toEqual([]);
    store.record({ text: "必须用 pnpm" });
    store.clear();
    expect(store.list()).toEqual([]);
  });
});
