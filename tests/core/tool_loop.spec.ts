/**
 * 工具循环：单轮文本 / 工具轮（心跳+tool 事件）/ 外部中止。
 */
import { describe, expect, it } from "vitest";
import { runToolLoop, type ToolExecutor, type ToolCall } from "../../packages/core/src/tool_loop.ts";
import { MockLlmClient } from "../../packages/core/src/llm/index.ts";
import { SteerBus } from "../../packages/core/src/steerBus.ts";
import type { LoopEvent } from "../../packages/core/src/events.ts";

function baseOpts() {
  return {
    tools: () => [] as { name: string; description: string; parameters: unknown }[],
    limits: { maxRounds: 10, maxToolCalls: 10, maxTotalTokens: 1_000_000, maxWallClockMs: 60_000 },
    budget: { rounds: 0, toolCalls: 0, totalTokens: 0, wallClockMs: 0 },
    steers: new SteerBus(),
    heartbeatMs: 10_000,
  };
}

describe("工具循环", () => {
  it("单轮文本 → done，事件含 chunk/done", async () => {
    const llm = new MockLlmClient();
    llm.addScript([{ kind: "text", text: "你好，世界" }, { kind: "done" }]);
    const events: LoopEvent[] = [];
    const outcome = await runToolLoop({
      ...baseOpts(),
      llm,
      sink: (e) => events.push(e),
      executeTool: { invoke: async () => ({ ok: true, content: "" }) },
    });
    expect(outcome.status).toBe("done");
    expect(outcome.finalText).toContain("你好");
    expect(events.some((e) => e.type === "chunk")).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(true);
    // seq 递增
    for (let i = 1; i < events.length; i++) {
      expect(events[i].seq).toBeGreaterThan(events[i - 1].seq);
    }
  });

  it("工具轮：执行期发心跳，工具结果回灌后 done", async () => {
    const llm = new MockLlmClient();
    llm.addScript([
      { kind: "tool_call", toolCall: { id: "t1", name: "file_read", args: {} } },
      { kind: "text", text: "读取完成" },
      { kind: "done" },
    ]);
    const executeTool: ToolExecutor = {
      invoke: async (_c: ToolCall) => {
        await new Promise((r) => setTimeout(r, 60));
        return { ok: true, content: "文件内容" };
      },
    };
    const events: LoopEvent[] = [];
    const outcome = await runToolLoop({
      ...baseOpts(),
      heartbeatMs: 10,
      llm,
      executeTool,
      sink: (e) => events.push(e),
    });
    expect(outcome.status).toBe("done");
    expect(events.some((e) => e.type === "tool")).toBe(true);
    expect(events.some((e) => e.type === "heartbeat")).toBe(true);
  });


  it("防循环：相同工具+相同参数重复调用到达阈值 → no-progress（原因明确）", async () => {
    const client = {
      async *invoke() {
        yield { kind: "tool_call" as const, toolCall: { id: "repeat", name: "file_read", args: { path: "same.txt" } } };
        yield { kind: "done" as const };
      },
    };
    const outcome = await runToolLoop({
      ...baseOpts(),
      llm: client as never,
      // 阈值可配置：这里显式 5，验证计数与中断原因（默认 30 见下一条）
      repeatToolStopAt: 5,
      executeTool: { invoke: async () => ({ ok: true, content: "same result" }) },
      sink: () => {},
    });
    expect(outcome.status).toBe("no-progress");
    expect(outcome.reason).toContain("防循环");
  });

  it("防循环阈值可配置：默认更宽松（30），自定义 7 时仍在第 7 次停止", async () => {
    const client = {
      async *invoke() {
        yield { kind: "tool_call" as const, toolCall: { id: "repeat", name: "file_read", args: { path: "same.txt" } } };
        yield { kind: "done" as const };
      },
    };
    let calls = 0;
    const outcome = await runToolLoop({
      ...baseOpts(),
      limits: { maxRounds: 40, maxToolCalls: 40 },
      repeatToolWarnAt: 3,
      repeatToolStopAt: 7,
      llm: client as never,
      executeTool: {
        invoke: async () => {
          calls += 1;
          return { ok: true, content: "same result" };
        },
      },
      sink: () => {},
    });
    expect(calls).toBe(7);
    expect(outcome.status).toBe("no-progress");
    expect(outcome.reason).toContain("7 次");
  });

  it("超长工具结果回灌上下文时截断并标注（UI 仍保留完整结果）", async () => {
    const requests: { messages: { role: string; content: string }[] }[] = [];
    const client = {
      async *invoke(req: { messages: { role: string; content: string }[] }) {
        requests.push({ messages: req.messages.map((m) => ({ ...m })) });
        if (requests.length === 1) {
          yield { kind: "tool_call" as const, toolCall: { id: "big", name: "browser_snapshot", args: {} } };
          yield { kind: "done" as const };
          return;
        }
        yield { kind: "text" as const, text: "完成" };
        yield { kind: "done" as const };
      },
    };
    const outcome = await runToolLoop({
      ...baseOpts(),
      llm: client as never,
      executeTool: { invoke: async () => ({ ok: true, content: "x".repeat(30000) }) },
      sink: () => {},
    });
    expect(outcome.status).toBe("done");
    const toolMessage = requests[1].messages.find((m) => m.role === "tool")!;
    expect(toolMessage.content.length).toBeLessThan(25_000);
    expect(toolMessage.content).toContain("完整内容见会话中的工具卡片");
  });

  it("外部中止 → aborted", async () => {
    const llm = new MockLlmClient();
    llm.addScript([
      { kind: "tool_call", toolCall: { id: "t1", name: "file_read", args: {} } },
      { kind: "done" },
    ]);
    const controller = new AbortController();
    const executeTool: ToolExecutor = {
      invoke: async () => {
        await new Promise((r) => setTimeout(r, 5000));
        return { ok: true, content: "" };
      },
    };
    setTimeout(() => controller.abort(), 30);
    const outcome = await runToolLoop({
      ...baseOpts(),
      llm,
      executeTool,
      signal: controller.signal,
      sink: () => {},
    });
    expect(outcome.status).toBe("aborted");
  }, 15_000);
});
