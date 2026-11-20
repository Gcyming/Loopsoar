/**
 * 运行控制：暂停门是「边界暂停」，不是撕断正在执行的工具。
 * 这里只测核心原语：pause 后 wait 挂起、resume 放行、abort 立即拒绝。
 */
import { describe, expect, it } from "vitest";
import { createPauseGate } from "../../packages/core/src/tool_loop.ts";

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("PauseGate：暂停 / 恢复 / 中止", () => {
  it("未暂停时 wait 立即 resolve；暂停后挂起，resume 后放行", async () => {
    const gate = createPauseGate();
    let resumed = false;

    await gate.wait();
    expect(gate.isPaused()).toBe(false);

    gate.pause();
    expect(gate.isPaused()).toBe(true);
    const waiting = gate.wait().then(() => {
      resumed = true;
    });

    await tick();
    expect(resumed).toBe(false);

    gate.resume();
    expect(gate.isPaused()).toBe(false);
    await waiting;
    expect(resumed).toBe(true);
  });

  it("暂停期间 abort：wait 立即 reject，不把循环卡死", async () => {
    const gate = createPauseGate();
    const controller = new AbortController();
    gate.pause();

    const waiting = gate.wait(controller.signal);
    controller.abort();

    await expect(waiting).rejects.toThrow("loop-aborted");
  });

  it("重复 resume 不产生重复放行；暂停态可重新进入", async () => {
    const gate = createPauseGate();
    gate.pause();
    let count = 0;
    void gate.wait().then(() => { count += 1; });
    gate.resume();
    gate.resume();
    await tick();
    expect(count).toBe(1);

    gate.pause();
    expect(gate.isPaused()).toBe(true);
    gate.resume();
    expect(gate.isPaused()).toBe(false);
  });
});
