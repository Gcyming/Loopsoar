/**
 * 标签映射与只读回落合并（从 browserHost.ts 抽出的纯函数）。
 * 目的：宿主状态机不因「拼装 TabState / 合并诊断列表」这些展示层细节继续膨胀。
 */
import type { TabState } from "./browserHostTypes.js";

interface TabEntryLike {
  url: string;
  title: string;
  index: number;
  history: string[];
  loading: boolean;
  loadFailure?: unknown;
  favicon?: string;
  agentBound?: boolean;
  audible?: boolean;
  muted?: boolean;
  pinned?: boolean;
}

export function toTabStates(group: { tabs: Map<string, TabEntryLike>; activeId?: string | null }): TabState[] {
  return [...group.tabs.entries()].map(([id, entry]) => ({
    id,
    url: entry.url,
    title: entry.title,
    active: id === group.activeId,
    canBack: entry.index > 0,
    canForward: entry.index >= 0 && entry.index < entry.history.length - 1,
    loading: entry.loading,
    loadFailure: entry.loadFailure,
    favicon: entry.favicon,
    agentBound: entry.agentBound,
    audible: entry.audible === true,
    muted: entry.muted === true,
    pinned: entry.pinned === true,
  })) as TabState[];
}

/** 会话没有自己的标签时，把用户全局标签的只读记录并进来（按时间排序、保留尾部 limit 条）。 */
export function mergeRecent<T extends { at: number }>(own: T[], user: T[], limit: number): T[] {
  return [...user, ...own].sort((a, b) => a.at - b.at).slice(-limit);
}
