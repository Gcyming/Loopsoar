/**
 * 长度截断自动续写：上游 finishReason="length" 时自动续写，避免长回复断在半句。
 * 真实背景：OpenAI 兼容上游默认 max_tokens 很小，长回答会被 finish_reason=length 截断；
 * 旧实现丢弃 finish_reason，用户看到的就是「消息被截断」。
 */
import { describe, expect, it } from "vitest";
import { runToolLoop, type ToolExecutor } from "../../packages/core/src/tool_loop.ts";
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

const executeTool: ToolExecutor = { invoke: async () => ({ ok: true, content: "" }) };

describe("长度截断自动续写", () => {
  it("finishReason=length → 自动续写并拼接 finalText，done 只发一次", async () => {
    const llm = new MockLlmClient();
    llm.addScript([{ kind: "text", text: "第一段被截断在" }, { kind: "done", finishReason: "length" }]);
    llm.addScript([{ kind: "text", text: "这里续完。" }, { kind: "done", finishReason: "stop" }]);
    const events: LoopEvent[] = [];
    const outcome = await runToolLoop({
      ...baseOpts(),
      llm,
      executeTool,
      sink: (e) => events.push(e),
    });
    expect(outcome.status).toBe("done");
    expect(outcome.finalText).toBe("第一段被截断在这里续完。");
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
    const notes = events.filter((e) => e.type === "progress").map((e) => String(e.data?.note ?? ""));
    expect(notes.some((n) => n.includes("自动续写"))).toBe(true);
  });

  it("正常 finishReason=stop 不续写", async () => {
    const llm = new MockLlmClient();
    llm.addScript([{ kind: "text", text: "完整回答。" }, { kind: "done", finishReason: "stop" }]);
    const events: LoopEvent[] = [];
    const outcome = await runToolLoop({ ...baseOpts(), llm, executeTool, sink: (e) => events.push(e) });
    expect(outcome.status).toBe("done");
    expect(outcome.finalText).toBe("完整回答。");
    expect(events.some((e) => e.type === "progress" && String(e.data?.note ?? "").includes("自动续写"))).toBe(false);
  });

  it("没有 finishReason 的旧客户端不续写（向后兼容）", async () => {
    const llm = new MockLlmClient();
    llm.addScript([{ kind: "text", text: "旧客户端输出。" }, { kind: "done" }]);
    const events: LoopEvent[] = [];
    const outcome = await runToolLoop({ ...baseOpts(), llm, executeTool, sink: (e) => events.push(e) });
    expect(outcome.status).toBe("done");
    expect(outcome.finalText).toBe("旧客户端输出。");
    expect(events.some((e) => e.type === "progress" && String(e.data?.note ?? "").includes("自动续写"))).toBe(false);
  });

  it("受 maxLengthContinuations 封顶：达到上限后收束（不会无限续写）", async () => {
    const llm = new MockLlmClient();
    llm.addScript([{ kind: "text", text: "A" }, { kind: "done", finishReason: "length" }]);
    llm.addScript([{ kind: "text", text: "B" }, { kind: "done", finishReason: "length" }]);
    llm.addScript([{ kind: "text", text: "C" }, { kind: "done", finishReason: "length" }]);
    const events: LoopEvent[] = [];
    const outcome = await runToolLoop({
      ...baseOpts(),
      llm,
      executeTool,
      sink: (e) => events.push(e),
      maxLengthContinuations: 2,
    });
    expect(outcome.status).toBe("done");
    // 续写次数用尽仍被截断：正文完整保留 + 末尾显式中断标记（绝不静默截断）
    expect(outcome.finalText).toContain("ABC");
    expect(outcome.finalText).toContain("（输出因上游长度上限中断");
    const continuationNotes = events.filter(
      (e) => e.type === "progress" && String(e.data?.note ?? "").includes("自动续写（第"),
    );
    expect(continuationNotes).toHaveLength(2);
    const exhaustionNotes = events.filter(
      (e) => e.type === "progress" && String(e.data?.note ?? "").includes("自动续写次数用尽"),
    );
    expect(exhaustionNotes).toHaveLength(1);
  });
});
