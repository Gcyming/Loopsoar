/**
 * ask_user 工具：等待真人回答；取消/超时返回可读失败，绝不伪造答案。
 */
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { AskBus } from "../../packages/shell/src/main/askBus.ts";
import { registerAskTools, ASK_USER_TOOL_NAME } from "../../packages/shell/src/main/askTools.ts";

function setup(): { registry: ToolRegistry; bus: AskBus; pushed: { requestId: string }[] } {
  const pushed: { requestId: string }[] = [];
  const bus = new AskBus({
    push: (_event, payload) => pushed.push(payload as { requestId: string }),
  });
  const registry = new ToolRegistry();
  registerAskTools(registry, bus);
  return { registry, bus, pushed };
}

function ctx(registry: ToolRegistry, params: unknown) {
  return {
    agentId: "test",
    platform: {},
    params,
    execute: (tool: string, args: unknown) => registry.get(tool)!.execute({ agentId: "test", platform: {}, params: args }),
  } as never;
}

describe("ask_user 工具", () => {
  it("注册且权限声明为只读（弹窗即交互，不需要额外权限确认）", () => {
    const { registry } = setup();
    const tool = registry.get(ASK_USER_TOOL_NAME);
    expect(tool).toBeTruthy();
    expect(tool!.permissions.read).toBe(true);
    expect(tool!.permissions.write).toBeUndefined();
  });

  it("用户回答后返回回答文本", async () => {
    const { registry, bus, pushed } = setup();
    const tool = registry.get(ASK_USER_TOOL_NAME)!;
    const pending = tool.execute({ agentId: "test", platform: {}, params: { question: "用哪个端口？" } });
    // 等事件推送到总线
    await new Promise((r) => setTimeout(r, 10));
    expect(pushed).toHaveLength(1);
    bus.resolve(pushed[0].requestId, { answer: "8080" });
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.content).toContain("8080");
  });

  it("用户取消时返回可读失败并提示不要编造", async () => {
    const { registry, bus, pushed } = setup();
    const tool = registry.get(ASK_USER_TOOL_NAME)!;
    const pending = tool.execute({ agentId: "test", platform: {}, params: { question: "确认？" } });
    await new Promise((r) => setTimeout(r, 10));
    bus.resolve(pushed[0].requestId, { cancelled: true });
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.content).toContain("取消");
    expect(result.content).toContain("不要编造");
  });

  it("缺少 question 时直接报错，不挂起", async () => {
    const { registry, bus } = setup();
    const tool = registry.get(ASK_USER_TOOL_NAME)!;
    const result = await tool.execute({ agentId: "test", platform: {}, params: {} });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("question");
    expect(bus.size).toBe(0);
  });
});
