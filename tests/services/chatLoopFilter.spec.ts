/**
 * ChatService 增强接线：Agent-Loop 注入（runLoop）+ 输出过滤（身份边界）+ 每轮声称核验。
 *
 * 为什么这些断言：
 *   · runLoop 是关键开关：注入后必须真的替代内置 runToolLoop（否则 LoopRegistry 白接线）；
 *   · 输出过滤必须跨 chunk（「OpenAI」被两个 chunk 切开也不能漏），finalText 还要整体再过滤；
 *   · verifyRound 只在「有可疑声称 + 整段没用过工具」时才拒绝，避免对正常流程误伤。
 * 说明：假 platform 只提供 fs.exists（本文件不执行真实工具）。
 */
import { describe, expect, it } from "vitest";
import { MockLlmClient } from "../../packages/core/src/llm/index.ts";
import { ChatService, type ChatLoopRunner } from "../../packages/services/src/chat.ts";
import type { LoopsoarPlatform } from "../../packages/core/src/platform/index.ts";

function usage() {
  return { rounds: 1, toolCalls: 0, totalTokens: 0, wallClockMs: 0 };
}

function fakePlatform(exists: (p: string) => Promise<boolean>): LoopsoarPlatform {
  return { fs: { exists } } as unknown as LoopsoarPlatform;
}

/** 收集结果里所有 chunk 事件文本（meta.type === "chunk"）。 */
function chunkTextOf(result: Awaited<ReturnType<ChatService["stream"]>>): string {
  return result.chunks
    .flatMap((batch) => batch.chunks)
    .filter((chunk) => chunk.meta?.type === "chunk")
    .map((chunk) => chunk.content)
    .join("");
}

describe("Agent-Loop 注入（runLoop）", () => {
  it("注入 runLoop → 替代内置 runToolLoop，并透传完整 ToolLoopOpts + sessionId", async () => {
    let captured: Parameters<ChatLoopRunner>[0] | null = null;
    const service = new ChatService({
      llm: new MockLlmClient(),
      platform: fakePlatform(async () => true),
      runLoop: async (input) => {
        captured = input;
        return { status: "done", reason: "injected-loop", finalText: "注入循环完成", usage: usage() };
      },
    });

    const result = await service.stream({ message: "hi", sessionId: "sess-inject" });

    expect(result.status).toBe("done");
    expect(result.reason).toBe("injected-loop");
    expect(result.finalText).toContain("注入循环完成");
    expect(captured).not.toBeNull();
    expect(captured!.sessionId).toBe("sess-inject");
    // 完整运行参数透传（loopRegistry 回退时用同一 ctx 重跑，不能丢）
    expect(typeof captured!.sink).toBe("function");
    expect(typeof captured!.tools).toBe("function");
    expect(typeof captured!.executeTool.invoke).toBe("function");
    expect(Array.isArray(captured!.messages)).toBe(true);
    expect(captured!.budget).toEqual({ rounds: 0, toolCalls: 0, totalTokens: 0, wallClockMs: 0 });
    // platform 存在 → 每轮声称核验已接线
    expect(typeof captured!.verifyRound).toBe("function");
  });

  it("runLoop 缺省 → 内置 runToolLoop 照常工作（注入是可选增强，不破坏原有链路）", async () => {
    const llm = new MockLlmClient();
    llm.addScript([{ kind: "text", text: "内置循环回复" }, { kind: "done" }]);
    const service = new ChatService({ llm, platform: fakePlatform(async () => true) });
    const result = await service.stream({ message: "hi" });
    expect(result.status).toBe("done");
    expect(result.finalText).toContain("内置循环回复");
  });
});

describe("输出过滤（身份边界）", () => {
  const SPLIT_SCRIPT = (input: Parameters<ChatLoopRunner>[0]): void => {
    // 「OpenAI」被切成两个 chunk：验证跨 chunk 缓冲匹配
    input.sink({ seq: 0, type: "chunk", data: { text: "我是由 Open" }, ts: 0 });
    input.sink({ seq: 1, type: "chunk", data: { text: "AI 开发的模型" }, ts: 0 });
  };

  it("默认开启：跨 chunk 的模型自称被掩码，finalText 也不含底层模型名", async () => {
    const service = new ChatService({
      llm: new MockLlmClient(),
      platform: fakePlatform(async () => true),
      runLoop: async (input) => {
        SPLIT_SCRIPT(input);
        return { status: "done", reason: "ok", finalText: "我是由 OpenAI 开发的模型", usage: usage() };
      },
    });
    const result = await service.stream({ message: "hi", sessionId: "s-filter" });

    const chunkText = chunkTextOf(result);
    expect(chunkText).not.toContain("OpenAI");
    expect(chunkText).toContain("Loopsoar 平台");
    expect(result.finalText).not.toContain("OpenAI");
    expect(result.finalText).toContain("Loopsoar 平台");
    // done 事件里携带的 finalText 也必须是过滤后的（落库/UI 都走这里）
    const allEventsText = result.chunks.flatMap((batch) => batch.chunks.map((c) => c.content)).join("");
    expect(allEventsText).not.toContain("OpenAI");
  });

  it("filterOutput:false → 不过滤（仅调试用；验证开关有效）", async () => {
    const service = new ChatService({
      llm: new MockLlmClient(),
      platform: fakePlatform(async () => true),
      filterOutput: false,
      runLoop: async (input) => {
        SPLIT_SCRIPT(input);
        return { status: "done", reason: "ok", finalText: "我是由 OpenAI 开发的模型", usage: usage() };
      },
    });
    const result = await service.stream({ message: "hi", sessionId: "s-no-filter" });
    expect(chunkTextOf(result)).toContain("OpenAI");
    expect(result.finalText).toContain("OpenAI");
  });
});

describe("每轮声称核验（verifyRound 接线）", () => {
  it("可疑声称且整段未用工具 → ok=false；文件存在/无声称/已用工具 → 放行", async () => {
    const verdicts: { ok: boolean; note?: string }[] = [];
    const service = new ChatService({
      llm: new MockLlmClient(),
      // 只有路径含 real 的文件"存在"
      platform: fakePlatform(async (p) => p.includes("real")),
      runLoop: async (input) => {
        const verify = input.verifyRound;
        if (!verify) throw new Error("verifyRound 未接线（platform 存在时必须接线）");
        verdicts.push(await verify({ round: 1, finalText: "已保存到 src/missing.ts", usedAnyTool: false }));
        verdicts.push(await verify({ round: 1, finalText: "已保存到 src/real-file.ts", usedAnyTool: false }));
        verdicts.push(await verify({ round: 2, finalText: "已保存到 src/another-missing.ts", usedAnyTool: true }));
        verdicts.push(await verify({ round: 2, finalText: "这一段没有文件声称", usedAnyTool: false }));
        return { status: "done", reason: "ok", finalText: "完成", usage: usage() };
      },
    });

    await service.stream({ message: "hi", sessionId: "s-verify" });

    expect(verdicts).toHaveLength(4);
    expect(verdicts[0]!.ok).toBe(false);
    expect(verdicts[0]!.note).toContain("src/missing.ts");
    expect(verdicts[1]!.ok).toBe(true); // 路径真实存在
    expect(verdicts[2]!.ok).toBe(true); // 整段已用过工具 → 不强制（避免误伤总结轮）
    expect(verdicts[3]!.ok).toBe(true); // 无声称
  });

  it("platform 缺失 → 不接线 verifyRound（保持可选，不因缺平台炸掉）", async () => {
    let hasVerify = true;
    const service = new ChatService({
      llm: new MockLlmClient(),
      runLoop: async (input) => {
        hasVerify = typeof input.verifyRound === "function";
        return { status: "done", reason: "ok", finalText: "完成", usage: usage() };
      },
    });
    await service.stream({ message: "hi", sessionId: "s-no-platform" });
    expect(hasVerify).toBe(false);
  });
});
