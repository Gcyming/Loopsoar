/**
 * OpenAI 兼容流式客户端（T2）：SSE 解析 / tool_call 增量合并 / 错误与兜底 / usage 归一。
 */
import { describe, expect, it, afterEach } from "vitest";
import { createOpenAiClient, normalizeUsage } from "../../packages/core/src/llm/openai.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function sseResponse(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const line of lines) controller.enqueue(enc.encode(line));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  return (async () => {
    const out: unknown[] = [];
    for await (const c of iterable) out.push(c);
    return out;
  })();
}

describe("OpenAI 流式客户端", () => {
  it("SSE：text + reasoning + usage + [DONE]", async () => {
    globalThis.fetch = (async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"reasoning_content":"思考中"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"，世界"}}]}\n\n',
        'data: {"usage":{"total_tokens":42}}\n\n',
        "data: [DONE]\n\n",
      ])) as typeof fetch;

    const client = createOpenAiClient({ baseUrl: "http://x/v1", model: "m" });
    const chunks = await collect(client.invoke({ messages: [{ role: "user", content: "hi" }] }));
    const kinds = chunks.map((c) => (c as { kind: string }).kind);
    expect(kinds).toContain("reasoning");
    expect(kinds.filter((k) => k === "text").length).toBe(2);
    expect(kinds[kinds.length - 1]).toBe("done");
    expect(chunks.some((c) => (c as { kind: string; tokens?: number }).kind === "usage")).toBe(true);
  });

  it("tool_call 增量分片合并为单个完整调用", async () => {
    globalThis.fetch = (async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"file_read","arguments":"{\\"path\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\"}"}}]}}]}\n\n',
        "data: [DONE]\n\n",
      ])) as typeof fetch;

    const client = createOpenAiClient({ baseUrl: "http://x/v1", model: "m" });
    const chunks = await collect(client.invoke({ messages: [] }));
    const toolCall = chunks.find((c) => (c as { kind: string }).kind === "tool_call") as
      | { toolCall: { id: string; name: string; args: unknown } }
      | undefined;
    expect(toolCall?.toolCall.name).toBe("file_read");
    expect(toolCall?.toolCall.args).toEqual({ path: "a.txt" });
  });

  it("非流式 JSON 兜底：转成 text + done", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "一次性回复" } }],
          usage: { total_tokens: 7 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    const client = createOpenAiClient({ baseUrl: "http://x/v1", model: "m" });
    const chunks = await collect(client.invoke({ messages: [] }));
    const kinds = chunks.map((c) => (c as { kind: string }).kind);
    expect(kinds).toContain("text");
    expect(kinds).toContain("done");
  });

  it("非重试错误（400）→ error chunk", async () => {
    globalThis.fetch = (async () =>
      new Response("bad request", { status: 400, headers: { "content-type": "text/plain" } })) as typeof fetch;

    const client = createOpenAiClient({ baseUrl: "http://x/v1", model: "m", maxRetries: 0 });
    const chunks = await collect(client.invoke({ messages: [] }));
    const err = chunks.find((c) => (c as { kind: string }).kind === "error") as { message: string } | undefined;
    expect(err?.message).toContain("HTTP 400");
  });

  it("normalizeUsage：OpenAI cached_tokens 与 deepseek prompt_cache_hit_tokens 都映射 cacheRead", () => {
    expect(normalizeUsage({ prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 } })).toEqual({
      prompt: 100,
      completion: 20,
      reasoning: undefined,
      cacheRead: 60,
    });
    expect(normalizeUsage({ prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 8 }).cacheRead).toBe(8);
  });
});
