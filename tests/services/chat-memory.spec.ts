/**
 * 记忆是否真的进了 Agent 循环：getMemoryFor 注入 volatile 段、tool_start 回调。
 */
import { describe, expect, it } from "vitest";
import { ChatService } from "../../packages/services/src/chat.ts";
import type { LlmChunk, LlmClient, LlmRequest } from "../../packages/core/src/llm/index.ts";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { SandboxManager } from "../../packages/core/src/sandbox.ts";
import { createNodePlatform } from "../../packages/core/src/platform/node.ts";
import { z } from "zod";

class RecordingLlm implements LlmClient {
  requests: LlmRequest[] = [];
  constructor(private script: LlmChunk[][]) {}
  async *invoke(req: LlmRequest): AsyncIterable<LlmChunk> {
    this.requests.push(req);
    const chunks = this.script.shift() ?? [{ kind: "done" }];
    for (const chunk of chunks) yield chunk;
  }
}

function makeService(llm: LlmClient, opts: { onToolCall?: (name: string, sessionId: string) => void } = {}) {
  const registry = new ToolRegistry();
  registry.register({
    name: "echo_tool",
    description: "回显",
    permissions: { read: true },
    schema: z.object({ text: z.string() }),
    execute: async () => ({ ok: true, content: "echo-ok" }),
  });
  const sandbox = new SandboxManager();
  sandbox.syncKnownTools(["echo_tool"]);
  return new ChatService({
    llm,
    platform: createNodePlatform(),
    registry,
    sandbox,
    agent: { name: "T", role: "测试" },
    getMemoryFor: (_text: string, sessionId?: string) =>
      sessionId === "sess-mem" ? "以下是本工作区的长期记忆：\n- [fact] 项目使用 pnpm" : "",
    ...(opts.onToolCall ? { onToolCall: opts.onToolCall } : {}),
  });
}

describe("记忆进入 Agent 循环", () => {
  it("记忆文本进入 volatile 段（末段 user），不进 system", async () => {
    const llm = new RecordingLlm([[{ kind: "text", text: "好的" }, { kind: "done" }]]);
    const service = makeService(llm);
    await service.stream({ message: "上次说的包管理器是什么", sessionId: "sess-mem" });

    const request = llm.requests[0];
    const system = request.messages.find((m) => m.role === "system");
    const user = [...request.messages].reverse().find((m) => m.role === "user");
    expect(user?.content).toContain("项目使用 pnpm");
    expect(system?.content ?? "").not.toContain("项目使用 pnpm");
  });

  it("另一会话不注入（按 sessionId 隔离）", async () => {
    const llm = new RecordingLlm([[{ kind: "text", text: "好的" }, { kind: "done" }]]);
    const service = makeService(llm);
    await service.stream({ message: "上次说的包管理器是什么", sessionId: "sess-other" });
    const user = [...llm.requests[0].messages].reverse().find((m) => m.role === "user");
    expect(user?.content ?? "").not.toContain("项目使用 pnpm");
  });

  it("工具调用触发 onToolCall（供壳层记 tool/session 使用事件）", async () => {
    const calls: { name: string; sessionId: string }[] = [];
    const llm = new RecordingLlm([
      [{ kind: "tool_call", toolCall: { id: "t1", name: "echo_tool", args: { text: "hi" } } }],
      [{ kind: "text", text: "完成" }, { kind: "done" }],
    ]);
    const service = makeService(llm, { onToolCall: (name, sessionId) => calls.push({ name, sessionId }) });
    await service.stream({ message: "调用工具", sessionId: "sess-mem" });
    expect(calls).toEqual([{ name: "echo_tool", sessionId: "sess-mem" }]);
  });
});
