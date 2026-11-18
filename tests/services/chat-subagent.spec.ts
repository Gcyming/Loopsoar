import { describe, expect, it } from "vitest";
import { ChatService } from "../../packages/services/src/chat.ts";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { SandboxManager } from "../../packages/core/src/sandbox.ts";
import { createNodePlatform } from "../../packages/core/src/platform/node.ts";
import type { LlmRequest } from "../../packages/core/src/llm/index.ts";

function toolDef(name: string, permissions: Record<string, boolean>, calls: string[]) {
  return {
    name,
    description: name,
    permissions,
    schema: { parse: (v: unknown) => v } as never,
    execute: async () => {
      calls.push(name);
      return { ok: true, content: `${name} ok` };
    },
  };
}

function makeService(calls: string[], requests: LlmRequest[], parentHistory: string) {
  const registry = new ToolRegistry();
  registry.register(toolDef("file_read", { read: true }, calls));
  registry.register(toolDef("file_write", { write: true }, calls));
  const sandbox = new SandboxManager();
  sandbox.syncKnownTools(["file_read", "file_write"]);
  let round = 0;
  const llm = {
    async *invoke(req: LlmRequest) {
      requests.push(req);
      round += 1;
      if (round === 1) {
        yield { kind: "tool_call" as const, toolCall: { id: "t1", name: "file_write", args: {} } };
        yield { kind: "done" as const };
        return;
      }
      yield { kind: "text" as const, text: "完成" };
      yield { kind: "done" as const };
    },
  };
  return new ChatService({
    llm: llm as never,
    platform: createNodePlatform(),
    registry,
    sandbox,
    agent: { name: "test", role: "test" },
    getHistory: () => [{ role: "assistant", content: parentHistory }],
  });
}

describe("ChatService.runScoped 子代理边界（P1-5）", () => {
  it("allowlist 外的写工具被拒，执行器不会被调用", async () => {
    const calls: string[] = [];
    const requests: LlmRequest[] = [];
    const service = makeService(calls, requests, "父会话机密");
    const result = await service.runScoped({ message: "研究任务" }, ["file_read"]);
    expect(result.status).toBe("done");
    expect(calls).toEqual([]);
    expect(JSON.stringify(requests[0].messages)).not.toContain("父会话机密");
  });

  it("恢复历史注入子会话，父会话历史仍不泄漏", async () => {
    const calls: string[] = [];
    const requests: LlmRequest[] = [];
    const service = makeService(calls, requests, "父会话机密");
    const result = await service.runScoped(
      { message: "继续查" },
      ["file_read"],
      undefined,
      [{ role: "assistant", content: "子会话旧答复" }],
    );
    expect(result.status).toBe("done");
    const seen = JSON.stringify(requests[0].messages);
    expect(seen).toContain("子会话旧答复");
    expect(seen).not.toContain("父会话机密");
  });

  it("allowlist 内的读工具可以执行", async () => {
    const calls: string[] = [];
    const requests: LlmRequest[] = [];
    const service = makeService(calls, requests, "父会话机密");
    // 改第一轮脚本：允许 file_read；直接复用 private 脚本不方便，改用单独服务
    const registry = new ToolRegistry();
    registry.register(toolDef("file_read", { read: true }, calls));
    const sandbox = new SandboxManager();
    sandbox.syncKnownTools(["file_read"]);
    let round = 0;
    const llm = {
      async *invoke(req: LlmRequest) {
        requests.push(req);
        round += 1;
        if (round === 1) {
          yield { kind: "tool_call" as const, toolCall: { id: "t1", name: "file_read", args: {} } };
          yield { kind: "done" as const };
          return;
        }
        yield { kind: "text" as const, text: "完成" };
        yield { kind: "done" as const };
      },
    };
    const readService = new ChatService({
      llm: llm as never,
      platform: createNodePlatform(),
      registry,
      sandbox,
      agent: { name: "test", role: "test" },
    });
    const result = await readService.runScoped({ message: "读任务" }, ["file_read"]);
    expect(result.status).toBe("done");
    expect(calls).toEqual(["file_read"]);
  });
});
