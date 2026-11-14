/**
 * 一轮对话的「开始 / 结束」钩子（Slice H 接管锁的触发器）。
 *
 * 为什么单独钉住：锁挂在网页上、由壳层下发，如果 onTurnSettled 只在成功分支调用，
 * 用户停止、供应商报错、链路超时都会把网页永久锁死——用户会以为浏览器坏了。
 */
import { describe, expect, it } from "vitest";
import { startStream, type ChatDeps } from "../../packages/shell/src/main/domains/chat.ts";

function makeDeps(behavior: "resolve" | "reject") {
  const events: string[] = [];
  const deps = {
    ipc: { handle: () => {} },
    audit: () => {},
    chatService: {
      stream: async () => {
        if (behavior === "reject") throw new Error("上游断开");
        return { finalText: "好" };
      },
    },
    push: () => {},
    onTurnStarted: (sessionId: string) => events.push("start:" + sessionId),
    onTurnSettled: (sessionId: string) => events.push("settle:" + sessionId),
  } as unknown as ChatDeps;
  return { deps, events };
}

describe("chat:stream 的接管锁钩子", () => {
  it("开始即上锁，结束后解锁", async () => {
    const { deps, events } = makeDeps("resolve");
    startStream(deps, { message: "hi", sessionId: "s1" });
    expect(events).toEqual(["start:s1"]);
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toEqual(["start:s1", "settle:s1"]);
  });

  it("流失败也解锁（不能把网页永久锁死）", async () => {
    const { deps, events } = makeDeps("reject");
    startStream(deps, { message: "hi", sessionId: "s2" });
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toEqual(["start:s2", "settle:s2"]);
  });
});
