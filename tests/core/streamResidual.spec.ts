/**
 * 流解析「尾巴不丢」回归（m02515 截断根除）：
 *   · 上游没有 [DONE]、最后一帧没有尾换行；
 *   · CRLF 事件分隔（\r\n\r\n）；
 *   · finish_reason / stop_reason=max_tokens 透传（供自动续写判断）。
 * 旧实现：openai 只处理到最后一个 \n 为止、anthropic 只认 \n\n，
 * 两者都会把最后一帧正文静默丢掉 = 用户看到的「回复断在半句」。
 */
import { afterEach, describe, expect, it } from "vitest";
import { createOpenAiClient } from "../../packages/core/src/llm/openai.ts";
import { createAnthropicClient } from "../../packages/core/src/llm/anthropic.ts";
import type { LlmChunk } from "../../packages/core/src/llm/index.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function sseResponse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function collect(iterable: AsyncIterable<LlmChunk>): Promise<LlmChunk[]> {
  const out: LlmChunk[] = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

function texts(chunks: LlmChunk[]): string {
  return chunks
    .filter((c): c is { kind: "text"; text: string } => c.kind === "text")
    .map((c) => c.text)
    .join("");
}

function lastDone(chunks: LlmChunk[]): { kind: "done"; finishReason?: string } | undefined {
  return chunks.filter((c): c is { kind: "done"; finishReason?: string } => c.kind === "done").pop();
}

describe("OpenAI SSE 尾巴", () => {
  it("没有 [DONE]、最后一帧没有尾换行 → 最后一帧正文不丢", async () => {
    globalThis.fetch = (async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"前半段"}}]}\n\n',
        // 注意：最后一行没有 \n，也没有 [DONE]
        'data: {"choices":[{"delta":{"content":"最后一帧"}}]}',
      ])) as typeof fetch;
    const client = createOpenAiClient({ baseUrl: "http://x/v1", model: "m" });
    const chunks = await collect(client.invoke({ messages: [] }));
    expect(texts(chunks)).toBe("前半段最后一帧");
    expect(lastDone(chunks)).toBeTruthy();
  });

  it("CRLF 分隔（\\r\\n\\r\\n）也能解析", async () => {
    globalThis.fetch = (async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"CRLF"}}]}\r\n\r\n',
        'data: {"choices":[{"delta":{"content":"正文"}}]}\r\n\r\n',
      ])) as typeof fetch;
    const client = createOpenAiClient({ baseUrl: "http://x/v1", model: "m" });
    const chunks = await collect(client.invoke({ messages: [] }));
    expect(texts(chunks)).toBe("CRLF正文");
  });

  it("finish_reason=length 透传到 done", async () => {
    globalThis.fetch = (async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"被截断"},"finish_reason":"length"}]}\n\n',
        "data: [DONE]\n\n",
      ])) as typeof fetch;
    const client = createOpenAiClient({ baseUrl: "http://x/v1", model: "m" });
    const chunks = await collect(client.invoke({ messages: [] }));
    expect(lastDone(chunks)?.finishReason).toBe("length");
  });

  it("HTTP 200 的 SSE 流内错误 → error chunk（不伪装成空回复）", async () => {
    globalThis.fetch = (async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"部分内容"}}]}\n\n',
        'data: {"error":{"message":"upstream overloaded","type":"server_error"}}\n\n',
      ])) as typeof fetch;
    const client = createOpenAiClient({ baseUrl: "http://x/v1", model: "m" });
    const chunks = await collect(client.invoke({ messages: [] }));
    const err = chunks.find((c): c is { kind: "error"; message: string } => c.kind === "error");
    expect(err?.message).toContain("上游流内错误");
    expect(err?.message).toContain("upstream overloaded");
  });
});

describe("Anthropic SSE 尾巴", () => {
  const KEY = "k";

  it("最后一个事件没有尾分隔符 → 正文不丢", async () => {
    globalThis.fetch = (async () =>
      sseResponse([
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"前半段"}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"最后一帧"}}',
      ])) as typeof fetch;
    const client = createAnthropicClient({ baseUrl: "http://x", apiKey: KEY, model: "m" });
    const chunks = await collect(client.invoke({ messages: [] }));
    expect(texts(chunks)).toBe("前半段最后一帧");
    expect(lastDone(chunks)).toBeTruthy();
  });

  it("CRLF 事件分隔也能解析", async () => {
    globalThis.fetch = (async () =>
      sseResponse([
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"CRLF"}}\r\n\r\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"正文"}}\r\n\r\n',
        'data: {"type":"message_stop"}\r\n\r\n',
      ])) as typeof fetch;
    const client = createAnthropicClient({ baseUrl: "http://x", apiKey: KEY, model: "m" });
    const chunks = await collect(client.invoke({ messages: [] }));
    expect(texts(chunks)).toBe("CRLF正文");
  });

  it("stop_reason=max_tokens → done.finishReason=length", async () => {
    globalThis.fetch = (async () =>
      sseResponse([
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"被上限截断"}}\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":3}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ])) as typeof fetch;
    const client = createAnthropicClient({ baseUrl: "http://x", apiKey: KEY, model: "m" });
    const chunks = await collect(client.invoke({ messages: [] }));
    expect(lastDone(chunks)?.finishReason).toBe("length");
  });

  it("stop_reason=end_turn → done.finishReason 原样透传（不触发续写）", async () => {
    globalThis.fetch = (async () =>
      sseResponse([
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ])) as typeof fetch;
    const client = createAnthropicClient({ baseUrl: "http://x", apiKey: KEY, model: "m" });
    const chunks = await collect(client.invoke({ messages: [] }));
    expect(lastDone(chunks)?.finishReason).toBe("end_turn");
  });
});
