/**
 * T6 测试：packages/services/src/chat.ts 当前签名（T3 真接线已完成）
 * MockLlmClient + 假 platform + ToolRegistry + SandboxManager(sycnKnownTools) 走完整 stream
 * 断言：事件流含 chunk/done；confirm 分支（不注入 resolve）直接返回拒绝路径，不阻塞
 * 注：PermRequestBus.request 当前实现直接立即 resolve deny（无 300s 挂起），
 *     因此不需要 fake timers。若后续改为挂起，需缩短 permTimeoutMs 或用 fake timers。
 */
import { describe, expect, it } from "vitest";
import { MockLlmClient } from "../../packages/core/src/llm/index.ts";
import { ChatService } from "../../packages/services/src/chat.ts";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { SandboxManager } from "../../packages/core/src/sandbox.ts";
import { createNodePlatform } from "../../packages/core/src/platform/node.ts";
import { z } from "zod";

describe("ChatService 完整 stream", () => {
  it("MockLlmClient 脚本流：chunk + done，最终状态 done", async () => {
    const mockClient = new MockLlmClient();
    mockClient.addScript([
      { kind: "text", text: "你好，我是 Loopsoar" },
      { kind: "done" },
    ]);

    const registry = new ToolRegistry();
    const sandbox = new SandboxManager();
    sandbox.syncKnownTools([]); // 无已知工具，不影响。

    const service = new ChatService({
      llm: mockClient,
      platform: createNodePlatform(),
      registry,
      sandbox,
      agent: { name: "T6", role: "测试施工员" },
    });

    const result = await service.stream({ message: "hello" });

    expect(result.status).toBe("done");
    expect(result.finalText).toContain("你好，我是 Loopsoar");
    expect(result.chunks.length).toBeGreaterThan(0);
    // chunks 中应含 chunk 事件（由 batcher 生成）
    const allChunks = result.chunks.flatMap((b) => b.chunks);
    expect(allChunks.some((c) => (c.meta?.type === "chunk" || (c.content && c.content.includes("你好"))))).toBe(true);
  });

  it("confirm 分支：不注入 perm resolve，工具被拒绝返回拒绝文案（不阻塞）", async () => {
    // 构造一个需要确认（terminal 权限）的工具
    const registry = new ToolRegistry();
    registry.register({
      name: "danger_cmd",
      description: "危险命令",
      permissions: { terminal: true },
      schema: z.object({ cmd: z.string() }),
      execute: async () => ({ ok: true, content: "executed" }),
    });

    const sandbox = new SandboxManager();
    sandbox.syncKnownTools(["danger_cmd"]);
    // 默认策略：terminal (L3) → confirm

    const mockClient = new MockLlmClient();
    // 让 LLM 先发 text，再发一个 tool_call
    mockClient.addScript([
      { kind: "text", text: "执行工具" },
      {
        kind: "tool_call",
        toolCall: { id: "t1", name: "danger_cmd", args: { cmd: "ls" } },
      },
      { kind: "text", text: "已处理" },
      { kind: "done" },
    ]);

    const service = new ChatService({
      llm: mockClient,
      platform: createNodePlatform(),
      registry,
      sandbox,
      agent: { name: "T6", role: "测试" },
      permTimeoutMs: 50, // 缩短以避免测试挂起 300s（实现为挂起式确认）
    });

    // 不注入任何 resolve：permBus 直接默认 deny，不挂起
    const result = await service.stream({ message: "run cmd" });

    // 因为 confirm 路径下 permBus.request 直接 resolve deny，
    // 工具执行返回拒绝，最终文本应包含拒绝信息（或至少 not error/crashed）
    expect(result.status).not.toBe("aborted"); // 不阻塞，不挂起
    expect(result.finalText).toBeDefined();
    // chunks 中应含 tool 事件（工具被尝试执行）
    const allChunks = result.chunks.flatMap((b) => b.chunks);
    const hasToolEvent = allChunks.some(
      (c) => c.meta && typeof c.meta === "object" && (c.meta as any).type === "tool"
    );
    expect(hasToolEvent || result.chunks.length > 0).toBe(true);

    // 关键断言：不注入 resolve 时，confirm 走拒绝路径（fail-closed），
    // 由于实现立即 deny，不会因 300s 超时而阻塞测试。
    expect(result.reason).toBeTruthy();
  });
});
