/**
 * LLM 客户端：自定义请求头合并到真实请求（Authorization 可覆盖，用于代理/特殊网关）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAiClient } from "../../packages/core/src/llm/openai.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("LLM 自定义请求头", () => {
  it("OpenAI 客户端合并 headers，自定义值可覆盖默认头", async () => {
    let captured: Record<string, string> | undefined;
    globalThis.fetch = (async (_url: unknown, init: unknown) => {
      captured = (init as { headers?: Record<string, string> }).headers;
      throw new Error("stop");
    }) as typeof fetch;
    const client = createOpenAiClient({
      baseUrl: "https://example.com/v1",
      apiKey: "sk-default",
      model: "m",
      maxRetries: 1,
      headers: { "x-api-key": "proxy-key", Authorization: "Bearer custom-token", "User-Agent": "Loopsoar/1.0" },
    });
    // 客户端会把网络错误归一成 error chunk；这里只验证请求头是否送达 fetch。
    for await (const _chunk of client.invoke({ messages: [{ role: "user", content: "hi" }] })) {
      // ignore chunks
    }
    expect(captured?.["x-api-key"]).toBe("proxy-key");
    expect(captured?.Authorization).toBe("Bearer custom-token");
    expect(captured?.["User-Agent"]).toBe("Loopsoar/1.0");
  });
});
