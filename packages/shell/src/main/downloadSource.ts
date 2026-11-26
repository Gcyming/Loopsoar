/**
 * 下载来源的空白标签处理（从 BrowserHost 抽出，避免组合根继续变大）。
 *
 * target=_blank 的下载会先创建一个空白标签再触发 will-download；如果这个标签是
 * 当前激活的空白页，关掉它并回到上一个标签，用户就不会在点下载后看到「新建标签页」。
 */
export interface DownloadSourceHost {
  groups: Map<
    string,
    {
      tabs: Map<string, { view: { webContents: { id?: number } }; url: string }>;
      activeId: string | null;
      previousActiveId?: string | null;
    }
  >;
  closeTab(tabId: string, sessionId: string): Promise<boolean>;
  applyLayout(): void;
  emitTabs(sessionId: string): void;
}

export function closeBlankDownloadTab(host: DownloadSourceHost, webContentsId: number): void {
  for (const [sessionId, group] of host.groups) {
    for (const [tabId, entry] of group.tabs) {
      if (Number(entry.view.webContents.id ?? -1) !== webContentsId) continue;
      const url = (entry.url ?? "").trim();
      if (url && url !== "about:blank") return;
      if (group.activeId !== tabId || group.tabs.size <= 1) return;
      const ids = [...group.tabs.keys()];
      const index = ids.indexOf(tabId);
      const prev =
        group.previousActiveId && group.previousActiveId !== tabId && group.tabs.has(group.previousActiveId)
          ? group.previousActiveId
          : ids[index - 1] ?? ids[index + 1] ?? null;
      // 先切回原标签再关：closeTab 的兜底（取第一个标签）就不会把用户带到搜索结果页。
      if (prev) group.activeId = prev;
      void host.closeTab(tabId, sessionId).then(() => {
        if (prev && group.tabs.has(prev)) {
          group.activeId = prev;
          host.applyLayout();
          host.emitTabs(sessionId);
        }
      });
      return;
    }
  }
}
