/**
 * AskBus：ask_user 挂起/回填/超时/清理。
 * 为什么单独测：这是「等真人回答」的挂起点，超时与取消必须 fail-closed（绝不伪造回答）。
 */
import { describe, expect, it, vi } from "vitest";
import { AskBus } from "../../packages/shell/src/main/askBus.ts";

describe("AskBus", () => {
  it("request 推送 ask:user 事件；resolve 回填回答", async () => {
    const pushed: { event: string; payload: unknown }[] = [];
    const bus = new AskBus({ push: (event, payload) => pushed.push({ event, payload }) });
    const pending = bus.request({ question: "选哪个方案？", options: ["A", "B"] });
    expect(bus.size).toBe(1);
    expect(pushed).toHaveLength(1);
    expect(pushed[0].event).toBe("ask:user");
    const payload = pushed[0].payload as { requestId: string; question: string; options: string[] };
    expect(payload.question).toBe("选哪个方案？");
    expect(payload.options).toEqual(["A", "B"]);

    const received = bus.resolve(payload.requestId, { answer: "B" });
    expect(received).toBe(true);
    await expect(pending).resolves.toEqual({ cancelled: false, answer: "B" });
    expect(bus.size).toBe(0);
    // 重复回填不生效
    expect(bus.resolve(payload.requestId, { answer: "A" })).toBe(false);
  });

  it("超时按取消结算，不伪造回答", async () => {
    const bus = new AskBus({ push: () => {} });
    const pending = bus.request({ question: "还在吗？", timeoutMs: 60 });
    const answer = await pending;
    expect(answer.cancelled).toBe(true);
    expect(answer.answer).toContain("未在");
    expect(bus.size).toBe(0);
  });

  it("空回答 / 显式取消都按取消处理", async () => {
    const pushed: unknown[] = [];
    const bus = new AskBus({ push: (_e, payload) => pushed.push(payload) });
    const first = bus.request({ question: "q1" });
    const firstId = (pushed[0] as { requestId: string }).requestId;
    bus.resolve(firstId, { answer: "   " });
    await expect(first).resolves.toMatchObject({ cancelled: true });

    const second = bus.request({ question: "q2" });
    const secondId = (pushed[1] as { requestId: string }).requestId;
    bus.resolve(secondId, { cancelled: true });
    await expect(second).resolves.toMatchObject({ cancelled: true });
  });

  it("clearAll 结算全部挂起请求；push 抛错时按取消结算", async () => {
    const bus = new AskBus({ push: () => {} });
    const a = bus.request({ question: "a" });
    const b = bus.request({ question: "b" });
    expect(bus.size).toBe(2);
    bus.clearAll();
    await expect(a).resolves.toMatchObject({ cancelled: true });
    await expect(b).resolves.toMatchObject({ cancelled: true });

    const broken = new AskBus({
      push: () => {
        throw new Error("窗口已销毁");
      },
    });
    await expect(broken.request({ question: "c" })).resolves.toMatchObject({ cancelled: true });
  });

  it("空问题直接取消；超时下限被钳制到合理值", async () => {
    const bus = new AskBus({ push: () => {} });
    await expect(bus.request({ question: "   " })).resolves.toMatchObject({ cancelled: true });
    const pending = bus.request({ question: "x", timeoutMs: 1 });
    const started = Date.now();
    await pending;
    expect(Date.now() - started).toBeGreaterThanOrEqual(40); // 下限 50ms（计时抖动容差）
    vi.useRealTimers();
  });
});
