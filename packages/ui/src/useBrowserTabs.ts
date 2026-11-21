/**
 * 浏览器标签/地址栏状态所有权（从 App 拆出）。
 *
 * 负责：tabs、omnibox 地址、当前 URL，以及导航/新建/切换/关闭/前进后退/刷新/保存这些
 * 浏览器动作。会话创建仍由 App 编排：这里只通过 ref 调 `createFreshSessionAndTab`，
 * 避免把「标签页 = 会话」的产品规则复制进浏览器状态层。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { MutableRefObject } from "react";
import { resolveOmniboxInput } from "loopsoar-contracts/omnibox";
import { dismissAllPopovers } from "./popover.js";
import { getLanguage } from "./i18n.js";
import type { LoopsoarAPI, Preferences, TabState } from "./types.js";
import type { TabMenuAction } from "./BrowserTabs.js";

export type CreateFreshSession = (options?: { newBlankTab?: boolean }) => Promise<void>;

export interface UseBrowserTabsOptions {
  api: LoopsoarAPI | null;
  preferences: Preferences | null;
  setNotice: (notice: string) => void;
  /** 与流事件/恢复逻辑共用的「最后一次由主进程确认的 URL」。 */
  lastSyncedUrlRef: MutableRefObject<string>;
  /** App 在 createFreshSessionAndTab 定义后写入；动作触发时一定已赋值。 */
  createFreshSessionRef: MutableRefObject<CreateFreshSession | null>;
  /** 关掉任务工作区最后一个绑定页时，需要知道当前会话以结束任务。 */
  currentSessionRef: MutableRefObject<string | null>;
}

export function useBrowserTabs({
  api,
  preferences,
  setNotice,
  lastSyncedUrlRef,
  createFreshSessionRef,
  currentSessionRef,
}: UseBrowserTabsOptions) {
  const [tabs, setTabs] = useState<TabState[]>([]);
  const [address, setAddress] = useState("");
  const [currentUrl, setCurrentUrl] = useState("");

  const activeTabId = useMemo(() => tabs.find((tab) => tab.active)?.id ?? null, [tabs]);

  /** 用主进程返回的标签快照同步 tabs/地址/当前 URL（所有动作的统一收口）。 */
  const applyTabSnapshot = useCallback(
    (nextTabs: TabState[]): void => {
      setTabs(nextTabs);
      const active = nextTabs.find((tab) => tab.active);
      const url = active?.url ?? "";
      lastSyncedUrlRef.current = url;
      setAddress(url);
      setCurrentUrl(url);
    },
    [lastSyncedUrlRef],
  );

  const navigate = useCallback(
    (raw?: string): void => {
      if (!api) return;
      const input = raw ?? address;
      const engine = preferences?.searchEngine ?? "bing";
      const resolved = resolveOmniboxInput(input, engine);
      if (resolved.kind === "invalid") {
        setNotice(`导航被拒绝：${resolved.reason}`);
        return;
      }
      setNotice("");
      // 乐观切换：地址栏/加载页立刻指向目标，加载完成后再用真实 URL 覆盖（重定向场景）。
      setCurrentUrl(resolved.url);
      void api.browser.navigate({ url: resolved.url }).then((result) => {
        if (result.ok) {
          const url = result.url ?? resolved.url;
          lastSyncedUrlRef.current = url;
          setCurrentUrl(url);
          setAddress(url);
          void api.browser.listTabs().then((r) => setTabs(r.tabs)).catch(() => {});
        } else {
          setNotice(`导航失败：${result.error ?? "未知"}`);
        }
      });
    },
    [address, api, lastSyncedUrlRef, preferences, setNotice],
  );

  const newTab = useCallback((): void => {
    if (!api) return;
    void createFreshSessionRef.current?.({ newBlankTab: true }).catch((err: unknown) =>
      setNotice("新建标签页失败：" + (err instanceof Error ? err.message : String(err))),
    );
  }, [api, createFreshSessionRef, setNotice]);

  const selectTab = useCallback(
    (tabId: string): void => {
      if (!api) return;
      // 切标签属于切换界面：所有已展开列表/浮层先收起（用户 m02115 全局规则）。
      dismissAllPopovers();
      void api.browser
        .selectTab({ tabId })
        .then(async () => {
          // 以切换后的真实活动标签为准，而不是切换前的闭包快照：
          // 切到空白「搜索主页」时必须把 currentUrl 清空，否则原生网页可见性判断会
          // 继续把上一个网页当成当前页，浮层底图也会冻结旧网页。
          const r = await api.browser.listTabs();
          applyTabSnapshot(r.tabs);
        })
        .catch(() => undefined);
    },
    [api, applyTabSnapshot],
  );

  const closeTab = useCallback(
    (tabId: string): void => {
      if (!api) return;
      const closedBound = tabs.find((tab) => tab.id === tabId)?.agentBound === true;
      // 关掉最后一个网页 = 回到空白搜索页（会话与侧栏保持原样），**绝不退出程序**。
      // 退出只认窗口关闭/菜单退出这类显式手势；「关网页顺手关掉整个应用」是用户明确反馈的痛点。
      void api.browser
        .closeTab({ tabId })
        .then(() => api.browser.listTabs())
        .then((r) => {
          applyTabSnapshot(r.tabs);
          // 关掉任务工作区的最后一个绑定页：离开特殊会话，回到空白会话。
          if (closedBound && !r.tabs.some((tab) => tab.agentBound === true)) {
            const sessionId = currentSessionRef.current;
            void Promise.resolve(sessionId ? api.browser.endTask({ sessionId }) : undefined)
              .catch(() => undefined)
              .then(() => createFreshSessionRef.current?.({ newBlankTab: true }))
              .catch(() => undefined);
          }
        })
        .catch(() => undefined);
    },
    [api, applyTabSnapshot, createFreshSessionRef, currentSessionRef, tabs],
  );

  /** 标签右键菜单动作：统一走主进程，然后刷新一次标签快照。 */
  const tabAction = useCallback(
    (action: TabMenuAction, tabId: string): void => {
      if (!api) return;
      const tab = tabs.find((item) => item.id === tabId);
      if (!tab && action !== "reopen") return;
      const refresh = (): void => {
        void api.browser.listTabs().then((r) => applyTabSnapshot(r.tabs)).catch(() => undefined);
      };
      const run = (promise: Promise<unknown>): void => {
        void promise.then(refresh).catch((err: unknown) => {
          setNotice(`标签操作失败：${err instanceof Error ? err.message : String(err)}`);
        });
      };
      switch (action) {
        case "new-right":
          run(api.browser.newTab({ afterTabId: tabId }));
          return;
        case "reload":
          run(api.browser.reload({ tabId }));
          return;
        case "duplicate":
          run(api.browser.duplicateTab({ tabId }));
          return;
        case "mute":
        case "unmute":
          run(api.browser.setTabMuted({ tabId, muted: action === "mute" }));
          return;
        case "pin":
        case "unpin":
          run(api.browser.setTabPinned({ tabId, pinned: action === "pin" }));
          return;
        case "close":
          closeTab(tabId);
          return;
        case "reopen":
          run(api.browser.reopenClosedTab());
          return;
        case "close-others": {
          const ids = tabs.filter((item) => item.id !== tabId && item.pinned !== true).map((item) => item.id);
          if (ids.length > 0) run(api.browser.closeTabs({ tabIds: ids }));
          return;
        }
        case "close-right": {
          const index = tabs.findIndex((item) => item.id === tabId);
          if (index < 0) return;
          const ids = tabs.slice(index + 1).filter((item) => item.pinned !== true).map((item) => item.id);
          if (ids.length > 0) run(api.browser.closeTabs({ tabIds: ids }));
          return;
        }
        case "copy-url":
          if (tab?.url) {
            void navigator.clipboard?.writeText(tab.url).then(
              () => setNotice("已复制页面地址"),
              () => setNotice("复制失败：剪贴板不可用"),
            );
          }
          return;
        default:
          return;
      }
    },
    [api, applyTabSnapshot, closeTab, setNotice, tabs],
  );

  /** 与标签右键菜单文案一致的快捷键：菜单里展示了就必须真的能用。 */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod || event.altKey) return;
      const key = event.key.toLowerCase();
      const active = tabs.find((tab) => tab.active);
      if (event.shiftKey) {
        if (key === "t") {
          event.preventDefault();
          tabAction("reopen", active?.id ?? "");
        } else if (key === "k" && active) {
          event.preventDefault();
          tabAction("duplicate", active.id);
        }
        return;
      }
      if (key === "t") {
        event.preventDefault();
        newTab();
        return;
      }
      if (!active) return;
      if (key === "r") {
        event.preventDefault();
        tabAction("reload", active.id);
      } else if (key === "m") {
        event.preventDefault();
        tabAction(active.muted ? "unmute" : "mute", active.id);
      } else if (key === "w") {
        event.preventDefault();
        tabAction("close", active.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newTab, tabAction, tabs]);

  /**
   * 标签右键菜单：用主进程的独立浮层窗口（chromePopover）渲染。
   * 不能再用主窗口 DOM——WebContentsView 永远盖在 DOM 上；也不能靠隐藏网页来露菜单，
   * 那会让网页停止渲染并闪烁。独立窗口天然在网页之上，页面继续正常渲染。
   */
  const openTabMenu = useCallback(
    (tabId: string, anchor: { x: number; y: number; width: number; height: number }): void => {
      if (!api) return;
      void api.ui
        .openPopover({ kind: "tabmenu", anchor, tabId, lang: getLanguage() })
        .catch((err: unknown) => {
          setNotice(`打开标签菜单失败：${err instanceof Error ? err.message : String(err)}`);
        });
    },
    [api, setNotice],
  );

  /** 关闭整个 Agent 工作区：关闭全部绑定页（任务会话本身保留，页面关闭不等于会话结束）。 */
  const closeAgentWorkspace = useCallback((): void => {
    if (!api) return;
    const ids = tabs.filter((tab) => tab.agentBound === true).map((tab) => tab.id);
    if (ids.length === 0) return;
    void (async () => {
      const sessionId = currentSessionRef.current;
      if (sessionId) {
        // 任务确实结束：关页 + 清任务快照/标记，避免点回会话时旧页面复活。
        await api.browser.endTask({ sessionId }).catch(() => undefined);
      } else {
        for (const id of ids) {
          await api.browser.closeTab({ tabId: id }).catch(() => undefined);
        }
      }
      const result = await api.browser.listTabs().catch(() => null);
      if (!result) return;
      applyTabSnapshot(result.tabs);
      // 关掉折叠工作区 = 任务结束：离开特殊会话，回到一个新的空白会话。
      if (tabs.some((tab) => tab.agentBound === true)) {
        await createFreshSessionRef.current?.({ newBlankTab: true }).catch(() => undefined);
      }
    })();
  }, [api, applyTabSnapshot, createFreshSessionRef, currentSessionRef, tabs]);

  const goBack = useCallback((): void => {
    if (!api) return;
    void api.browser.back({}).then((r) => {
      if (r.ok && r.url) {
        lastSyncedUrlRef.current = r.url;
        setCurrentUrl(r.url);
        setAddress(r.url);
      }
      void api.browser.listTabs().then((x) => setTabs(x.tabs)).catch(() => {});
    });
  }, [api, lastSyncedUrlRef]);

  const goForward = useCallback((): void => {
    if (!api) return;
    void api.browser.forward({}).then((r) => {
      if (r.ok && r.url) {
        lastSyncedUrlRef.current = r.url;
        setCurrentUrl(r.url);
        setAddress(r.url);
      }
      void api.browser.listTabs().then((x) => setTabs(x.tabs)).catch(() => {});
    });
  }, [api, lastSyncedUrlRef]);

  /** 刷新当前页：走 browser:reload（区别于地址栏导航，不重置历史栈）。 */
  const reloadPage = useCallback((): void => {
    if (!api) return;
    void api.browser
      .reload({})
      .then((result) => {
        if (!result.ok) {
          setNotice(`刷新失败：${result.error ?? "未知错误"}`);
          return;
        }
        if (result.url) {
          lastSyncedUrlRef.current = result.url;
          setAddress(result.url);
          setCurrentUrl(result.url);
        }
        void api.browser.listTabs().then((r) => setTabs(r.tabs)).catch(() => {});
      })
      .catch((err: unknown) => setNotice(`刷新失败：${err instanceof Error ? err.message : String(err)}`));
  }, [api, lastSyncedUrlRef, setNotice]);

  /** 加载失败页的「重试」：有失败 URL 就重新导航（首次加载失败时标签 url 还是空的，reload 会 no-op）。 */
  const retryActivePage = useCallback((): void => {
    const active = tabs.find((tab) => tab.active);
    if (active?.loadFailure?.url) {
      navigate(active.loadFailure.url);
      return;
    }
    reloadPage();
  }, [navigate, reloadPage, tabs]);

  return {
    tabs,
    setTabs,
    address,
    setAddress,
    currentUrl,
    setCurrentUrl,
    activeTabId,
    applyTabSnapshot,
    navigate,
    newTab,
    selectTab,
    closeTab,
    tabAction,
    openTabMenu,
    closeAgentWorkspace,
    goBack,
    goForward,
    reloadPage,
    retryActivePage,
  };
}
