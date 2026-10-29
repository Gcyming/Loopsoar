/** OpenAI 请求体形状：tools 必须包成 { type:"function", function:{...} }（否则服务端 400）。 */
import { describe, expect, it } from "vitest";
import { createOpenAiClient } from "../../packages/core/src/llm/openai.ts";

describe("OpenAI 请求体", () => {
  it("tools 包成 function 对象，消息与推理等级透传", async () => {
    const realFetch = globalThis.fetch;
    let captured: { url: string; body?: string; headers?: Record<string, string> } = { url: "" };
    try {
      globalThis.fetch = (async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
        captured = { url: String(url), body: init?.body, headers: init?.headers };
        return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
      }) as typeof fetch;
      const client = createOpenAiClient({ baseUrl: "https://api.example.com/v1", apiKey: "sk-test", model: "m1" });
      const chunks: string[] = [];
      for await (const chunk of client.invoke({
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "file_read", description: "读文件", parameters: { type: "object", properties: {} } }],
        reasoningEffort: "high",
      })) {
        chunks.push(chunk.kind);
      }
      expect(captured.url).toBe("https://api.example.com/v1/chat/completions");
      expect(captured.headers?.Authorization).toBe("Bearer sk-test");
      const body = JSON.parse(captured.body ?? "{}") as {
        tools?: { type?: string; function?: { name?: string } }[];
        reasoning_effort?: string;
        messages?: { role: string }[];
      };
      expect(body.tools?.[0]?.type).toBe("function");
      expect(body.tools?.[0]?.function?.name).toBe("file_read");
      expect(body.reasoning_effort).toBe("high");
      expect(body.messages?.[0]?.role).toBe("user");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
