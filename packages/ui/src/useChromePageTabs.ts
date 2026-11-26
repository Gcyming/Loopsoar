/**
 * 管理页标签（历史 / 下载 / 收藏夹 / 设置）：把「以标签形式打开管理页」的 UI 状态从 App 抽出。
 *
 * 为什么是标签而不是整页覆盖：用户要求「在新建页中显示」——打开管理页时当前网页必须保留，
 * 关掉管理页标签就回到原来的网页。这里只维护 tabId → 页面类型 的映射与动作，不碰浏览器 IPC。
 */
import * as React from "react";
import { getLanguage, t, type Lang } from "./i18n.js";
import type { ChromePageKind, LoopsoarAPI, TabState } from "./types.js";

export interface ChromePageTabsOptions {
  api: LoopsoarAPI | null;
  tabs: TabState[];
  /** 普通用户标签（Agent 绑定标签已分出去）：管理页标签也在这条列表里显示。 */
  userTabs: TabState[];
  /** 当前语言偏好（切语言时标签标题要跟着变）。 */
  language?: Lang;
  navigate: (url?: string) => void;
  setChromePage: React.Dispatch<React.SetStateAction<ChromePageKind | null>>;
  /** E2E 深链 / 旧壳层兜底：没有标签承载时仍可整页覆盖。 */
  legacyChromePage: ChromePageKind | null;
}

export interface ChromePageTabsState {
  activePageKind: ChromePageKind | null;
  displayUserTabs: TabState[];
  openChromePage: (kind: ChromePageKind) => void;
  closeChromePage: () => void;
  switchChromePage: (kind: ChromePageKind) => void;
  navigateFromChromePage: (url: string) => void;
  openExternalFromChromePage: (url: string) => void;
}

export function useChromePageTabs(options: ChromePageTabsOptions): ChromePageTabsState {
  const { api, tabs, userTabs, language, navigate, setChromePage, legacyChromePage } = options;
  const [pageTabs, setPageTabs] = React.useState<Record<string, ChromePageKind>>({});
  const activeTabId = React.useMemo(() => tabs.find((tab) => tab.active)?.id ?? null, [tabs]);
  /** 当前标签是管理页标签时返回页面类型；否则回退到 E2E 深链的整页状态。 */
  const activePageKind: ChromePageKind | null =
    (activeTabId ? pageTabs[activeTabId] : undefined) ?? legacyChromePage;

  /** 管理页标签：空白标签没有 URL，标签条默认显示「新建标签页」；这里换成对应页面名。 */
  const displayUserTabs = React.useMemo(() => {
    const lang = language ?? getLanguage();
    return userTabs.map((tab) => {
      const kind = pageTabs[tab.id];
      return kind ? { ...tab, title: t(lang, `chromePage.title.${kind}`), pageKind: kind } : tab;
    });
  }, [userTabs, pageTabs, language]);

  /** 打开管理页：同类已存在就直接切过去，否则新建一个标签承载（当前网页保留）。 */
  const openChromePage = React.useCallback(
    (kind: ChromePageKind): void => {
      if (!api) return;
      const existing = Object.keys(pageTabs).find(
        (id) => pageTabs[id] === kind && tabs.some((tab) => tab.id === id),
      );
      if (existing) {
        void api.browser.selectTab({ tabId: existing }).catch(() => undefined);
        return;
      }
      void api.browser
        .newTab({})
        .then((result) => {
          if (result?.ok && result.tabId) {
            const tabId = result.tabId;
            setPageTabs((prev) => ({ ...prev, [tabId]: kind }));
          } else {
            // 旧壳层 / 新建失败：退回整页覆盖，功能不丢
            setChromePage(kind);
          }
        })
        .catch(() => setChromePage(kind));
    },
    [api, pageTabs, tabs, setChromePage],
  );

  /** 关闭管理页标签：关掉这个标签本身（回到上一个网页标签）。 */
  const closeChromePage = React.useCallback((): void => {
    if (activeTabId && pageTabs[activeTabId]) {
      const tabId = activeTabId;
      setPageTabs((prev) => {
        const next = { ...prev };
        delete next[tabId];
        return next;
      });
      void api?.browser.closeTab({ tabId }).catch(() => undefined);
      return;
    }
    setChromePage(null);
  }, [activeTabId, api, pageTabs, setChromePage]);

  /** 管理页内部切页（历史/下载/收藏/设置）：留在同一个标签里。 */
  const switchChromePage = React.useCallback(
    (kind: ChromePageKind): void => {
      if (activeTabId && pageTabs[activeTabId]) {
        setPageTabs((prev) => ({ ...prev, [activeTabId]: kind }));
        return;
      }
      openChromePage(kind);
    },
    [activeTabId, openChromePage, pageTabs],
  );

  /** 管理页里点条目：保留管理页标签，另开新标签打开网页。
   *  旧实现把管理页标签直接导航成网页，关闭后只能回到它的 opener/相邻标签（常是搜索页）；
   *  新开标签的 opener 是管理页本身，关闭新标签就回到历史/收藏列表。 */
  const navigateFromChromePage = React.useCallback(
    (url: string): void => {
      if (!api) {
        setChromePage(null);
        navigate(url);
        return;
      }
      // 管理页是母页：新标签显式带 opener，关闭时回到历史/收藏列表而不是搜索页。
      void api.browser
        .newTab({ url, ...(activeTabId ? { openerTabId: activeTabId } : {}) })
        .catch(() => undefined);
    },
    [activeTabId, api, navigate, setChromePage],
  );

  /** 管理页里的外链：关掉管理页标签，另开新标签（原网页不动）。 */
  const openExternalFromChromePage = React.useCallback(
    (url: string): void => {
      if (activeTabId && pageTabs[activeTabId]) {
        const tabId = activeTabId;
        setPageTabs((prev) => {
          const next = { ...prev };
          delete next[tabId];
          return next;
        });
        void api?.browser
          .closeTab({ tabId })
          .then(() => api?.browser.newTab({ url }))
          .catch(() => undefined);
        return;
      }
      setChromePage(null);
      window.setTimeout(() => {
        void api?.browser.newTab({ url }).catch(() => undefined);
      }, 90);
    },
    [activeTabId, api, pageTabs, setChromePage],
  );

  // 标签被关掉后清理失效映射，避免内存里留下已不存在的 tabId。
  React.useEffect(() => {
    setPageTabs((prev) => {
      const ids = new Set(tabs.map((tab) => tab.id));
      let changed = false;
      const next: Record<string, ChromePageKind> = {};
      for (const [id, kind] of Object.entries(prev)) {
        if (ids.has(id)) next[id] = kind;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [tabs]);

  return {
    activePageKind,
    displayUserTabs,
    openChromePage,
    closeChromePage,
    switchChromePage,
    navigateFromChromePage,
    openExternalFromChromePage,
  };
}
