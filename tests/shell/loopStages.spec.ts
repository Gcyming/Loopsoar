/**
 * L2 自定义 loop：阶段开关 → 工具可见性/执行拦截（applyDeclarativeLoop 纯函数）。
 * 这里不启动 LLM；只验证投影结果，避免把「UI 开关」当成装饰。
 */
import { describe, expect, it } from "vitest";
import { applyDeclarativeLoop } from "../../packages/shell/src/main/loopRuntime.ts";

function baseOpts() {
  const tools = [
    { name: "web_search", description: "", parameters: {} },
    { name: "browser_click", description: "", parameters: {} },
    { name: "browser_navigate", description: "", parameters: {} },
    { name: "file_write", description: "", parameters: {} },
  ];
  return {
    llm: {} as never,
    tools: () => tools,
    executeTool: {
      invoke: async (call: { name: string }) => ({ ok: true, content: `ran:${call.name}` }),
    },
    limits: {},
    budget: { rounds: 0, toolCalls: 0, totalTokens: 0, startedAt: Date.now(), promptTokens: 0, completionTokens: 0 },
    sink: () => {},
    steers: {} as never,
  } as never as Parameters<typeof applyDeclarativeLoop>[1];
}

describe("applyDeclarativeLoop：阶段能力开关", () => {
  it("关闭 browse/interact → 两个阶段的工具对模型不可见，且执行器拒绝调用", async () => {
    const applied = applyDeclarativeLoop(
      {
        id: "readonly",
        name: "只读调研",
        stages: [
          { id: "plan", enabled: true },
          { id: "research", enabled: true },
          { id: "browse", enabled: false },
          { id: "interact", enabled: false },
          { id: "workspace", enabled: true },
          { id: "delegate", enabled: false },
        ],
      },
      baseOpts(),
    );

    expect(applied.tools().map((tool) => tool.name)).toEqual(["web_search", "file_write"]);
    expect(applied.blockedTools).toEqual(expect.arrayContaining(["browser_click", "browser_navigate"]));

    const denied = await applied.executeTool.invoke({ id: "1", name: "browser_click", args: {} });
    expect(denied.ok).toBe(false);
    expect(denied.error).toBe("loop-stage-denied");
    expect(denied.content).toContain("阶段已关闭");

    const allowed = await applied.executeTool.invoke({ id: "2", name: "web_search", args: {} });
    expect(allowed.ok).toBe(true);
    expect(allowed.content).toBe("ran:web_search");
  });

  it("显式 allowedTools 与阶段取交集：不在白名单的工具即使阶段开启也不可见", async () => {
    const applied = applyDeclarativeLoop(
      {
        id: "narrow",
        name: "窄白名单",
        stages: [
          { id: "research", enabled: true },
          { id: "workspace", enabled: true },
        ],
        allowedTools: ["web_search"],
      },
      baseOpts(),
    );

    expect(applied.tools().map((tool) => tool.name)).toEqual(["web_search"]);
    const denied = await applied.executeTool.invoke({ id: "1", name: "file_write", args: {} });
    expect(denied.ok).toBe(false);
    expect(denied.error).toBe("loop-tool-denied");
  });

  it("阶段提示注入到消息尾部（模型能读到哪些阶段被关闭）", () => {
    const applied = applyDeclarativeLoop(
      { id: "prompt", name: "带阶段提示", stages: [{ id: "browse", enabled: false }] },
      baseOpts(),
    );
    const last = applied.messages?.[applied.messages.length - 1];
    expect(last?.role).toBe("user");
    expect(String(last?.content)).toContain("Loop 指令：带阶段提示");
    expect(String(last?.content)).toContain("本阶段已由用户关闭");
  });
});
