/**
 * 工具循环 · 引导续轮（移植 slime A-1061⑥）：
 * 模型只出正文、没有工具轮时，若运行中还有插入的「引导」，必须在**同一轮**续跑 ——
 * 既不新开用户轮、也不打断当前输出；UI 依据 steer 事件把它折进思考历程。
 */
import { describe, expect, it } from "vitest";
import { runToolLoop, type ToolExecutor } from "../../packages/core/src/tool_loop.ts";
import { SteerBus } from "../../packages/core/src/steerBus.ts";
import type { LoopEvent } from "../../packages/core/src/events.ts";

describe("工具循环 · 引导续轮", () => {
  it("正文轮收尾时投递引导 → 同轮续跑，emit steer 事件，最终只 done 一次", async () => {
    const steers = new SteerBus();
    const requests: Array<{ messages: unknown[] }> = [];
    let calls = 0;
    const client = {
      async *invoke(req: { messages?: unknown[] }) {
        requests.push({ messages: req.messages ?? [] });
        calls += 1;
        if (calls === 1) {
          yield { kind: "text" as const, text: "第一段正文" };
          // 模拟用户在模型还在输出时插入一条引导（落进 steer 缓冲）
          steers.push({ id: "steer-1", text: "把开头改成一句反问。" });
          yield { kind: "done" as const };
          return;
        }
        const payload = JSON.stringify(req.messages ?? []);
        yield {
          kind: "text" as const,
          text: payload.includes("把开头改成一句反问") ? "已按引导补充。" : "没有收到引导。",
        };
        yield { kind: "done" as const };
      },
    };
    const events: LoopEvent[] = [];
    const outcome = await runToolLoop({
      tools: () => [],
      limits: { maxRounds: 10, maxToolCalls: 10, maxTotalTokens: 1_000_000, maxWallClockMs: 60_000 },
      budget: { rounds: 0, toolCalls: 0, totalTokens: 0, wallClockMs: 0 },
      steers,
      heartbeatMs: 10_000,
      llm: client as never,
      sink: (e) => events.push(e),
      executeTool: { invoke: async () => ({ ok: true, content: "" }) } as ToolExecutor,
    });

    // 同轮续跑：第二轮 LLM 调用拿到了注入的引导文案
    expect(calls).toBe(2);
    expect(JSON.stringify(requests[1]?.messages ?? [])).toContain("【运行中插入的指令】");
    expect(JSON.stringify(requests[1]?.messages ?? [])).toContain("把开头改成一句反问");

    // steer 事件只发一次，带 id/text（UI 据此折进思考历程）
    const steerEvents = events.filter((e) => e.type === "steer");
    expect(steerEvents).toHaveLength(1);
    const items = (steerEvents[0].data as { items: Array<{ id: string; text: string }> }).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "steer-1", text: "把开头改成一句反问。" });

    // 输出仍在同一个 assistant 轮里累积；done 只发一次
    expect(outcome.status).toBe("done");
    expect(outcome.finalText).toContain("第一段正文");
    expect(outcome.finalText).toContain("已按引导补充");
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
    // 引导已被消费，不残留（否则会被下一轮重复注入）
    expect(steers.size()).toBe(0);
  });

  it("没有引导时行为不变：正文轮直接 done（不多跑一轮）", async () => {
    const steers = new SteerBus();
    let calls = 0;
    const client = {
      async *invoke() {
        calls += 1;
        yield { kind: "text" as const, text: "直接收尾。" };
        yield { kind: "done" as const };
      },
    };
    const events: LoopEvent[] = [];
    const outcome = await runToolLoop({
      tools: () => [],
      limits: { maxRounds: 10, maxToolCalls: 10, maxTotalTokens: 1_000_000, maxWallClockMs: 60_000 },
      budget: { rounds: 0, toolCalls: 0, totalTokens: 0, wallClockMs: 0 },
      steers,
      heartbeatMs: 10_000,
      llm: client as never,
      sink: (e) => events.push(e),
      executeTool: { invoke: async () => ({ ok: true, content: "" }) } as ToolExecutor,
    });
    expect(calls).toBe(1);
    expect(outcome.status).toBe("done");
    expect(events.filter((e) => e.type === "steer")).toHaveLength(0);
  });
});
