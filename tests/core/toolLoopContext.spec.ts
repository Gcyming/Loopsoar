/**
 * loop 内上下文压缩接线：每轮请求前按 token 检测、压缩并上报上下文进度。
 * 验收点：
 *   ① 长工具对话不会把窗口撑爆（压缩确实发生在 loop 里，而不是回合开始前）；
 *   ② 进度事件带 context 快照（UI 环据此推进）；
 *   ③ 上游返回 usage.inputTokens 后改用实测值（覆盖估算）。
 */
import { describe, expect, it } from "vitest";
import { runToolLoop } from "../../packages/core/src/tool_loop.ts";
import { MockLlmClient, type LlmMessage } from "../../packages/core/src/llm/index.ts";
import { SteerBus } from "../../packages/core/src/steerBus.ts";
import type { LoopEvent } from "../../packages/core/src/events.ts";

function baseOpts(llm: MockLlmClient, messages: LlmMessage[]) {
  return {
    llm,
    messages,
    tools: () => [] as { name: string; description: string; parameters: unknown }[],
    limits: { maxRounds: 6, maxToolCalls: 6, maxTotalTokens: 1_000_000, maxWallClockMs: 30_000 },
    budget: { rounds: 0, toolCalls: 0, totalTokens: 0, wallClockMs: 0 },
    steers: new SteerBus(),
    heartbeatMs: 10_000,
    executeTool: { invoke: async () => ({ ok: true, content: "ok" }) },
  };
}

function bigHistory(count: number, chars: number): LlmMessage[] {
  return [
    { role: "system", content: "系统提示" },
    ...Array.from({ length: count }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: "第" + i + "条：" + "长".repeat(chars),
    })),
  ];
}

describe("loop 内上下文压缩", () => {
  it("超窗口时压缩早期消息，并上报 context 进度", async () => {
    const llm = new MockLlmClient();
    llm.addScript([{ kind: "text", text: "收到" }, { kind: "done" }]);
    const events: LoopEvent[] = [];
    const outcome = await runToolLoop({
      ...baseOpts(llm, bigHistory(40, 300)),
      context: { windowTokens: 6_000 },
      sink: (event) => events.push(event),
    });

    expect(outcome.status).toBe("done");
    const progress = events
      .filter((event) => event.type === "progress")
      .map((event) => event.data as {
        compressed?: boolean;
        dropped?: number;
        context?: { used?: number; cap?: number; pct?: number; source?: string };
      });

    const compressed = progress.find((item) => item.compressed === true);
    expect(compressed).toBeTruthy();
    expect(compressed?.dropped ?? 0).toBeGreaterThan(0);

    const context = progress.find((item) => item.context)?.context;
    expect(context?.cap).toBe(6_000);
    expect(context?.used ?? 0).toBeGreaterThan(0);
    expect(context?.source).toBe("estimated");
  });

  it("上游 usage.inputTokens 到达后：上下文进度改用实测值", async () => {
    const llm = new MockLlmClient();
    llm.addScript([
      { kind: "usage", tokens: 1_000, inputTokens: 4_321, outputTokens: 12 },
      { kind: "text", text: "hi" },
      { kind: "done" },
    ]);
    const events: LoopEvent[] = [];
    const outcome = await runToolLoop({
      ...baseOpts(llm, bigHistory(2, 20)),
      context: { windowTokens: 8_000 },
      sink: (event) => events.push(event),
    });

    expect(outcome.status).toBe("done");
    const measured = events
      .filter((event) => event.type === "progress")
      .map((event) => event.data as { context?: { used?: number; cap?: number; source?: string } })
      .map((item) => item.context)
      .find((context) => context?.source === "measured");
    expect(measured).toBeTruthy();
    expect(measured?.used).toBe(4_321);
    expect(measured?.cap).toBe(8_000);
  });

  it("未提供 context 预算时不压缩（保持旧行为）", async () => {
    const llm = new MockLlmClient();
    llm.addScript([{ kind: "text", text: "ok" }, { kind: "done" }]);
    const events: LoopEvent[] = [];
    const outcome = await runToolLoop({
      ...baseOpts(llm, bigHistory(40, 300)),
      sink: (event) => events.push(event),
    });
    expect(outcome.status).toBe("done");
    const progress = events.filter((event) => event.type === "progress").map((event) => event.data as { compressed?: boolean });
    expect(progress.some((item) => item.compressed === true)).toBe(false);
  });
});
