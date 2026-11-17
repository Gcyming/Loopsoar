/**
 * Agent-Loop 注册表（ADR-0010）：builtin 不可删改 / 静态校验拒绝 / 安全模式回退。
 * 这是发布门级用例：自定义 loop 跑挂必须自动回退 builtin 且 ctx 不丢。
 */
import { describe, expect, it } from "vitest";
import { LoopRegistry, type LoopDefinition, type LoopRunContext } from "../../packages/core/src/loop/loopRegistry.ts";
import type { ToolLoopOutcome, ToolExecutor } from "../../packages/core/src/tool_loop.ts";

function outcome(status: ToolLoopOutcome["status"], text: string): ToolLoopOutcome {
  return {
    status,
    reason: `status=${status}`,
    finalText: text,
    usage: { rounds: 1, toolCalls: 0, totalTokens: 0, wallClockMs: 0 },
  };
}

function makeRegistry(opts: { silentTimeoutMs?: number; slow?: boolean; onFallback?: (r: string) => void } = {}) {
  const reg = new LoopRegistry({ silentTimeoutMs: opts.silentTimeoutMs ?? 1000, onFallback: opts.onFallback });
  const builtin: LoopDefinition = {
    id: "core-loop",
    name: "内置初始 Loop",
    runner: async (ctx) => outcome("done", `builtin:${String(ctx.sessionId)}:safeMode=${String(ctx.safeMode)}`),
  };
  reg.registerBuiltin(builtin);
  return reg;
}

describe("Agent-Loop 注册表（安全模式后备）", () => {
  it("builtin 不可原位修改 / 不可删除", () => {
    const reg = makeRegistry();
    expect(() => reg.update("core-loop", { name: "x" })).toThrow(/builtin/);
    expect(() => reg.remove("core-loop")).toThrow(/builtin/);
  });

  it("copyForEdit：复制为新 loop 再改（builtin 不受影响）", () => {
    const reg = makeRegistry();
    const copy = reg.copyForEdit("core-loop", "my-loop", { name: "我的 Loop" });
    expect(copy.id).toBe("my-loop");
    expect(copy.builtin).toBe(false);
    expect(reg.list().map((l) => l.id).sort()).toEqual(["core-loop", "my-loop"]);
  });

  it("注册时静态校验失败 → 拒绝（fail-closed）", () => {
    const reg = makeRegistry();
    expect(() =>
      reg.register({
        id: "bad-loop",
        name: "坏 loop",
        validate: () => ["缺少工具面", "注入段非法"],
        runner: async () => outcome("done", ""),
      }),
    ).toThrow(/静态校验失败/);
  });

  it("运行前静态校验失败 → 自动回退 builtin（safeMode=true，ctx 同一对象）", async () => {
    const reg = makeRegistry();
    let called = false;
    reg.register({
      id: "flaky",
      name: "校验抖动 loop",
      validate: () => {
        // 注册时通过、运行时失败：模拟「用户改坏」
        return called ? ["运行时校验失败"] : [];
      },
      runner: async () => {
        throw new Error("不应执行");
      },
    });
    called = true;
    const ctx: LoopRunContext = { sessionId: "s1" };
    const result = await reg.run("flaky", ctx);
    expect(result.status).toBe("done");
    expect(result.finalText).toContain("safeMode=true");
    expect(reg.fallbackLog().length).toBe(1);
  });

  it("runner 抛错 → 回退 builtin 并用同一 ctx 重跑（数据不丢）", async () => {
    const reasons: string[] = [];
    const reg = makeRegistry({ onFallback: (r) => reasons.push(r) });
    reg.register({
      id: "crasher",
      name: "崩溃 loop",
      runner: async () => {
        throw new Error("boom: 工具轮崩溃");
      },
    });
    const ctx: LoopRunContext = { sessionId: "s2", marker: "keep-me" };
    const result = await reg.run("crasher", ctx);
    // builtin 收到的是同一个 ctx（含 marker），且标记 safeMode
    expect(result.finalText).toContain("s2");
    expect(result.finalText).toContain("safeMode=true");
    expect(reasons[0]).toContain("boom");
    expect(ctx.marker).toBe("keep-me"); // ctx 未被替换/清空
  });

  it("runner 已执行工具后抛错 → 不回退、不重放副作用，返回 error", async () => {
    let builtinCalled = false;
    const reg = new LoopRegistry({ silentTimeoutMs: 1000 });
    reg.registerBuiltin({
      id: "core-loop",
      name: "builtin",
      runner: async () => {
        builtinCalled = true;
        return outcome("done", "builtin");
      },
    });
    reg.register({
      id: "side-effect",
      name: "已产生副作用的 loop",
      runner: async (ctx) => {
        const exec = ctx.executeTool as ToolExecutor;
        await exec.invoke({ id: "call-1", name: "file_write", args: { path: "a.txt", content: "x" } });
        throw new Error("写完之后崩了");
      },
    });
    const result = await reg.run("side-effect", {
      sessionId: "s2b",
      executeTool: { invoke: async () => ({ ok: true, content: "written" }) },
    });
    expect(result.status).toBe("error");
    expect(result.reason).toContain("已执行 1 个工具");
    expect(result.reason).toContain("未自动回退");
    expect(builtinCalled).toBe(false);
    expect(reg.fallbackLog()).toHaveLength(0);
  });

  it("runner 已执行工具后静默挂起 → 先 abort，再停止（不回退）", async () => {
    let builtinCalled = false;
    let sawAbort = false;
    const reg = new LoopRegistry({ silentTimeoutMs: 30 });
    reg.registerBuiltin({
      id: "core-loop",
      name: "builtin",
      runner: async () => {
        builtinCalled = true;
        return outcome("done", "builtin");
      },
    });
    reg.register({
      id: "slow-side-effect",
      name: "执行工具后挂起",
      runner: async (ctx) => {
        const exec = ctx.executeTool as ToolExecutor;
        await exec.invoke({ id: "call-1", name: "file_write", args: {} });
        return await new Promise<ToolLoopOutcome>((_, reject) => {
          (ctx.signal as AbortSignal).addEventListener(
            "abort",
            () => {
              sawAbort = true;
              reject(new Error("runner aborted"));
            },
            { once: true },
          );
        });
      },
    });
    const result = await reg.run("slow-side-effect", {
      sessionId: "s2c",
      executeTool: { invoke: async () => ({ ok: true, content: "written" }) },
    });
    expect(sawAbort).toBe(true);
    expect(result.status).toBe("error");
    expect(result.reason).toContain("已执行 1 个工具");
    expect(result.reason).toContain("静默超时");
    expect(builtinCalled).toBe(false);
    expect(reg.fallbackLog()).toHaveLength(0);
  });

  it("静默超时 → 回退 builtin", async () => {
    const reg = makeRegistry({ silentTimeoutMs: 30 });
    reg.register({
      id: "sleeper",
      name: "静默 loop",
      runner: () => new Promise<ToolLoopOutcome>(() => {}), // 永不返回
    });
    const result = await reg.run("sleeper", { sessionId: "s3" });
    expect(result.finalText).toContain("safeMode=true");
    expect(reg.fallbackLog()[0].reason).toContain("静默超时");
  });

  it("未知 loop id → 回退 builtin 而非崩溃", async () => {
    const reg = makeRegistry();
    const result = await reg.run("ghost-loop", { sessionId: "s4" });
    expect(result.finalText).toContain("safeMode=true");
    expect(reg.fallbackLog()[0].reason).toContain("不存在");
  });

  it("builtin 自身失败 → 如实抛错（无兜底不假成功）", async () => {
    const reg = new LoopRegistry();
    reg.registerBuiltin({
      id: "broken-builtin",
      name: "坏 builtin",
      runner: async () => {
        throw new Error("builtin 崩了");
      },
    });
    await expect(reg.run(undefined, { sessionId: "s5" })).rejects.toThrow(/builtin loop 失败/);
  });

  it("switchTo 不存在的 loop → 拒绝", () => {
    const reg = makeRegistry();
    expect(() => reg.switchTo("nope")).toThrow(/不存在/);
  });
});
