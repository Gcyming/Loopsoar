import { describe, expect, it } from "vitest";
import { ChatService } from "../../packages/services/src/chat.ts";
import type { LlmChunk, LlmClient, LlmRequest } from "../../packages/core/src/llm/index.ts";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { SandboxManager } from "../../packages/core/src/sandbox.ts";
import { createNodePlatform } from "../../packages/core/src/platform/node.ts";

class QuietLlm implements LlmClient {
  async *invoke(_req: LlmRequest): AsyncIterable<LlmChunk> {
    yield { kind: "text", text: "ok" };
    yield { kind: "done" };
  }
}

describe("ChatService 工具结果回调", () => {
  it("成功/失败结果都带 toolName、ok、error、args", async () => {
    const seen: { toolName: string; ok: boolean; error?: string; args?: Record<string, unknown> }[] = [];
    const service = new ChatService({
      llm: new QuietLlm(),
      platform: createNodePlatform(),
      registry: new ToolRegistry(),
      sandbox: new SandboxManager(),
      agent: { name: "T", role: "测试" },
      runLoop: (async (input: { sink: (event: { type: string; data: unknown }) => void }) => {
        input.sink({ type: "tool", data: { toolName: "shell", args: { command: "ls" }, result: { ok: false, error: "boom" } } });
        input.sink({ type: "tool", data: { toolName: "read_file", args: { path: "a.txt" }, result: { ok: true } } });
        return { status: "done", reason: "", finalText: "ok", usage: { rounds: 1, toolCalls: 2, totalTokens: 0, wallClockMs: 0 } };
      }) as never,
      onToolResult: (event) => seen.push(event),
    });
    await service.stream({ message: "hi", sessionId: "s1" });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ toolName: "shell", ok: false, error: "boom", args: { command: "ls" } });
    expect(seen[1]).toMatchObject({ toolName: "read_file", ok: true, args: { path: "a.txt" } });
  });
});
