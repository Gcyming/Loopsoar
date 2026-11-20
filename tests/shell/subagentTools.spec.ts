import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { readOnlyToolAllowlist, registerSubagentTools, writeToolAllowlist } from "../../packages/shell/src/main/subagentTools.ts";

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
    registry.register(dummy("delegate_parallel", { read: true }));

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

  it("并行委派按顺序回灌，并限制同时运行数", async () => {
    const registry = new ToolRegistry();
    registry.register(dummy("file_read", { read: true }));
    let active = 0;
    let peak = 0;
    registerSubagentTools(registry, {
      async run(input) {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
        return {
          status: "done",
          reason: "",
          finalText: `结论：${input.goal.split("\n")[0]}`,
          usage: { rounds: 1, toolCalls: 0, totalTokens: 0, wallClockMs: 1 },
          chunks: [],
          claims: [],
        };
      },
    });
    const result = await registry.get("delegate_parallel")!.execute({
      agentId: "test",
      sessionId: "sess-parent",
      params: {
        tasks: [{ goal: "任务甲" }, { goal: "任务乙" }, { goal: "任务丙" }, { goal: "任务丁" }],
      },
      platform: {},
    });
    expect(result.ok).toBe(true);
    expect(peak).toBe(3);
    expect(result.content).toContain("[并行只读子代理 4/4 完成]");
    expect(result.content.indexOf("任务 1")).toBeLessThan(result.content.indexOf("任务 4"));
    expect(result.content).toContain("结论：任务丁");
  });

  it("并行委派单任务失败不吞掉其他结果", async () => {
    const registry = new ToolRegistry();
    registry.register(dummy("file_read", { read: true }));
    registerSubagentTools(registry, {
      async run(input) {
        if (input.goal.startsWith("坏任务")) throw new Error("子模型不可用");
        return {
          status: "done",
          reason: "",
          finalText: "可用结论",
          usage: { rounds: 1, toolCalls: 0, totalTokens: 0, wallClockMs: 1 },
          chunks: [],
          claims: [],
        };
      },
    });
    const result = await registry.get("delegate_parallel")!.execute({
      agentId: "test",
      sessionId: "sess-parent",
      params: { tasks: [{ goal: "坏任务" }, { goal: "好任务" }] },
      platform: {},
    });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("[并行只读子代理 1/2 完成]");
    expect(result.content).toContain("[失败] 子模型不可用");
    expect(result.content).toContain("可用结论");
  });
});

describe("可写子代理 delegate_work", () => {
  it("放开读/写/终端/浏览器/联网，拦住递归委派、检查点回滚与自改配置", () => {
    const registry = new ToolRegistry();
    registry.register(dummy("file_read", { read: true }));
    registry.register(dummy("file_write", { write: true }));
    registry.register(dummy("terminal_run", { terminal: true }));
    registry.register(dummy("browser_click", { browser: true }));
    registry.register(dummy("web_fetch", { read: true, network: true }));
    registry.register(dummy("ask_user", { read: true }));
    registry.register(dummy("delegate_work", { write: true }));
    registry.register(dummy("delegate_child", { read: true }));
    registry.register(dummy("subagent_tasks", { read: true }));
    registry.register(dummy("checkpoint_restore", { write: true }));
    registry.register(dummy("loopsoar", { read: true }));

    expect(writeToolAllowlist(registry)).toEqual([
      "file_read",
      "file_write",
      "terminal_run",
      "browser_click",
      "web_fetch",
    ]);
  });

  it("以 write 模式启动，结果带可写标记并记入任务", async () => {
    const registry = new ToolRegistry();
    registry.register(dummy("file_read", { read: true }));
    let received: { mode?: string; sessionId: string } | null = null;
    registerSubagentTools(registry, {
      async run(input) {
        received = input;
        return {
          status: "done",
          reason: "",
          finalText: "已改好 a.ts 并跑通测试",
          usage: { rounds: 2, toolCalls: 3, totalTokens: 10, wallClockMs: 5 },
          chunks: [],
          claims: [],
        };
      },
    });
    const result = await registry.get("delegate_work")!.execute({
      agentId: "test",
      sessionId: "sess-parent",
      params: { goal: "把 a.ts 的 off-by-one 修掉并跑测试" },
      platform: {},
    });
    expect(result.ok).toBe(true);
    expect(received!.mode).toBe("write");
    expect(received!.sessionId).toBe("sess-parent");
    expect(result.content).toContain("[可写子代理完成]");
    expect(result.content).toContain("已改好 a.ts");
  });
});
