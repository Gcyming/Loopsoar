/**
 * 工具循环截断恢复（m02515 截断根除）：
 *   · 工具调用参数被上游长度上限截断 → 丢弃本轮残缺工具轮、要求重发，不把残缺调用回灌给模型；
 *   · 续写次数用尽仍被截断 → 正文末尾追加显式标记（绝不静默截断）；
 *   · maxOutputTokens 显式透传到 LLM 请求（从源头减少上游默认 max_tokens 过小导致的截断）。
 */
import { describe, expect, it } from "vitest";
import { runToolLoop, type ToolExecutor } from "../../packages/core/src/tool_loop.ts";
import { MockLlmClient, type LlmChunk, type LlmClient, type LlmRequest } from "../../packages/core/src/llm/index.ts";
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

describe("截断恢复", () => {
  it("工具调用被 length 截断 → 丢弃残缺工具轮并请求重发，最终正文完整", async () => {
    const llm = new MockLlmClient();
    // 第 1 轮：工具调用 + 被长度上限截断（参数可能残缺）
    llm.addScript([
      { kind: "text", text: "我来读文件" },
      { kind: "tool_call", toolCall: { id: "t1", name: "file_read", args: {} } },
      { kind: "done", finishReason: "length" },
    ]);
    // 第 2 轮：模型重发/继续，正常结束
    llm.addScript([{ kind: "text", text: "最终正文完整。" }, { kind: "done", finishReason: "stop" }]);
    let invokes = 0;
    const executeTool: ToolExecutor = {
      invoke: async () => {
        invokes += 1;
        return { ok: true, content: "content" };
      },
    };
    const events: LoopEvent[] = [];
    const outcome = await runToolLoop({ ...baseOpts(), llm, executeTool, sink: (e) => events.push(e) });
    expect(outcome.status).toBe("done");
    expect(outcome.finalText).toContain("最终正文完整。");
    const notes = events.filter((e) => e.type === "progress").map((e) => String(e.data?.note ?? ""));
    expect(notes.some((n) => n.includes("工具调用参数被上游长度上限截断"))).toBe(true);
    // 工具调用确实执行过（流式阶段即时执行），但残缺工具轮不会回灌给下一轮（由 progress 文案与最终收束证明）
    expect(invokes).toBe(1);
  });

  it("续写次数用尽仍被截断 → 末尾追加显式中断标记（不静默）", async () => {
    const llm = new MockLlmClient();
    llm.addScript([{ kind: "text", text: "第一段" }, { kind: "done", finishReason: "length" }]);
    llm.addScript([{ kind: "text", text: "第二段" }, { kind: "done", finishReason: "length" }]);
    const events: LoopEvent[] = [];
    const outcome = await runToolLoop({
      ...baseOpts(),
      llm,
      executeTool: { invoke: async () => ({ ok: true, content: "" }) },
      sink: (e) => events.push(e),
      maxLengthContinuations: 1,
    });
    expect(outcome.status).toBe("done");
    expect(outcome.finalText).toContain("（输出因上游长度上限中断");
    expect(outcome.finalText).toContain("已自动续写 1 次仍未结束");
    const notes = events.filter((e) => e.type === "progress").map((e) => String(e.data?.note ?? ""));
    expect(notes.some((n) => n.includes("自动续写次数用尽"))).toBe(true);
  });

  it("finish_reason=content_filter → 可见 progress 提示（不静默）", async () => {
    const llm = new MockLlmClient();
    llm.addScript([{ kind: "text", text: "部分正文" }, { kind: "done", finishReason: "content_filter" }]);
    const events: LoopEvent[] = [];
    const outcome = await runToolLoop({
      ...baseOpts(),
      llm,
      executeTool: { invoke: async () => ({ ok: true, content: "" }) },
      sink: (e) => events.push(e),
    });
    expect(outcome.status).toBe("done");
    const notes = events.filter((e) => e.type === "progress").map((e) => String(e.data?.note ?? ""));
    expect(notes.some((n) => n.includes("content_filter"))).toBe(true);
  });

  it("空正文（只回思考）→ 自动重问一次并拿到最终正文", async () => {
    const llm = new MockLlmClient();
    // 第 1 轮：只返回思考，正文为空（hy4-flash-free 等免费模型偶发）
    llm.addScript([
      { kind: "reasoning", text: "让我想想用户的问题……" },
      { kind: "done", finishReason: "stop" },
    ]);
    // 第 2 轮：自动重问后给出正文
    llm.addScript([{ kind: "text", text: "看得见，工作区里有 3 个文件。" }, { kind: "done", finishReason: "stop" }]);
    const events: LoopEvent[] = [];
    const outcome = await runToolLoop({
      ...baseOpts(),
      llm,
      executeTool: { invoke: async () => ({ ok: true, content: "" }) },
      sink: (e) => events.push(e),
    });
    expect(outcome.status).toBe("done");
    expect(outcome.finalText).toContain("看得见");
    const notes = events.filter((e) => e.type === "progress").map((e) => String(e.data?.note ?? ""));
    expect(notes.some((n) => n.includes("没有返回正文"))).toBe(true);
  });

  it("空正文重问次数用尽后仍为空 → 交给上层给出可见兜底文案", async () => {
    const llm = new MockLlmClient();
    llm.addScript([{ kind: "reasoning", text: "思考中" }, { kind: "done", finishReason: "stop" }]);
    llm.addScript([{ kind: "done", finishReason: "stop" }]);
    const outcome = await runToolLoop({
      ...baseOpts(),
      llm,
      executeTool: { invoke: async () => ({ ok: true, content: "" }) },
      sink: () => undefined,
    });
    expect(outcome.status).toBe("done");
    expect(outcome.finalText.trim()).toBe("");
  });

  it("不向上游传显式 max_tokens（避免不同供应商上限差异导致 400；长度截断靠 finish_reason 续写兜底）", async () => {
    const seen: (number | undefined)[] = [];
    const client: LlmClient = {
      async *invoke(req: LlmRequest): AsyncIterable<LlmChunk> {
        seen.push(req.maxTokens);
        yield { kind: "text", text: "ok" };
        yield { kind: "done", finishReason: "stop" };
      },
    };
    const outcome = await runToolLoop({
      ...baseOpts(),
      llm: client,
      executeTool: { invoke: async () => ({ ok: true, content: "" }) },
      sink: () => undefined,
    });
    expect(outcome.status).toBe("done");
    expect(seen[0]).toBeUndefined();
  });
});
