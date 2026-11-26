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

/**
 * 窗口首帧/渲染器重载后补推「标签快照 + 运行中会话」。
 *
 * 启动恢复和窗口创建是两条异步链：恢复完成时窗口可能还没创建，早推的 browser:tabs 会丢，
 * 于是标签栏出现「有网页没标签」；渲染器崩溃自愈后也能靠这次补推恢复 busy 态。
 * 延迟一点发送，等 React 挂载并完成事件订阅（did-finish-load 早于 effect）。
 */
export function replayBrowserState(
  win: { webContents: { send(channel: string, payload: unknown): void } },
  host: { visibleSessionId(): string; listTabs(sessionId?: string): unknown[] } | null,
  activeChatStreamIds: () => string[],
): void {
  const visible = host?.visibleSessionId();
  win.webContents.send("loopsoar:browser:tabs", { tabs: host?.listTabs(visible) ?? [], visibleSession: visible });
  win.webContents.send("loopsoar:chat:running", { sessionIds: activeChatStreamIds() });
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
