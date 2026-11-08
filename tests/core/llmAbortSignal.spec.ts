/**
 * 中断链路回归（task-3）：LLM 客户端必须把调用方的 req.signal 转发到在途 fetch。
 *
 * 此前 openai.ts / anthropic.ts 各自 new AbortController 只用于超时，完全忽略 req.signal，
 * 于是 ChatService.stop() 的 abort 到不了 HTTP 请求 —— 上游卡住时点「停止」要等
 * 首字节超时（120s）/ 总超时（300s）才生效，UI 一直显示「思考中」。
 */
import { afterEach, describe, expect, it } from "vitest";
import { createOpenAiClient } from "../../packages/core/src/llm/openai.ts";
import { createAnthropicClient } from "../../packages/core/src/llm/anthropic.ts";
import type { LlmChunk, LlmClient } from "../../packages/core/src/llm/index.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** 收到请求即挂起，只有 signal abort 时才 reject（模拟上游迟迟不返回首字节）。 */
function hangingAbortableFetch(calls: { count: number }): typeof fetch {
  return ((_url: string, init: RequestInit) => {
    calls.count += 1;
    const signal = init.signal as AbortSignal | undefined;
    return new Promise((_resolve, reject) => {
      const fail = (): void => reject(new DOMException("The operation was aborted.", "AbortError"));
      if (signal?.aborted) {
        fail();
        return;
      }
      signal?.addEventListener("abort", fail, { once: true });
    });
  }) as unknown as typeof fetch;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function consume(
  client: LlmClient,
  signal: AbortSignal,
): Promise<{ chunks: LlmChunk[]; error: unknown }> {
  const chunks: LlmChunk[] = [];
  try {
    for await (const chunk of client.invoke({ messages: [{ role: "user", content: "hi" }], signal })) {
      chunks.push(chunk);
    }
    return { chunks, error: null };
  } catch (error) {
    return { chunks, error };
  }
}

function expectAbortError(error: unknown): void {
  expect(error).toBeTruthy();
  expect((error as Error)?.name).toBe("AbortError");
}

describe("LLM 客户端中断透传", () => {
  it("openai：外部 signal abort → 在途 fetch 立即中断（抛 AbortError，不 yield error chunk）", async () => {
    const calls = { count: 0 };
    globalThis.fetch = hangingAbortableFetch(calls);
    const client = createOpenAiClient({ baseUrl: "http://x/v1", model: "m", maxRetries: 3 });
    const controller = new AbortController();

    const consuming = consume(client, controller.signal);
    await sleep(30);
    expect(calls.count).toBe(1);

    controller.abort();
    const { chunks, error } = await consuming;

    expectAbortError(error);
    expect(calls.count).toBe(1); // 不重试、不再发第二个请求
    // 用户主动停止不能变成 error chunk（UI 会当成红色失败）
    expect(chunks.some((chunk) => chunk.kind === "error")).toBe(false);
  }, 10_000);

  it("openai：启动前 signal 已 abort → 立即结束且不发请求", async () => {
    const calls = { count: 0 };
    globalThis.fetch = hangingAbortableFetch(calls);
    const client = createOpenAiClient({ baseUrl: "http://x/v1", model: "m" });
    const controller = new AbortController();
    controller.abort();

    const { error } = await consume(client, controller.signal);
    expectAbortError(error);
    expect(calls.count).toBe(1); // fetch 被调用但携带已 abort 的 signal，立即 reject
  }, 10_000);

  it("anthropic：外部 signal abort → 在途 fetch 立即中断（不当成「请求超时」错误块）", async () => {
    const calls = { count: 0 };
    globalThis.fetch = hangingAbortableFetch(calls);
    const client = createAnthropicClient({ baseUrl: "http://x", apiKey: "k", model: "m", maxRetries: 2 });
    const controller = new AbortController();

    const consuming = consume(client, controller.signal);
    await sleep(30);
    expect(calls.count).toBe(1);

    controller.abort();
    const { chunks, error } = await consuming;

    expectAbortError(error);
    expect(calls.count).toBe(1);
    expect(chunks.some((chunk) => chunk.kind === "error")).toBe(false);
  }, 10_000);
});
