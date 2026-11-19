/**
 * MVP 主链路六步（单进程、确定性）：
 *   对话 → 模型调用 → 工具执行 → 权限判断（真实挂起确认）→ 结果核验 → 记忆读写。
 *
 * 为什么还要这一条：单点 spec 各自覆盖一段，但「确认回调 → 工具真的执行 → 结果回到下一轮模型请求
 * → 记忆在同一请求里可见」这条组合链没有被任何一条用例完整穿过；这里把它锁成一条回归。
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ChatService } from "../../packages/services/src/chat.ts";
import type { LlmChunk, LlmClient, LlmRequest } from "../../packages/core/src/llm/index.ts";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { SandboxManager } from "../../packages/core/src/sandbox.ts";
import { createNodePlatform } from "../../packages/core/src/platform/node.ts";
import { MemoryStore } from "../../packages/core/src/memory/store.ts";

class RecordingLlm implements LlmClient {
  requests: LlmRequest[] = [];
  constructor(private readonly script: LlmChunk[][]) {}
  async *invoke(req: LlmRequest): AsyncIterable<LlmChunk> {
    this.requests.push(req);
    for (const chunk of this.script.shift() ?? [{ kind: "done" as const }]) yield chunk;
  }
}

describe("MVP 主链路六步", () => {
  it("确认后执行工具，工具结果进入下一轮请求，记忆在同轮可见", async () => {
    const memory = new MemoryStore();
    memory.add({ content: "本项目使用 pnpm 管理依赖", category: "fact" });

    const registry = new ToolRegistry();
    registry.register({
      name: "write_report",
      description: "写报告",
      permissions: { write: true },
      schema: z.object({ name: z.string() }),
      execute: async (ctx) => ({ ok: true, content: `已写入 ${String((ctx.params as { name: string }).name)}` }),
    });
    const sandbox = new SandboxManager();
    sandbox.syncKnownTools(["write_report"]);

    const llm = new RecordingLlm([
      [
        { kind: "tool_call", toolCall: { id: "t1", name: "write_report", args: { name: "report.md" } } },
      ],
      [{ kind: "text", text: "报告已生成：report.md" }, { kind: "done" }],
    ]);

    const permissions: string[] = [];
    let service: ChatService;
    service = new ChatService({
      llm,
      platform: createNodePlatform(),
      registry,
      sandbox,
      agent: { name: "六步", role: "验收" },
      getMemoryFor: () => `长期记忆：${memory.list()[0]?.content ?? ""}`,
      onPermissionRequest: (request) => {
        permissions.push(`${request.toolName}:${request.kind}`);
        // 真实用户动作：确认弹窗点「允许一次」（异步 resolve，模拟 IPC 回填）
        queueMicrotask(() => service.resolvePermission(request.requestId, "allow-once"));
      },
    });

    const result = await service.stream({ message: "帮我写报告", sessionId: "sess-six" });

    // ① 权限判断真实发生且只发生一次
    expect(permissions).toEqual(["write_report:write"]);
    // ② 工具真的执行，结果进入第二轮模型请求（不是只回显给 UI）
    expect(llm.requests).toHaveLength(2);
    const toolMessage = llm.requests[1].messages.find((m) => m.role === "tool");
    expect(toolMessage?.content).toContain("已写入 report.md");
    // ③ 结果核验：最终回答基于工具结果
    expect(result.status).toBe("done");
    expect(result.finalText).toContain("report.md");
    // ④ 记忆读写：同一轮的首个请求里能看到长期记忆，且不污染 system
    const firstUser = [...llm.requests[0].messages].reverse().find((m) => m.role === "user");
    expect(firstUser?.content).toContain("pnpm");
    expect(llm.requests[0].messages.find((m) => m.role === "system")?.content ?? "").not.toContain("pnpm");
  });
});
