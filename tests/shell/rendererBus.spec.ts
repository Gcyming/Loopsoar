import { describe, expect, it } from "vitest";
import { createRendererPusher, type RendererWindowLike } from "../../packages/shell/src/main/rendererBus.js";

function windowLike(url: string): RendererWindowLike & { sent: { channel: string; payload: unknown }[] } {
  const sent: { channel: string; payload: unknown }[] = [];
  return {
    sent,
    webContents: {
      getURL: () => url,
      send: (channel, payload) => {
        sent.push({ channel, payload });
      },
    },
  };
}

describe("主进程事件分发", () => {
  it("只发给 React 页面，chat 高频流跳过 popover，chrome 状态发给浮层", () => {
    const main = windowLike("loopsoar://app/index.html");
    const popover = windowLike("loopsoar://app/index.html?popover=more");
    const pointer = windowLike("data:text/html,pointer");
    const push = createRendererPusher(() => [main, popover, pointer]);

    push("chat:delta", { text: "x" });
    push("chrome:popoverClosed", {});
    expect(main.sent).toEqual([
      { channel: "loopsoar:chat:delta", payload: { text: "x" } },
      { channel: "loopsoar:chrome:popoverClosed", payload: {} },
    ]);
    expect(popover.sent).toEqual([{ channel: "loopsoar:chrome:popoverClosed", payload: {} }]);
    expect(pointer.sent).toEqual([]);
  });
});
