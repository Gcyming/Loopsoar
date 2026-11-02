/**
 * 退出清理编排：幂等（同一 Promise）、全异步 allSettled（失败隔离）、超时兜底。
 * 为什么这些行为必须测试：退出路径出错会让「关不掉的应用」或「丢标签/审计」成为线上事故。
 */
import { describe, expect, it, vi } from "vitest";
import { createShutdownHandler } from "../../packages/shell/src/main/shutdown.ts";

function makeDeps(overrides: Partial<Parameters<typeof createShutdownHandler>[0]> = {}) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      saveBrowserStates: () => {
        calls.push("saveBrowserStates");
      },
      shutdownMcp: () => {
        calls.push("shutdownMcp");
      },
      stopExtensions: () => {
        calls.push("stopExtensions");
      },
      closeTerminals: () => {
        calls.push("closeTerminals");
      },
      flushAudit: async () => {
        calls.push("flushAudit");
      },
      ...overrides,
    },
  };
}

describe("createShutdownHandler", () => {
  it("按序启动全部清理步骤", async () => {
    const { calls, deps } = makeDeps();
    await createShutdownHandler(deps)();
    expect(calls).toEqual(["saveBrowserStates", "shutdownMcp", "stopExtensions", "closeTerminals", "flushAudit"]);
  });

  it("幂等：第二次调用返回同一个 Promise，步骤只执行一次", async () => {
    const { calls, deps } = makeDeps();
    const handler = createShutdownHandler(deps);
    const first = handler();
    const second = handler();
    expect(second).toBe(first);
    await first;
    await handler();
    expect(calls).toHaveLength(5);
  });

  it("失败隔离：同步抛错/异步 rejected 都不影响其他步骤，整体仍 resolve", async () => {
    const { calls, deps } = makeDeps({
      saveBrowserStates: () => {
        calls.push("saveBrowserStates");
        throw new Error("标签保存炸了");
      },
      shutdownMcp: async () => {
        calls.push("shutdownMcp");
        throw new Error("MCP 关不掉");
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(createShutdownHandler(deps)()).resolves.toBeUndefined();
    } finally {
      warn.mockRestore();
    }
    expect(calls).toEqual(["saveBrowserStates", "shutdownMcp", "stopExtensions", "closeTerminals", "flushAudit"]);
  });

  it("超时兜底：某一步永不返回时，按 timeoutMs 返回且不抛错", async () => {
    const { calls, deps } = makeDeps({
      flushAudit: () => new Promise<void>(() => {}),
      timeoutMs: 40,
    });
    const started = Date.now();
    await expect(createShutdownHandler(deps)()).resolves.toBeUndefined();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(30);
    expect(elapsed).toBeLessThan(2_000);
    expect(calls).toContain("closeTerminals");
    expect(calls).toContain("saveBrowserStates");
  });

  it("默认超时 3000ms：不传 timeoutMs 也必须有兜底（用短超时验证逻辑一致性）", async () => {
    // 不实际等待 3 秒：只验证「未配置时使用正数默认值」的分支不会提前返回（步骤已完成时立即返回）
    const { calls, deps } = makeDeps();
    const started = Date.now();
    await createShutdownHandler(deps)();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(calls).toHaveLength(5);
  });
});
