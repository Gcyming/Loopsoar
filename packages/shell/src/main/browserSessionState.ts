/**
 * 会话级浏览器标签状态的持久化格式（纯逻辑，无 electron）。
 *
 * 一个会话 = 一个"文件夹"：该会话打开的标签/历史只属于它。
 * 持久化只保存 URL/标题/历史栈，不保存页面内容；加载失败时保留空白标签。
 */
export const MAX_PERSISTED_TABS = 12;
export const MAX_PERSISTED_HISTORY = 50;

export interface PersistedBrowserTab {
  url: string;
  title?: string;
  history?: string[];
  index?: number;
  /**
   * 由 Agent 打开/导航过的标签（折叠进「Agent 工作区」）。
   * 必须持久化：否则重启后折叠标签页全丢（用户实测反馈），只剩普通标签。
   */
  agentBound?: boolean;
  /** 固定标签：Chrome 语义，重启后保持固定并排在最左侧。 */
  pinned?: boolean;
}

export interface PersistedBrowserState {
  tabs: PersistedBrowserTab[];
  activeIndex: number;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** 读取持久化状态时统一净化：只保留 http(s)、限制数量/历史长度、索引钳制。 */
export function sanitizeBrowserState(input: unknown): PersistedBrowserState | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as { tabs?: unknown; activeIndex?: unknown };
  if (!Array.isArray(raw.tabs)) return null;
  const tabs: PersistedBrowserTab[] = [];
  for (const item of raw.tabs.slice(0, MAX_PERSISTED_TABS)) {
    if (!item || typeof item !== "object") continue;
    const tab = item as { url?: unknown; title?: unknown; history?: unknown; index?: unknown; agentBound?: unknown; pinned?: unknown };
    if (typeof tab.url !== "string" || !isHttpUrl(tab.url)) continue;
    const history = Array.isArray(tab.history)
      ? tab.history.filter((url): url is string => typeof url === "string" && isHttpUrl(url)).slice(-MAX_PERSISTED_HISTORY)
      : [];
    const safeHistory = history.length > 0 ? history : [tab.url];
    const index =
      typeof tab.index === "number" && Number.isFinite(tab.index)
        ? Math.max(0, Math.min(Math.floor(tab.index), safeHistory.length - 1))
        : safeHistory.length - 1;
    tabs.push({
      url: tab.url,
      ...(typeof tab.title === "string" && tab.title.trim() ? { title: tab.title.trim().slice(0, 80) } : {}),
      history: safeHistory,
      index,
      ...(tab.agentBound === true ? { agentBound: true } : {}),
      ...(tab.pinned === true ? { pinned: true } : {}),
    });
  }
  if (tabs.length === 0) return null;
  const rawIndex = typeof raw.activeIndex === "number" && Number.isFinite(raw.activeIndex) ? Math.floor(raw.activeIndex) : 0;
  return { tabs, activeIndex: Math.max(0, Math.min(rawIndex, tabs.length - 1)) };
}
