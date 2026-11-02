/**
 * Agent-Loop 运行时（shell/loopRuntime.ts + domains/loop.ts）：builtin 注册、选择/持久化、
 * 安全模式回退（可见事件）与 loop 域通道。
 *
 * 为什么这些断言：LoopRegistry 是「自定义 loop 跑挂必须回退内置且事件可见」的安全网；
 * shell 层再接错（id/事件/持久化），UI 就会显示错误的 loop 或静默回退，用户无法察觉。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { MockLlmClient } from "../../packages/core/src/llm/index.ts";
import type { ToolLoopOutcome } from "../../packages/core/src/tool_loop.ts";
import { SteerBus } from "../../packages/core/src/steerBus.ts";
import {
  CORE_LOOP_ID,
  createLoopRuntime,
  type LoopRunInput,
} from "../../packages/shell/src/main/loopRuntime.ts";
import {
  __resetHandlerRegistryForTests,
  getHandlerRegistry,
  type TrustedIpcDeps,
} from "../../packages/shell/src/main/trustedIpc.ts";
import { registerLoopDomain } from "../../packages/shell/src/main/domains/loop.ts";

const TRUSTED_EVENT = { senderFrame: { url: "loopsoar://app/index.html" } };

type Handler = (event: unknown, payload: unknown) => Promise<unknown> | unknown;

function fakeDeps(): TrustedIpcDeps {
  return { ipc: { handle: () => undefined }, audit: () => undefined };
}

function doneOutcome(finalText: string, reason = "custom"): ToolLoopOutcome {
  return { status: "done", reason, finalText, usage: { rounds: 1, toolCalls: 0, totalTokens: 0, wallClockMs: 0 } };
}

/** 一次 loop 运行的最小输入：脚本 LLM（内置 runToolLoop 会消费它）+ 空工具面。 */
function makeRunInput(sessionId = "s1", text = "内置循环输出"): LoopRunInput {
  const llm = new MockLlmClient();
  llm.addScript([{ kind: "text", text }, { kind: "done" }]);
  return {
    sessionId,
    llm,
    tools: () => [],
    executeTool: { invoke: async () => ({ ok: true, content: "" }) },
    limits: { maxRounds: 5, maxToolCalls: 5 },
    budget: { rounds: 0, toolCalls: 0, totalTokens: 0, wallClockMs: 0 },
    sink: () => undefined,
    steers: new SteerBus(),
  };
}

function makeRuntime(options: {
  getActiveId?: () => string | undefined;
  onActiveChanged?: (id: string) => void;
  silentTimeoutMs?: number;
} = {}) {
  const pushes: { event: string; payload: unknown }[] = [];
  const runtime = createLoopRuntime({
    push: (event, payload) => {
      pushes.push({ event, payload });
    },
    getActiveId: options.getActiveId,
    onActiveChanged: options.onActiveChanged,
    silentTimeoutMs: options.silentTimeoutMs,
  });
  return { runtime, pushes };
}

describe("LoopRuntime：builtin / 选择 / 持久化", () => {
  it("内置 core-loop 已注册且为 active（list 结构完整）", () => {
    const { runtime } = makeRuntime();
    const payload = runtime.list();
    expect(payload.activeId).toBe(CORE_LOOP_ID);
    expect(payload.loops).toHaveLength(1);
    expect(payload.loops[0]).toMatchObject({
      id: CORE_LOOP_ID,
      builtin: true,
      active: true,
    });
    expect(payload.fallbacks).toEqual([]);
  });

  it("启动时恢复偏好里的 loopId；未知 id 安全回落到 builtin（不抛）", () => {
    const { runtime } = makeRuntime({ getActiveId: () => "ghost-loop" });
    expect(runtime.list().activeId).toBe(CORE_LOOP_ID);
  });

  it("setActive：切换 + 持久化回调 + push loop:changed；未知 id 抛错", () => {
    const changed: string[] = [];
    const { runtime, pushes } = makeRuntime({ onActiveChanged: (id) => changed.push(id) });
    runtime.registry.register({ id: "my-loop", name: "我的 Loop", runner: async () => doneOutcome("x") });

    const payload = runtime.setActive("my-loop");

    expect(payload.activeId).toBe("my-loop");
    expect(payload.loops.find((loop) => loop.id === "my-loop")?.active).toBe(true);
    expect(payload.loops.find((loop) => loop.id === CORE_LOOP_ID)?.active).toBe(false);
    expect(changed).toEqual(["my-loop"]);
    const changedEvent = pushes.find((item) => item.event === "loop:changed");
    expect(changedEvent).toBeTruthy();
    expect((changedEvent!.payload as { activeId: string }).activeId).toBe("my-loop");
    expect(() => runtime.setActive("no-such-loop")).toThrow(/不存在/);
  });

  it("持久化回调抛错不阻断本次切换（切换仍生效）", () => {
    const { runtime } = makeRuntime({
      onActiveChanged: () => {
        throw new Error("磁盘只读");
      },
    });
    runtime.registry.register({ id: "my-loop", name: "我的 Loop", runner: async () => doneOutcome("x") });
    expect(() => runtime.setActive("my-loop")).not.toThrow();
    expect(runtime.list().activeId).toBe("my-loop");
  });
});

describe("LoopRuntime：运行与安全模式回退", () => {
  it("run：指定 loopId 执行自定义 loop；缺省执行当前 active（builtin）", async () => {
    const { runtime } = makeRuntime();
    runtime.registry.register({ id: "my-loop", name: "我的 Loop", runner: async () => doneOutcome("自定义输出") });

    const custom = await runtime.run({ ...makeRunInput(), loopId: "my-loop" });
    expect(custom.finalText).toBe("自定义输出");

    const builtin = await runtime.run(makeRunInput("s2", "内置循环输出"));
    expect(builtin.status).toBe("done");
    expect(builtin.finalText).toContain("内置循环输出");
  });

  it("自定义 loop 抛错 → 回退 builtin（同一 ctx 重跑）+ push loop:fallback + 记录 fallbacks", async () => {
    const { runtime, pushes } = makeRuntime();
    runtime.registry.register({
      id: "crasher",
      name: "崩溃 loop",
      runner: async () => {
        throw new Error("boom: 自定义 loop 崩了");
      },
    });

    const outcome = await runtime.run({ ...makeRunInput("s-fallback", "回退后仍需完成"), loopId: "crasher" });

    expect(outcome.status).toBe("done");
    // ctx 未丢：builtin 用的是同一份输入（MockLlm 脚本正常消费）
    expect(outcome.finalText).toContain("回退后仍需完成");
    const fallbackEvent = pushes.find((item) => item.event === "loop:fallback");
    expect(fallbackEvent).toBeTruthy();
    expect(String((fallbackEvent!.payload as { reason?: string }).reason)).toContain("boom");
    expect(runtime.list().fallbacks).toHaveLength(1);
  });

  it("自定义 loop 静默超时 → 回退 builtin 且事件可见", async () => {
    const { runtime, pushes } = makeRuntime({ silentTimeoutMs: 20 });
    runtime.registry.register({
      id: "sleeper",
      name: "静默 loop",
      runner: () => new Promise<ToolLoopOutcome>(() => undefined),
    });

    const outcome = await runtime.run({ ...makeRunInput(), loopId: "sleeper" });

    expect(outcome.status).toBe("done");
    expect(pushes.some((item) => item.event === "loop:fallback")).toBe(true);
    expect(runtime.list().fallbacks[0]!.reason).toContain("静默超时");
  });
});

describe("loop 域通道（受信 IPC）", () => {
  beforeEach(() => {
    __resetHandlerRegistryForTests();
  });

  function handlerOf(channel: string): Handler {
    const entry = getHandlerRegistry().get(channel);
    if (!entry) throw new Error(`通道未注册：${channel}`);
    return entry.handler as unknown as Handler;
  }

  it("loop:list 返回 loops/activeId/fallbacks；loop:setActive 成功返回 ok+列表", async () => {
    const { runtime } = makeRuntime();
    runtime.registry.register({ id: "my-loop", name: "我的 Loop", runner: async () => doneOutcome("x") });
    registerLoopDomain(fakeDeps(), runtime);

    const listed = (await handlerOf("loop:list")(TRUSTED_EVENT, undefined)) as {
      loops: { id: string; builtin: boolean; active: boolean }[];
      activeId: string;
      fallbacks: unknown[];
    };
    expect(listed.activeId).toBe(CORE_LOOP_ID);
    expect(listed.loops.map((loop) => loop.id).sort()).toEqual([CORE_LOOP_ID, "my-loop"].sort());
    expect(Array.isArray(listed.fallbacks)).toBe(true);

    const setResult = (await handlerOf("loop:setActive")(TRUSTED_EVENT, { id: "my-loop" })) as {
      ok: boolean;
      activeId: string;
    };
    expect(setResult.ok).toBe(true);
    expect(setResult.activeId).toBe("my-loop");
  });

  it("loop:setActive 未知 loop → {ok:false,error}（不抛跨进程异常）", async () => {
    const { runtime } = makeRuntime();
    registerLoopDomain(fakeDeps(), runtime);
    const result = (await handlerOf("loop:setActive")(TRUSTED_EVENT, { id: "no-such-loop" })) as {
      ok: boolean;
      error?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error).toContain("不存在");
  });

  it("参数校验 / 帧来源 fail-closed", async () => {
    const { runtime } = makeRuntime();
    registerLoopDomain(fakeDeps(), runtime);
    await expect(handlerOf("loop:setActive")(TRUSTED_EVENT, {})).rejects.toThrow(/参数校验失败/);
    await expect(handlerOf("loop:list")({ senderFrame: { url: "https://evil.com/" } }, undefined)).rejects.toThrow(
      /帧来源不可信/,
    );
  });
});
