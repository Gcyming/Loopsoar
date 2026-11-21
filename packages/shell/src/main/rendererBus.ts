/**
 * 主进程 → React 渲染层的单点事件分发。
 *
 * 从 index.ts 拆出：组合根只负责注入窗口列表，过滤/跳过浮层等策略集中在这里。
 * 不 import electron：窗口只要求满足最小结构，便于单测与分层守卫。
 */
export interface RendererWindowLike {
  webContents: {
    getURL(): string;
    send(channel: string, payload: unknown): void;
  };
}

export function createRendererPusher(listWindows: () => readonly RendererWindowLike[]) {
  return (event: string, payload: unknown): void => {
    const chatty = /^(chat:|terminal:|ask:|perm:|loop:)/.test(event);
    for (const w of listWindows()) {
      // 只发给加载了 React 渲染层的窗口（pointer/toast 是 data: 页、icon 是静态页）。
      const url = w.webContents.getURL();
      if (!url.includes("/index.html")) continue;
      // 工具栏浮层只要 chrome:* 状态，跳过高频流。
      if (chatty && url.includes("popover=")) continue;
      void w.webContents.send(`loopsoar:${event}`, payload);
    }
  };
}
