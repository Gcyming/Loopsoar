/**
 * 工具面（模型可见面）解析 + 与执行闸同源（审计 P0-1 / 第二阶段 Slice A）。
 *
 * 为什么单独测：
 *   · 本片之前 allowlist 只拦执行，模型仍看得见全部工具 → 「关闭浏览器控制」只是幻觉；
 *   · resolveToolSurface 是 index.ts 装配「默认 Agent 白名单 ∩ 浏览器开关 ∩ plan 只读」的唯一实现，
 *     它错一个分支，开关就等于没接。
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MockLlmClient } from "../../packages/core/src/llm/index.ts";
import { ChatService, resolveToolSurface } from "../../packages/services/src/chat.ts";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { SandboxManager } from "../../packages/core/src/sandbox.ts";
import { createNodePlatform } from "../../packages/core/src/platform/node.ts";
import { BROWSER_AGENT_TOOLS } from "../../packages/contracts/src/schemas.ts";

/** 注册若干假工具，并记录 toolSchemas 收到的过滤参数（模型可见面的唯一入口）。 */
function spyRegistry(names: string[]): {
  registry: ToolRegistry;
  calls: Array<string[] | undefined>;
} {
  const registry = new ToolRegistry();
  for (const name of names) {
    registry.register({
      name,
      description: name,
      permissions: { read: true },
      schema: z.object({}),
      execute: async () => ({ ok: true, content: name }),
    });
  }
  const calls: Array<string[] | undefined> = [];
  const original = registry.toolSchemas.bind(registry);
  registry.toolSchemas = ((toolsOnly?: string[]) => {
    calls.push(toolsOnly);
    return original(toolsOnly);
  }) as typeof registry.toolSchemas;
  return { registry, calls };
}

/** 一段立即结束的脚本（本组用例只关心「工具面怎么传」，不关心回复内容）。 */
function scriptedLlm(): MockLlmClient {
  const client = new MockLlmClient();
  client.addScript([{ kind: "text", text: "ok" }, { kind: "done" }]);
  return client;
}

describe("resolveToolSurface：会话级浏览器开关 × 模式白名单", () => {
  const ALL = ["file_read", "web_fetch", ...BROWSER_AGENT_TOOLS];

  it("浏览器控制关闭 + base=undefined（全部可见）→ browser_* 全剔除，web_fetch 仍在", () => {
    const resolved = resolveToolSurface({
      base: undefined,
      allNames: ALL,
      exclude: [...BROWSER_AGENT_TOOLS],
    });
    expect(resolved).toBeDefined();
    for (const tool of BROWSER_AGENT_TOOLS) expect(resolved).not.toContain(tool);
    // web_fetch 属网络权限域：不随浏览器开关（语义不混用）
    expect(resolved).toContain("web_fetch");
    expect(resolved).toContain("file_read");
  });

  it("浏览器控制开启（exclude 为空）→ base=undefined 保持「全部可见」语义", () => {
    expect(resolveToolSurface({ base: undefined, allNames: ALL, exclude: [] })).toBeUndefined();
  });

  it("plan 只读名单 × 浏览器关闭：只读的 browser_snapshot/screenshot 也被剔除", () => {
    const planBase = ["file_read", "browser_snapshot", "browser_screenshot"];
    expect(
      resolveToolSurface({ base: planBase, allNames: ALL, exclude: [...BROWSER_AGENT_TOOLS] }),
    ).toEqual(["file_read"]);
  });

  it("显式 Agent 白名单 × 浏览器关闭：只减不增", () => {
    const agentBase = ["file_read", "browser_click", "web_fetch"];
    expect(
      resolveToolSurface({ base: agentBase, allNames: ALL, exclude: [...BROWSER_AGENT_TOOLS] }),
    ).toEqual(["file_read", "web_fetch"]);
  });

  it("开启时显式白名单原样返回（拷贝，避免调用方误改 Agent 定义）", () => {
    const agentBase = ["file_read", "browser_click"];
    const resolved = resolveToolSurface({ base: agentBase, allNames: ALL, exclude: [] });
    expect(resolved).toEqual(agentBase);
    expect(resolved).not.toBe(agentBase);
  });
});

describe("ChatService：解析出的白名单同时进入模型可见面", () => {
  it("getToolAllowlist 拿到 sessionId，返回值原样传给 registry.toolSchemas", async () => {
    const { registry, calls } = spyRegistry(["file_read", "browser_navigate"]);
    const seen: Array<{ mode?: string; sessionId?: string }> = [];
    const service = new ChatService({
      llm: scriptedLlm(),
      platform: createNodePlatform(),
      registry,
      sandbox: new SandboxManager(),
      getToolAllowlist: (mode, sessionId) => {
        seen.push({ mode, sessionId });
        return ["file_read"];
      },
    });

    await service.stream({ message: "hi", sessionId: "sess-abc", mode: "build" });

    expect(seen[0]).toMatchObject({ mode: "build", sessionId: "sess-abc" });
    expect(calls[0]).toEqual(["file_read"]);
  });

  it("getToolAllowlist 返回 undefined → 不传过滤（行为与修复前一致：全部可见）", async () => {
    const { registry, calls } = spyRegistry(["file_read", "browser_navigate"]);
    const service = new ChatService({
      llm: scriptedLlm(),
      platform: createNodePlatform(),
      registry,
      sandbox: new SandboxManager(),
      getToolAllowlist: () => undefined,
    });

    await service.stream({ message: "hi", sessionId: "sess-abc" });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeUndefined();
  });

  it("空白名单（[]）→ 模型可见面为空（与执行闸「全禁」语义一致）", async () => {
    const { registry, calls } = spyRegistry(["file_read", "browser_navigate"]);
    const service = new ChatService({
      llm: scriptedLlm(),
      platform: createNodePlatform(),
      registry,
      sandbox: new SandboxManager(),
      getToolAllowlist: () => [],
    });

    await service.stream({ message: "hi", sessionId: "sess-abc" });

    expect(calls[0]).toEqual([]);
  });
});
