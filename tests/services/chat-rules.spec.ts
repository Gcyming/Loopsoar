/**
 * 规则是否真的进入 Agent 循环：getSystemRules 返回的文本进入 system，且按会话（工作区）区分。
 */
import { describe, expect, it } from "vitest";
import { ChatService } from "../../packages/services/src/chat.ts";
import type { LlmChunk, LlmClient, LlmRequest } from "../../packages/core/src/llm/index.ts";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { SandboxManager } from "../../packages/core/src/sandbox.ts";
import { createNodePlatform } from "../../packages/core/src/platform/node.ts";

class RecordingLlm implements LlmClient {
  requests: LlmRequest[] = [];
  async *invoke(req: LlmRequest): AsyncIterable<LlmChunk> {
    this.requests.push(req);
    yield { kind: "text", text: "好的" };
    yield { kind: "done" };
  }
}

function makeService(getSystemRules: (sessionId?: string) => string) {
  const registry = new ToolRegistry();
  const sandbox = new SandboxManager();
  const llm = new RecordingLlm();
  const service = new ChatService({
    llm,
    platform: createNodePlatform(),
    registry,
    sandbox,
    agent: { name: "T", role: "测试" },
    getSystemRules,
  });
  return { service, llm };
}

async function systemOf(service: ChatService, llm: RecordingLlm, sessionId: string): Promise<string> {
  await service.stream({ message: "开始", sessionId });
  const system = llm.requests.at(-1)?.messages.find((m) => m.role === "system");
  return system?.content ?? "";
}

describe("规则进入 Agent 循环", () => {
  it("getSystemRules 的文本进入 system，并带上 sessionId", async () => {
    const seen: (string | undefined)[] = [];
    const llm = new RecordingLlm();
    const service = new ChatService({
      llm,
      platform: createNodePlatform(),
      registry: new ToolRegistry(),
      sandbox: new SandboxManager(),
      agent: { name: "T", role: "测试" },
      getSystemRules: (sessionId) => {
        seen.push(sessionId);
        return "# 项目规则\n- 只改 src/ 下的文件";
      },
    });
    await service.stream({ message: "开始", sessionId: "sess-a" });
    const system = llm.requests[0].messages.find((m) => m.role === "system");
    expect(system?.content).toContain("只改 src/ 下的文件");
    expect(seen).toEqual(["sess-a"]);
  });

  it("停用/无规则时不注入（返回空串）", async () => {
    const { service, llm } = makeService(() => "");
    await service.stream({ message: "开始", sessionId: "sess-a" });
    const system = llm.requests[0].messages.find((m) => m.role === "system");
    expect(system?.content ?? "").not.toContain("项目规则");
  });

  it("按会话工作区取不同规则", async () => {
    const { service, llm } = makeService((sessionId) =>
      sessionId === "sess-a" ? "A 规则：中文回答" : "B 规则：只改 apps/b",
    );
    const a = await systemOf(service, llm, "sess-a");
    expect(a).toContain("A 规则");
    expect(a).not.toContain("B 规则");
    const b = await systemOf(service, llm, "sess-b");
    expect(b).toContain("B 规则");
    expect(b).not.toContain("A 规则");
  });
});
