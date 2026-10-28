/**
 * 工具执行器的 Agent 权限闸（fail-closed）：白名单拦截先于沙箱判定。
 * 为什么单独测：这是「限制某个 Agent 只能做某些事」的唯一执行点，漏了就等于权限模型是装饰。
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { InternalToolExecutor, PermRequestBus } from "../../packages/services/src/chat.ts";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import type { SandboxManager } from "../../packages/core/src/sandbox.ts";

function registryWith(names: string[]): ToolRegistry {
  const reg = new ToolRegistry();
  for (const name of names) {
    reg.register({
      name,
      description: name,
      permissions: { read: true, write: false, terminal: false, network: false },
      schema: z.object({}),
      execute: async () => ({ ok: true, content: `${name} executed` }),
    });
  }
  return reg;
}

/** 假沙箱：allow 全放行（本测试只验证白名单闸，不验证沙箱语义）。 */
function allowAllSandbox(): SandboxManager {
  return {
    checkPermission: () => ({ action: "allow" as const, level: 0, reason: "test allow" }),
    approveToolForSession: () => {},
  } as unknown as SandboxManager;
}

function makeExecutor(opts: { toolAllowlist?: string[]; tools: string[] }) {
  const registry = registryWith(opts.tools);
  const sandbox = allowAllSandbox();
  const permBus = new PermRequestBus(50);
  const executor = new InternalToolExecutor({
    registry,
    sandbox,
    toolAllowlist: opts.toolAllowlist,
    permBus,
    agentId: "test-agent",
    sessionId: "s1",
  });
  return { executor, registry };
}

describe("Agent 工具白名单（执行器第一道闸）", () => {
  it("白名单外工具 → 直接拒绝，且不触达沙箱/注册表执行", async () => {
    const { executor } = makeExecutor({ toolAllowlist: ["file_read"], tools: ["file_read", "file_write"] });
    const result = await executor.invoke({ id: "c1", name: "file_write", args: {} });
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/白名单拦截/);
    expect(result.error).toBe("agent-tool-denied");
  });

  it("空白名单 = 全部拒绝", async () => {
    const { executor } = makeExecutor({ toolAllowlist: [], tools: ["file_read"] });
    const result = await executor.invoke({ id: "c2", name: "file_read", args: {} });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("agent-tool-denied");
  });

  it("白名单内工具 → 通过闸门并正常执行", async () => {
    const { executor } = makeExecutor({ toolAllowlist: ["file_read"], tools: ["file_read"] });
    const result = await executor.invoke({ id: "c3", name: "file_read", args: { path: "/tmp/x" } });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("file_read executed");
  });

  it("未设置白名单（undefined）→ 不拦截（内置默认 Agent）", async () => {
    const { executor } = makeExecutor({ tools: ["file_write"] });
    const result = await executor.invoke({ id: "c4", name: "file_write", args: {} });
    expect(result.ok).toBe(true);
  });
});
