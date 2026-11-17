import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { readOnlyToolAllowlist, registerSubagentTools } from "../../packages/shell/src/main/subagentTools.ts";

function dummy(name: string, permissions: Record<string, boolean>) {
  return {
    name,
    description: name,
    permissions,
    schema: { parse: (v: unknown) => v } as never,
    execute: async () => ({ ok: true, content: "" }),
  };
}

describe("只读子代理（P1-5 第一步）", () => {
  it("只挑只读工具，排除写入/浏览器/联网/子代理自身", () => {
    const registry = new ToolRegistry();
    registry.register(dummy("file_read", { read: true }));
    registry.register(dummy("web_search", { read: true, network: true }));
    registry.register(dummy("browser_snapshot", { read: true, browser: true }));
    registry.register(dummy("file_write", { write: true }));
    registry.register(dummy("ask_user", { read: true }));
    registry.register(dummy("delegate_research", { read: true }));

    expect(readOnlyToolAllowlist(registry)).toEqual(["file_read"]);
  });

  it("委派把结论回灌，runner 收到父会话 id", async () => {
    const registry = new ToolRegistry();
    registry.register(dummy("file_read", { read: true }));
    let received: { goal: string; sessionId: string } | null = null;
    registerSubagentTools(registry, {
      async run(input) {
        received = input;
        return {
          status: "done",
          reason: "",
          finalText: "子代理结论",
          usage: { rounds: 1, toolCalls: 0, totalTokens: 0, wallClockMs: 1 },
          chunks: [],
          claims: [],
        };
      },
    });
    const result = await registry.get("delegate_research")!.execute({
      agentId: "test",
      sessionId: "sess-parent",
      params: { goal: "读一下 fileTools 的入口", context: "只看只读路径" },
      platform: {},
    });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("只读子代理完成");
    expect(result.content).toContain("子代理结论");
    expect(received!.sessionId).toBe("sess-parent");
    expect(received!.goal).toContain("参考上下文");
  });
});
