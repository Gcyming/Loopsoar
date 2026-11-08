/**
 * 中断链路回归（task-3）：用户点「停止」必须立即生效，而不是等下一个 chunk / 工具返回。
 *
 * 覆盖三条此前会卡死的路径：
 *   ① LLM 迟迟不吐 chunk（上游卡住 / 客户端忽略 signal）→ 仍要立即 aborted，且不得发 error 事件；
 *   ② 工具执行中（MCP/终端/ask_user 可能几分钟）→ 立即 aborted，且不再发起下一轮 LLM；
 *   ③ signal 在循环启动前就已 abort（stop 早于 run 的竞态）→ 直接 aborted，不发任何 LLM 请求。
 */
import { describe, expect, it } from "vitest";
import { runToolLoop, type ToolExecutor, type ToolLoopOpts } from "../../packages/core/src/tool_loop.ts";
import { SteerBus } from "../../packages/core/src/steerBus.ts";
import type { LoopEvent } from "../../packages/core/src/events.ts";

function baseOpts() {
  return {
    tools: () => [] as { name: string; description: string; parameters: unknown }[],
    limits: { maxRounds: 10, maxToolCalls: 10, maxTotalTokens: 1_000_000, maxWallClockMs: 60_000 },
    budget: { rounds: 0, toolCalls: 0, totalTokens: 0, wallClockMs: 0 },
    steers: new SteerBus(),
    heartbeatMs: 10_000,
    noProgressRounds: 100,
  };
}

const emptyExecutor: ToolExecutor = { invoke: async () => ({ ok: true, content: "" }) };

/** 永不返回、也不观察 signal 的 LLM（模拟上游卡死 + 客户端未实现中止）。 */
function hangingLlm(counter: { calls: number }) {
  return {
    invoke() {
      counter.calls += 1;
      return (async function* () {
        await new Promise(() => {});
      })();
    },
  } as unknown as ToolLoopOpts["llm"];
}

/** 先吐一个 tool_call，之后卡住的 LLM（模拟「工具执行期间上游还在等」）。 */
function toolThenHangLlm(counter: { calls: number }) {
  return {
    invoke() {
      counter.calls += 1;
      return (async function* () {
        yield { kind: "tool_call" as const, toolCall: { id: "t1", name: "slow_tool", args: {} } };
        await new Promise(() => {});
      })();
    },
  } as unknown as ToolLoopOpts["llm"];
}

describe("工具循环：中止即时生效", () => {
  it("LLM 卡住（无 chunk）时 abort → 立即 aborted，不发 error 事件", async () => {
    const counter = { calls: 0 };
    const controller = new AbortController();
    const events: LoopEvent[] = [];
    const started = Date.now();
    const timer = setTimeout(() => controller.abort(), 30);

    const outcome = await runToolLoop({
      ...baseOpts(),
      llm: hangingLlm(counter),
      executeTool: emptyExecutor,
      signal: controller.signal,
      sink: (event) => events.push(event),
    });
    clearTimeout(timer);

    expect(outcome.status).toBe("aborted");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(counter.calls).toBe(1);
    // 中止不是「真实失败」：UI 不该收到红色 error
    expect(events.some((event) => event.type === "error")).toBe(false);
  }, 10_000);

  it("工具执行中 abort → 立即 aborted，工具被放弃且不再发起下一轮 LLM", async () => {
    const counter = { calls: 0 };
    const toolCalls: string[] = [];
    const controller = new AbortController();
    const events: LoopEvent[] = [];
    const started = Date.now();
    const timer = setTimeout(() => controller.abort(), 30);

    const executeTool: ToolExecutor = {
      invoke: async () => {
        toolCalls.push("slow_tool");
        await new Promise(() => {});
        return { ok: true, content: "" };
      },
    };

    const outcome = await runToolLoop({
      ...baseOpts(),
      llm: toolThenHangLlm(counter),
      executeTool,
      signal: controller.signal,
      sink: (event) => events.push(event),
    });
    clearTimeout(timer);

    expect(outcome.status).toBe("aborted");
    expect(Date.now() - started).toBeLessThan(1000);
    // 工具只被调用一次；没有第二轮 LLM（否则说明中止后还在推进）
    expect(toolCalls).toEqual(["slow_tool"]);
    expect(counter.calls).toBe(1);
    expect(events.some((event) => event.type === "error")).toBe(false);
    // 运行中的工具卡要落定，避免历史里永远显示「执行中」
    const toolEvent = events.find((event) => event.type === "tool");
    expect(toolEvent).toBeTruthy();
    expect((toolEvent!.data as { result?: { error?: string } }).result?.error).toBe("已停止");
  }, 10_000);

  it("signal 启动前已 abort（stop 早于 run 的竞态）→ 直接 aborted，不发 LLM 请求", async () => {
    const counter = { calls: 0 };
    const controller = new AbortController();
    controller.abort();
    const events: LoopEvent[] = [];

    const outcome = await runToolLoop({
      ...baseOpts(),
      llm: hangingLlm(counter),
      executeTool: emptyExecutor,
      signal: controller.signal,
      sink: (event) => events.push(event),
    });

    expect(outcome.status).toBe("aborted");
    expect(counter.calls).toBe(0);
    expect(events).toHaveLength(0);
  }, 10_000);
});
