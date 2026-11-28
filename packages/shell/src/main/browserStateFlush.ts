import type { BrowserHost } from "./browserHost.js";
import type { BrowserStateStore } from "./browserStateStore.js";
import type { SessionStore } from "./sessionStore.js";

/**
 * 退出前全量落盘：标签防抖队列可能还没触发，必须同步刷一次。
 *
 * 抽成模块的理由：这段是「会话 × 浏览器宿主 × 两份仓库」的收尾编排，
 * 和启动顺序无关；放在组合根里每加一份仓库（最近关闭、将来的下载记录）都要改入口，
 * 也把 index.ts 顶到行数天花板上。
 */
export interface BrowserStateFlushInput {
  sessions: SessionStore;
  browserHost: BrowserHost | null;
  browserStates: BrowserStateStore;
  /** 「最近关闭」仓库：与标签状态一起落盘，退出后仍能看到关闭记录。 */
  closedTabStore: { flush(): void };
  /** 各会话的防抖定时器（清掉，避免退出时又触发一次写）。 */
  tabSaveTimers: Map<string, NodeJS.Timeout>;
  userTabsSession: string;
}

export function flushBrowserStatesOnExit(input: BrowserStateFlushInput): void {
  for (const timer of input.tabSaveTimers.values()) clearTimeout(timer);
  input.tabSaveTimers.clear();
  for (const meta of input.sessions.list()) {
    const state = input.browserHost?.snapshotSession(meta.id);
    if (!state || state.tabs.length === 0) continue;
    // 任务会话把页面关光时保留上一次的任务页快照（与运行时防抖保存同一规则），
    // 否则退出这一次会把「重新打开任务会话能恢复工作区」的存档覆盖成空。
    if (input.sessions.isTask(meta.id) && !state.tabs.some((tab) => tab.agentBound === true)) {
      input.browserStates.delete(meta.id);
      input.sessions.setTask(meta.id, false);
      continue;
    }
    input.browserStates.set(meta.id, state);
  }
  const userState = input.browserHost?.snapshotSession(input.userTabsSession);
  if (userState) input.browserStates.set(input.userTabsSession, userState);
  input.browserStates.flush();
  input.closedTabStore.flush();
}
