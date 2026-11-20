import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { TraceStore } from "../../packages/shell/src/main/traceStore.ts";
import { registerTraceTools } from "../../packages/shell/src/main/traceTools.ts";

let root = "";
let store: TraceStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-trace-"));
  store = new TraceStore(path.join(root, "traces"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("TraceStore", () => {
  it("工具开始/结束配对耗时，汇总按工具聚合", () => {
    store.begin("s1", "file_read");
    store.observe({ sessionId: "s1", toolName: "file_read", ok: true, args: { path: "a.ts" } });
    store.begin("s1", "file_read");
    store.observe({ sessionId: "s1", toolName: "file_read", ok: false, error: "ENOENT" });
    store.turn({ sessionId: "s1", rounds: 2, toolCalls: 2, tokens: 120, note: "done" });

    const records = store.read("s1", 10);
    expect(records.filter((r) => r.kind === "tool").length).toBe(2);
    expect(records[0].ms).toBeGreaterThanOrEqual(0);
    expect(records[0].args).toBe("path=a.ts");

    const stats = store.summary("s1");
    expect(stats).toMatchObject({ turns: 1, toolCalls: 2, failures: 1, tokens: 120 });
    expect(stats.byTool[0]).toMatchObject({ tool: "file_read", calls: 2, failures: 1 });
    expect(stats.lastError).toBe("file_read: ENOENT");
  });

  it("参数脱敏：敏感键只记键名，长值截断，不落完整输出", () => {
    const long = "x".repeat(200);
    store.observe({
      sessionId: "s2",
      toolName: "browser_type",
      ok: true,
      args: { text: long, password: "hunter2", authorization: "Bearer abc", value: 3 },
    });
    const record = store.read("s2", 1)[0];
    expect(record.args).toContain("password=<redacted>");
    expect(record.args).toContain("authorization=<redacted>");
    expect(record.args).not.toContain("hunter2");
    expect(record.args).not.toContain("Bearer abc");
    expect(record.args!.length).toBeLessThan(400);
  });

  it("按会话隔离，空会话返回空", () => {
    store.observe({ sessionId: "a", toolName: "x", ok: true });
    expect(store.read("b", 10)).toEqual([]);
    expect(store.summary("b").toolCalls).toBe(0);
  });

  it("回合记录模型与 input/output 拆分，成本按回合累加", () => {
    store.turn({ sessionId: "cost", rounds: 1, toolCalls: 2, tokens: 1500, model: "gpt-4o", inputTokens: 1000, outputTokens: 500, costUsd: 0.0075 });
    store.turn({ sessionId: "cost", rounds: 1, toolCalls: 1, tokens: 100, model: "gpt-4o", inputTokens: 80, outputTokens: 20, costUsd: 0.0004 });
    const stats = store.summary("cost");
    expect(stats.inputTokens).toBe(1080);
    expect(stats.outputTokens).toBe(520);
    expect(stats.costUsd).toBeCloseTo(0.0079, 6);
    expect(stats.model).toBe("gpt-4o");
    expect(stats.tokens).toBe(1600);
  });

  it("report 同时给出聚合、最近记录与定价说明（limit 有上限）", () => {
    for (let i = 0; i < 8; i += 1) {
      store.observe({ sessionId: "r", toolName: "file_read", ok: true, args: { path: `${i}.ts` } });
    }
    const report = store.report("r", 3);
    expect(report.sessionId).toBe("r");
    expect(report.summary.toolCalls).toBe(8);
    expect(report.records.length).toBe(3);
    expect(report.pricingNote).toContain("参考价");
    expect(store.report("r", 9999).records.length).toBe(8);
  });
});

describe("trace 工具", () => {
  function registry(): ToolRegistry {
    const reg = new ToolRegistry();
    registerTraceTools(reg, store);
    return reg;
  }

  it("trace_summary 输出表格；trace_read 输出带脱敏参数的行", async () => {
    store.observe({ sessionId: "s3", toolName: "file_write", ok: true, args: { path: "a.ts" } });
    store.turn({ sessionId: "s3", rounds: 1, toolCalls: 1, tokens: 9 });
    const reg = registry();

    const summary = await reg.get("trace_summary")!.execute({ agentId: "t", sessionId: "s3", params: {}, platform: {} });
    expect(summary.ok).toBe(true);
    expect(summary.content).toContain("file_write");
    expect(summary.content).toContain("| 工具 | 调用 | 失败 | 平均 | 最大 |");

    const read = await reg.get("trace_read")!.execute({ agentId: "t", sessionId: "s3", params: { limit: 5 }, platform: {} });
    expect(read.ok).toBe(true);
    expect(read.content).toContain("path=a.ts");
    expect(read.content).toContain("回合结束");
  });

  it("没有记录时给可读提示而不是空串", async () => {
    const reg = registry();
    const result = await reg.get("trace_read")!.execute({ agentId: "t", sessionId: "none", params: {}, platform: {} });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("还没有 trace 记录");
  });
});
