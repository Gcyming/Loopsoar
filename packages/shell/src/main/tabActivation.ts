/** 标签激活：记录「上一个活动标签」，供下载空白页关闭后精确回到原标签。 */
export interface TabActivationGroup {
  activeId: string | null;
  previousActiveId: string | null;
}

export function activateTab(group: TabActivationGroup, id: string | null): void {
  if (group.activeId === id) return;
  group.previousActiveId = group.activeId;
  group.activeId = id;
}

/**
 * 关闭活动标签后该激活谁：
 *   1. 有 opener（从某个标签页里的链接打开）→ 回到原标签页；
 *   2. 否则取左侧相邻标签（用户 m02188：非母页跳转的网页关掉后统一回左边）；
 *   3. 没有左侧再取右侧；
 *   4. 都没有 → null（最后一个标签，交给起始页）。
 */
export function activeAfterClose(
  group: { tabs: Map<string, unknown>; activeId: string | null },
  tabId: string,
  openerId?: string,
): string | null {
  if (openerId && openerId !== tabId && group.tabs.has(openerId)) return openerId;
  const ids = [...group.tabs.keys()];
  const index = ids.indexOf(tabId);
  return ids[index - 1] ?? ids[index + 1] ?? null;
}
