/** Anthropic Messages 端点适配：真实 spawn mock 服务 → 验证 SSE 解析/文本流/推理等级请求头。 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAnthropicClient, inferApiFormat } from "../../packages/core/src/llm/anthropic.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const serverScript = path.join(root, "scripts", "mock-anthropic-server.mjs");
let child: ChildProcess | null = null;

beforeAll(async () => {
  child = spawn(process.execPath, [serverScript, "19511"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 400));
});
afterAll(() => {
  child?.kill();
});

describe("Anthropic 客户端", () => {
  it("SSE 文本流 → text 块 + done", async () => {
    const client = createAnthropicClient({
      baseUrl: "http://127.0.0.1:19511/v1",
      apiKey: "sk-ant-mock",
      model: "claude-mock",
      timeoutMs: 8000,
    });
    let text = "";
    let done = false;
    for await (const chunk of client.invoke({ messages: [{ role: "user", content: "你好" }], reasoningEffort: "high" })) {
      if (chunk.kind === "text") text += chunk.text;
      if (chunk.kind === "done") done = true;
    }
    expect(text).toContain("Anthropic");
    expect(done).toBe(true);
  });

  it("auto 协议推断：anthropic/claude → anthropic，其它 → openai", () => {
    expect(inferApiFormat("https://api.anthropic.com/v1")).toBe("anthropic");
    expect(inferApiFormat("https://api.example.com/claude-proxy")).toBe("anthropic");
    expect(inferApiFormat("https://api.deepseek.com/v1")).toBe("openai");
    expect(inferApiFormat("http://127.0.0.1:8080/v1")).toBe("openai");
  });
});
