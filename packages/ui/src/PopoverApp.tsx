/**
 * 浏览器工具栏浮层渲染层（独立子窗口）。
 *
 * 为什么需要独立窗口：主窗口里的 DOM 永远在原生 WebContentsView 之下，任何浮层都会被网页遮挡；
 * 主进程用 `ui:openPopover` 起一个跟随主窗口的透明子 BrowserWindow，加载本文件
 * （`index.html?popover=<kind>&lang=<lang>`），浮层因此天然浮在网页之上。
 *
 * 职责边界：
 *   · 只负责「渲染预览 + 采集用户动作」：数据自己经 preload 现有域拉取
 *     （bookmarks.list / browser.history / browser.downloads），不订阅事件、不碰 Node；
 *   · 动作统一走 `api.ui.popoverAction({action,payload})`；主进程 domain 会**先转发给主窗口、
 *     再关闭浮层**（见 shell/src/main/domains/chromePopover.ts）。因此这里不能先 await closePopover：
 *     主进程 close() 会直接 win.close() 销毁本渲染进程，动作就发不出去了；改为「先发动作消息，
 *     紧接着补一次 closePopover（幂等）兜底旧实现」。
 *     动作名：navigate=主窗口导航；openPage=打开整页管理 ChromePage；savePage=保存当前页；
 *   · 下载条目操作沿用 api.browser.downloadAction（与主窗口下载面板同一套动作）。
 *
 * 窗口尺寸/位置/悬停进出/失焦关闭由主进程 chromePopover.ts 负责；本层只铺满窗口。
 */
import * as React from "react";
import { Icon } from "./Icon.js";
import DownloadIcon from "./DownloadIcon.js";
import RowContextMenu, { type RowMenuItem } from "./RowContextMenu.js";
import { useLoopsoarApi } from "./useLoopsoarApi.js";
import { getLanguage, setLanguage, useT } from "./i18n.js";
import type { BookmarkItem, ChromePopoverKind, DownloadItem, HistoryEntry, TabState, WorkspaceRecord } from "./types.js";

export interface PopoverAppProps {
  kind: ChromePopoverKind;
}

/**
 * 浮层窗口是独立文档：语言由主进程通过 URL `?lang=` 直接传入（不必等 App 的偏好异步加载），
 * 在模块加载阶段同步设置，避免首帧中文闪烁。
 */
const SEARCH_PARAMS = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
const LANG_PARAM = SEARCH_PARAMS.get("lang");
if (LANG_PARAM === "zh-CN" || LANG_PARAM === "en-US") setLanguage(LANG_PARAM);

/** tabmenu：主进程把被右键的标签 id 写进 URL（浮层是独立文档，不能读主窗口 state）。 */
const TAB_MENU_TARGET = SEARCH_PARAMS.get("tabId");

/**
 * 浮层窗口透明背景（CSS 里 html[data-popover] 兜底，这里同步打标避免首帧白底闪烁）。
 *
 * 必须只在浮层窗口（?popover=）打标：主窗口也会 import 本模块（main.tsx 静态引入），
 * 若无条件给 <html> 打上 data-popover，主窗口整页都会命中 `[data-popover]` 选择器，
 * usePopover 的「点击列表外收起」会把**任何点击**都当成点在浮层内部 → 所有菜单都收不起来
 * （用户 2026-11-10 报障「一个都收不起来」的根因）。
 */
if (typeof document !== "undefined" && SEARCH_PARAMS.has("popover")) {
  document.documentElement.dataset.popover = "1";
}

/** 预览条数上限（限条数 + 底部「查看更多」）。 */
const BOOKMARK_PREVIEW = 8;
const HISTORY_PREVIEW = 8;
const DOWNLOAD_PREVIEW = 5;

const POPOVER_KINDS: ChromePopoverKind[] = ["more", "bookmarks", "history", "downloads", "workspaces", "workspace", "tabmenu"];

function isPopoverKind(value: unknown): value is ChromePopoverKind {
  return typeof value === "string" && POPOVER_KINDS.includes(value as ChromePopoverKind);
}

/** 下载状态文案：文件被删除 > 异常原因 > 基础状态。 */
function downloadStatusText(item: DownloadItem, tr: (key: string, vars?: Record<string, string | number>) => string): string {
  if (item.missing) return tr("chromePage.downloads.deleted");
  if (item.reason === "cancelled") return tr("chromePage.downloads.cancelledByUser");
  if (item.reason === "permission") return tr("chromePage.downloads.permission");
  if (item.reason === "app-closed") return tr("chromePage.downloads.appClosed");
  if (item.reason === "stale") return tr("chromePage.downloads.stale");
  if (item.state === "interrupted") return tr("chromePage.downloads.failedReason");
  return tr(downloadStateKey(item.state));
}

/** 下载状态文案 key（interrupted = 中断/失败）。 */
function downloadStateKey(state: DownloadItem["state"]): string {
  if (state === "completed") return "browser.downloadCompleted";
  if (state === "cancelled") return "browser.downloadCancelled";
  if (state === "interrupted") return "browser.popover.downloadInterrupted";
  return "browser.downloadFailed";
}

function formatTime(at: number | undefined, lang: "zh-CN" | "en-US"): string {
  if (!at) return "";
  try {
    return new Date(at).toLocaleTimeString(lang === "en-US" ? "en-US" : "zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

/**
 * 长文本单元格（用户要求）：未悬停整行时单行省略号；悬停且确实溢出时，按阅读顺序
 * 从右向左循环滚动（读起来是左→右）。只做 transform，不改变布局宽度，所以不会
 * 出现横向滚动条；上下滚动仍由列表容器负责。
 */
function MarqueeText({
  text,
  className,
  title,
  style,
}: {
  text: string;
  className?: string;
  title?: string;
  style?: React.CSSProperties;
}): React.ReactElement {
  const ref = React.useRef<HTMLSpanElement | null>(null);
  const [run, setRun] = React.useState<{ active: boolean; distance: number }>({ active: false, distance: 0 });
  React.useEffect(() => {
    const el = ref.current;
    const row = el?.closest<HTMLElement>(".chrome-pop-item");
    if (!el || !row) return;
    const enter = (): void => {
      const distance = Math.max(0, el.scrollWidth - el.clientWidth);
      if (distance > 1) setRun({ active: true, distance });
    };
    const leave = (): void => setRun((prev) => (prev.active ? { active: false, distance: 0 } : prev));
    row.addEventListener("mouseenter", enter);
    row.addEventListener("mouseleave", leave);
    return () => {
      row.removeEventListener("mouseenter", enter);
      row.removeEventListener("mouseleave", leave);
    };
  }, [text]);
  const duration = Math.max(2.6, run.distance / 26);
  return (
    <span
      ref={ref}
      className={`${className ?? ""} chrome-pop-marquee${run.active ? " is-running" : ""}`}
      title={title}
      style={{
        ...(run.active
          ? ({
              "--ls-marquee-distance": `${run.distance}px`,
              "--ls-marquee-duration": `${duration}s`,
            } as React.CSSProperties)
          : undefined),
        ...style,
      }}
    >
      {run.active ? <span className="chrome-pop-marquee-run">{text}</span> : text}
    </span>
  );
}

export default function PopoverApp({ kind: kindProp }: PopoverAppProps): React.ReactElement {
  // 兜底：浮层窗口不显示启动面板（入口已移除，这里防止未来入口调整后回归）。
  React.useEffect(() => {
    document.getElementById("boot-splash")?.remove();
    // 首帧骨架只负责「点开立即有反馈」：React 挂载后交给真实内容。
    document.getElementById("popover-skeleton")?.remove();
    delete document.documentElement.dataset.popoverLoading;
  }, []);
  const tr = useT();
  const api = useLoopsoarApi();
  // 主进程通过 props 传 kind；也兼容直接读 URL（便于手搓调试）
  const kindFromUrl = SEARCH_PARAMS.get("popover");
  const kind: ChromePopoverKind = isPopoverKind(kindProp)
    ? kindProp
    : isPopoverKind(kindFromUrl)
      ? kindFromUrl
      : "more";
  const lang = getLanguage();

  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const [bookmarks, setBookmarks] = React.useState<BookmarkItem[] | null>(null);
  const [history, setHistory] = React.useState<HistoryEntry[] | null>(null);
  const [downloads, setDownloads] = React.useState<DownloadItem[] | null>(null);
  const [workspaces, setWorkspaces] = React.useState<WorkspaceRecord[] | null>(null);
  const [workspaceTabs, setWorkspaceTabs] = React.useState<TabState[] | null>(null);
  const [tabMenuTabs, setTabMenuTabs] = React.useState<TabState[] | null>(null);
  const [activeWorkspaceId, setActiveWorkspaceId] = React.useState<string | null>(null);
  const [error, setError] = React.useState("");
  const [rowMenu, setRowMenu] = React.useState<
    | { kind: "download"; x: number; y: number; item: DownloadItem }
    | { kind: "history"; x: number; y: number; item: HistoryEntry }
    | { kind: "bookmark"; x: number; y: number; item: BookmarkItem }
    | null
  >(null);

  /* ------------------------------ 数据拉取 ------------------------------ */

  /** 下载列表刷新（条目操作后保持浮层不关，直接刷新数据）。 */
  const refreshDownloads = React.useCallback(async (): Promise<void> => {
    try {
      const result = await api?.browser.downloads();
      setDownloads(result?.downloads ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [api]);

  /** 下载列表实时刷新：小窗打开期间进度条要跟着动（否则只能重开才更新）。 */
  React.useEffect(() => {
    if (kind !== "downloads") return;
    try {
      return api?.on("browser:downloads", () => {
        void refreshDownloads();
      });
    } catch {
      return undefined;
    }
  }, [api, kind, refreshDownloads]);

  /** 拉取当前浮层数据：首次挂载 + 窗口被复用后重新显示都会调用。 */
  const loadData = React.useCallback(async (): Promise<void> => {
    setError("");
    try {
      if (kind === "bookmarks") {
        const result = await api?.bookmarks.list();
        setBookmarks(result?.bookmarks ?? []);
      } else if (kind === "history") {
        const result = await api?.browser.history({});
        setHistory(result?.entries ?? []);
      } else if (kind === "downloads") {
        const result = await api?.browser.downloads();
        setDownloads(result?.downloads ?? []);
      } else if (kind === "workspace") {
        // 浮层窗口与主窗口同进程、同一套 preload：listTabs 返回的就是「当前会话」的标签。
        const result = await api?.browser.listTabs();
        setWorkspaceTabs(result?.tabs ?? []);
      } else if (kind === "tabmenu") {
        // 标签右键菜单独立渲染：不隐藏网页、不截图，所以不会造成页面冻结/闪烁。
        const result = await api?.browser.listTabs();
        setTabMenuTabs(result?.tabs ?? []);
      } else if (kind === "workspaces") {
        const result = await api?.workspace.list();
        setWorkspaces(result?.workspaces ?? []);
        setActiveWorkspaceId(result?.activeId ?? null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [api, kind]);

  React.useEffect(() => {
    void loadData();
  }, [loadData]);

  // 浮层窗口按 kind 复用（关闭只 hide）：再次显示时从 hidden 变 visible，刷新一次数据，
  // 避免看到上一次打开时的旧列表/旧进度。
  React.useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") void loadData();
    };
    document.addEventListener("visibilitychange", onVisibility);
    // 隐藏窗口被 show 时 Chromium 不一定派发 visibilitychange（取决于窗口状态），
    // focus 是更稳的兜底：显示即刷新，点进菜单再刷新一次也无副作用。
    window.addEventListener("focus", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onVisibility);
    };
  }, [loadData]);

  /* ------------------------------ 动作协议 ------------------------------ */

  /**
   * 发动作：主进程 ui:popoverAction 会「先 push 给主窗口、再关闭浮层」，所以先发动作；
   * closePopover 紧跟着发（幂等兜底：旧主进程若没在动作里关窗口，这里补一刀）。
   * 注意不要 await closePopover —— 它会销毁本渲染进程，后续动作就丢了。
   */
  const dispatch = React.useCallback(
    (action: string, payload?: unknown): void => {
      const ui = api?.ui;
      if (!ui) return;
      void ui
        .popoverAction({ action, ...(payload === undefined ? {} : { payload }) })
        .catch(() => {
          // 主进程未接线/窗口随即销毁：静默
        });
      void ui.closePopover().catch(() => {});
    },
    [api],
  );

  const navigate = (url: string): void => {
    void dispatch("navigate", { url });
  };
  const openPage = (pageKind: "history" | "downloads" | "bookmarks" | "settings"): void => {
    void dispatch("openPage", { kind: pageKind });
  };
  /** 更多菜单里的列表项：原地把小浮层切换成对应列表（整页由列表底部「查看更多」进入）。 */
  const switchTo = (next: ChromePopoverKind): void => {
    void api?.ui?.popoverAction({ action: "switchPopover", payload: { kind: next } }).catch(() => {});
  };

  const copyText = (text: string): void => {
    void navigator.clipboard.writeText(text).catch(() => undefined);
  };

  const openInNewTab = (url: string): void => {
    void api?.browser.newTab({ url }).then(() => void api?.ui?.closePopover()).catch(() => undefined);
  };

  const openInNewWindow = (url: string): void => {
    const open = api?.ui?.openBrowserWindow;
    if (typeof open !== "function") {
      navigate(url);
      return;
    }
    void open({ url }).catch(() => undefined);
    void api?.ui?.closePopover().catch(() => undefined);
  };

  const removeHistoryEntry = (entry: HistoryEntry): void => {
    void api?.browser.historyRemove({ urls: [entry.url] }).then(() => void loadData()).catch(() => undefined);
  };

  const removeBookmarkEntry = (item: BookmarkItem): void => {
    void api?.bookmarks.remove({ id: item.id }).then(() => void loadData()).catch(() => undefined);
  };

  const runDownloadAction = (
    item: DownloadItem,
    action: "cancel" | "open" | "showInFolder" | "remove" | "deleteFile" | "start" | "alwaysOpen" | "retry",
  ): void => {
    void api?.browser.downloadAction({ id: item.id, action }).then(() => void refreshDownloads()).catch(() => undefined);
  };

  const menuItems: RowMenuItem[] = (() => {
    if (!rowMenu) return [];
    if (rowMenu.kind === "download") {
      const item = rowMenu.item;
      const items: RowMenuItem[] = [];
      if (item.state === "completed" && !item.missing) {
        items.push({ id: "open", label: tr("chromePage.downloads.openFile"), icon: "arrow-go", onClick: () => runDownloadAction(item, "open") });
      }
      if (item.state === "progressing" && item.queued) {
        items.push({ id: "start", label: tr("browser.downloadStart"), icon: "play", onClick: () => runDownloadAction(item, "start") });
      }
      if (item.state === "progressing") {
        items.push({ id: "cancel", label: tr("chromePage.downloads.cancel"), icon: "close", onClick: () => runDownloadAction(item, "cancel") });
      }
      if (item.state === "interrupted" || item.state === "cancelled") {
        items.push({ id: "retry", label: tr("chromePage.downloads.retry"), icon: "refresh", onClick: () => runDownloadAction(item, "retry") });
      }
      if (item.state === "completed" && !item.missing) {
        items.push({ id: "always", label: tr("chromePage.downloads.alwaysOpen"), icon: "check", onClick: () => runDownloadAction(item, "alwaysOpen") });
      }
      if (item.state === "completed" && !item.missing) {
        items.push({ id: "show", label: tr("chromePage.downloads.showInFolder"), icon: "folder", onClick: () => runDownloadAction(item, "showInFolder") });
      }
      items.push({ id: "copy", label: tr("chromePage.downloads.copyLink"), icon: "copy", onClick: () => copyText(item.url) });
      if (item.state === "completed" && !item.missing) {
        items.push({ id: "deleteFile", label: tr("chromePage.downloads.deleteFile"), icon: "delete", danger: true, separatorBefore: true, onClick: () => runDownloadAction(item, "deleteFile") });
      }
      items.push({ id: "remove", label: tr("chromePage.downloads.remove"), icon: "delete-record", danger: true, separatorBefore: item.state !== "completed", onClick: () => runDownloadAction(item, "remove") });
      return items;
    }
    if (rowMenu.kind === "history") {
      const item = rowMenu.item;
      return [
        { id: "open", label: tr("chromePage.history.openInNewTab"), icon: "arrow-go", onClick: () => openInNewTab(item.url) },
        { id: "window", label: tr("chromePage.history.openInNewWindow"), icon: "float", onClick: () => openInNewWindow(item.url) },
        { id: "copy", label: tr("chromePage.history.copyLink"), icon: "copy", separatorBefore: true, onClick: () => copyText(item.url) },
        { id: "delete", label: tr("chromePage.history.deleteItem"), icon: "delete", danger: true, separatorBefore: true, onClick: () => removeHistoryEntry(item) },
      ];
    }
    const item = rowMenu.item;
    return [
      { id: "open", label: tr("chromePage.bookmarks.openInNewTab"), icon: "arrow-go", onClick: () => openInNewTab(item.url) },
      { id: "window", label: tr("chromePage.bookmarks.openInNewWindow"), icon: "float", onClick: () => openInNewWindow(item.url) },
      { id: "copy", label: tr("chromePage.bookmarks.copyLink"), icon: "copy", separatorBefore: true, onClick: () => copyText(item.url) },
      { id: "delete", label: tr("chromePage.bookmarks.delete"), icon: "delete", danger: true, separatorBefore: true, onClick: () => removeBookmarkEntry(item) },
    ];
  })();

  /* ------------------------------ 窗口行为 ------------------------------ */

  // 打开聚焦容器（键盘可达）；Esc 关闭浮层窗口
  React.useEffect(() => {
    rootRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      void api?.ui?.closePopover().catch(() => {});
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [api]);

  /** ↑↓/Home·End 在可点条目间移动（窗口级焦点由主进程管理，这里只做列表内导航）。 */
  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const items = Array.from(
      rootRef.current?.querySelectorAll<HTMLButtonElement>(".chrome-pop-item:not(:disabled), .chrome-pop-viewmore:not(:disabled)") ?? [],
    );
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.findIndex((item) => item === document.activeElement);
    let next = current;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else if (event.key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % items.length;
    else next = current <= 0 ? items.length - 1 : current - 1;
    items[next]?.focus();
  };

  /* ------------------------------ 渲染 ------------------------------ */

  const header = (title: string, count: number): React.ReactElement => (
    <div className="chrome-pop-head">
      <span className="chrome-pop-title">{title}</span>
      <span className="chrome-pop-count">{tr("browser.popover.count", { count })}</span>
    </div>
  );

  const viewMore = (pageKind: "history" | "downloads" | "bookmarks"): React.ReactElement => (
    <div className="chrome-pop-footer">
      <button type="button" className="chrome-pop-viewmore" onClick={() => openPage(pageKind)}>
        {tr("browser.popover.viewMore")}
      </button>
    </div>
  );

  const loadingView = (): React.ReactElement => <div className="chrome-pop-empty">{tr("browser.popover.loading")}</div>;
  const errorView = (message: string): React.ReactElement => (
    <div className="chrome-pop-error">{tr("browser.popover.loadFailed", { error: message })}</div>
  );
  const emptyView = (label: string): React.ReactElement => <div className="chrome-pop-empty">{label}</div>;

  const renderWorkspaces = (): React.ReactElement => {
    if (workspaces === null) return loadingView();
    return (
      <div className="chrome-pop-menu" role="menu" aria-label={tr("browser.workspaceMenuTitle")} onKeyDown={onListKeyDown}>
        <div className="chrome-pop-head">
          <span className="chrome-pop-title">{tr("browser.workspaceMenuTitle")}</span>
        </div>
        {workspaces.map((item) => (
          <button
            key={item.id}
            type="button"
            role="menuitemradio"
            aria-checked={item.id === activeWorkspaceId}
            className="chrome-pop-item"
            onClick={() => void dispatch("selectWorkspace", { id: item.id })}
          >
            <Icon name={item.id === activeWorkspaceId ? "check" : "folder"} size={14} className="chrome-pop-icon" />
            <MarqueeText className="chrome-pop-label" text={item.name} />
          </button>
        ))}
        <div className="chrome-pop-sep" role="separator" />
        <button type="button" role="menuitem" className="chrome-pop-item" onClick={() => void dispatch("addWorkspace")}>
          <Icon name="workspace-add" size={14} className="chrome-pop-icon" />
          <span className="chrome-pop-label">{tr("chat.addWorkspace")}</span>
        </button>
      </div>
    );
  };

  /**
   * Agent 工作区（折叠标签组）：只列 `agentBound` 的网页，点一项切过去。
   * 浮层是独立窗口，所以展开时网页既不消失也不被往下挤（用户 m02333 的诉求）。
   */
  const renderWorkspaceTabs = (): React.ReactElement => {
    const bound = (workspaceTabs ?? []).filter((tab) => tab.agentBound === true);
    if (workspaceTabs === null) return loadingView();
    return (
      <div className="chrome-pop-menu" role="menu" aria-label={tr("browser.agentWorkspace")} onKeyDown={onListKeyDown}>
        {header(tr("browser.agentWorkspace"), bound.length)}
        {bound.length === 0
          ? emptyView(tr("browser.agentWorkspaceEmpty"))
          : bound.map((tab) => (
              <div className="chrome-pop-row" key={tab.id}>
                <button
                  type="button"
                  role="menuitem"
                  className="chrome-pop-item"
                  title={tab.url || tab.title}
                  onClick={() => void dispatch("selectTab", { tabId: tab.id })}
                >
                  {tab.active ? (
                    <Icon name="check" size={14} className="chrome-pop-icon" />
                  ) : (
                    <Icon name="globe" size={14} className="chrome-pop-icon" />
                  )}
                  <MarqueeText className="chrome-pop-label" text={tab.title || tab.url} title={tab.url || tab.title} />
                </button>
                <button
                  type="button"
                  className="chrome-pop-close"
                  title={tr("browser.closeTab")}
                  aria-label={tr("browser.closeTab")}
                  onClick={() => void dispatch("closeTab", { tabId: tab.id })}
                >
                  <Icon name="close" size={12} />
                </button>
              </div>
            ))}
      </div>
    );
  };

  const renderMore = (): React.ReactElement => (
    <div className="chrome-pop-menu" role="menu" aria-label={tr("browser.more")} onKeyDown={onListKeyDown}>
      <button type="button" role="menuitem" className="chrome-pop-item" onClick={() => switchTo("history")}>
        <Icon name="history" size={14} className="chrome-pop-icon" />
        <span className="chrome-pop-label">{tr("browser.menuHistory")}</span>
      </button>
      <button type="button" role="menuitem" className="chrome-pop-item" onClick={() => switchTo("downloads")}>
        <Icon name="download" size={14} className="chrome-pop-icon" />
        <span className="chrome-pop-label">{tr("browser.menuDownloads")}</span>
      </button>
      <button type="button" role="menuitem" className="chrome-pop-item" onClick={() => switchTo("bookmarks")}>
        <Icon name="star" size={14} className="chrome-pop-icon" />
        <span className="chrome-pop-label">{tr("browser.menuBookmarks")}</span>
      </button>
      <div className="chrome-pop-sep" role="separator" />
      <button type="button" role="menuitem" className="chrome-pop-item" onClick={() => void dispatch("savePage")}>
        <Icon name="file" size={14} className="chrome-pop-icon" />
        <span className="chrome-pop-label">{tr("browser.menuSavePage")}</span>
      </button>
      <button type="button" role="menuitem" className="chrome-pop-item" onClick={() => openPage("settings")}>
        <Icon name="settings" size={14} className="chrome-pop-icon" />
        <span className="chrome-pop-label">{tr("browser.menuSettings")}</span>
      </button>
    </div>
  );

  const renderBookmarks = (): React.ReactElement => {
    if (error) return errorView(error);
    if (bookmarks === null) return loadingView();
    const preview = bookmarks.slice(0, BOOKMARK_PREVIEW);
    return (
      <>
        {header(tr("browser.menuBookmarks"), preview.length)}
        {preview.length === 0 ? (
          emptyView(tr("browser.bookmarkEmpty"))
        ) : (
          <div className="chrome-pop-list" onKeyDown={onListKeyDown}>
            {preview.map((item) => (
              <button
                key={item.id}
                type="button"
                className="chrome-pop-item chrome-pop-item-two-line"
                title={item.url}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setRowMenu({ kind: "bookmark", x: event.clientX, y: event.clientY, item });
                }}
                onClick={() => navigate(item.url)}
              >
                <Icon name="star-filled" size={13} className="chrome-pop-icon" />
                <span className="chrome-pop-main">
                  <MarqueeText className="chrome-pop-label" text={item.title || item.url} />
                  <MarqueeText className="chrome-pop-sub" text={item.url} />
                </span>
              </button>
            ))}
          </div>
        )}
        {viewMore("bookmarks")}
      </>
    );
  };

  const renderHistory = (): React.ReactElement => {
    if (error) return errorView(error);
    if (history === null) return loadingView();
    const preview = history.slice(0, HISTORY_PREVIEW);
    return (
      <>
        {header(tr("browser.menuHistory"), preview.length)}
        {preview.length === 0 ? (
          emptyView(tr("browser.historyEmpty"))
        ) : (
          <div className="chrome-pop-list" onKeyDown={onListKeyDown}>
            {preview.map((entry, index) => (
              <button
                key={`${entry.url}-${index}`}
                type="button"
                className="chrome-pop-item chrome-pop-item-two-line"
                title={entry.url}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setRowMenu({ kind: "history", x: event.clientX, y: event.clientY, item: entry });
                }}
                onClick={() => navigate(entry.url)}
              >
                <Icon name="history" size={13} className="chrome-pop-icon" />
                <span className="chrome-pop-main">
                  <MarqueeText className="chrome-pop-label" text={entry.title || entry.url} />
                  <MarqueeText
                    className="chrome-pop-sub"
                    text={`${formatTime(entry.visitedAt, lang)}${entry.visitedAt ? " · " : ""}${entry.url}`}
                  />
                </span>
              </button>
            ))}
          </div>
        )}
        {viewMore("history")}
      </>
    );
  };

  const renderDownloads = (): React.ReactElement => {
    if (error) return errorView(error);
    if (downloads === null) return loadingView();
    const preview = downloads.slice(0, DOWNLOAD_PREVIEW);
    return (
      <>
        {header(tr("browser.menuDownloads"), preview.length)}
        {preview.length === 0 ? (
          emptyView(tr("browser.downloadEmpty"))
        ) : (
          <div className="chrome-pop-list" onKeyDown={onListKeyDown}>
              {preview.map((item) => {
                const ratio = item.total > 0 ? Math.min(1, item.received / item.total) : 0;
                return (
                  <div
                    key={item.id}
                    className="chrome-pop-item chrome-pop-item-static"
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setRowMenu({ kind: "download", x: event.clientX, y: event.clientY, item });
                    }}
                  >
                    <span className="chrome-pop-icon"><DownloadIcon url={item.url} filename={item.filename} size={13} /></span>
                    <span className="chrome-pop-main">
                      <MarqueeText
                        className="chrome-pop-label"
                        text={item.filename}
                        title={item.savePath}
                        style={item.missing ? { textDecoration: "line-through", opacity: 0.55 } : undefined}
                      />
                      <span className="chrome-pop-sub">
                        {item.queued
                          ? tr("browser.downloadQueued")
                          : item.state === "progressing"
                            ? `${Math.round(ratio * 100)}% · ${tr("browser.popover.downloading")}`
                            : item.state === "completed" && !item.missing
                              ? (
                                <button type="button" className="chrome-pop-open-link" onClick={() => runDownloadAction(item, "open")}>
                                  {tr("chromePage.downloads.openFile")}
                                </button>
                              )
                              : downloadStatusText(item, tr)}
                      </span>
                      {item.state === "progressing" && !item.queued ? (
                        <span
                          aria-hidden="true"
                          style={{
                            display: "block",
                            height: 3,
                            borderRadius: 2,
                            marginTop: 4,
                            overflow: "hidden",
                            background: "rgba(255,255,255,0.08)",
                          }}
                        >
                          <span
                            style={{
                              display: "block",
                              height: "100%",
                              width: `${Math.round(ratio * 100)}%`,
                              background: "var(--ls-accent, #c8763c)",
                              transition: "width 160ms ease",
                            }}
                          />
                        </span>
                      ) : null}
                    </span>
                    <span className="chrome-pop-actions">
                      {item.state === "progressing" && item.queued ? (
                        <button
                          type="button"
                          className="chrome-pop-action"
                          title={tr("browser.downloadStart")}
                          aria-label={tr("browser.downloadStart")}
                          onClick={() => {
                            void api?.browser
                              .downloadAction({ id: item.id, action: "start" })
                              .catch(() => {})
                              .finally(() => void refreshDownloads());
                          }}
                        >
                          <Icon name="play" size={11} />
                        </button>
                      ) : null}
                      {item.state === "progressing" ? (
                        <button
                          type="button"
                          className="chrome-pop-action"
                          title={tr("browser.downloadCancel")}
                          aria-label={tr("browser.downloadCancel")}
                          onClick={() => {
                            void api?.browser
                              .downloadAction({ id: item.id, action: "cancel" })
                              .catch(() => {})
                              .finally(() => void refreshDownloads());
                          }}
                        >
                          <Icon name="close" size={11} />
                        </button>
                      ) : null}
                      {item.state === "completed" && !item.missing ? (
                        <button
                          type="button"
                          className="chrome-pop-action"
                          title={tr("browser.downloadShowInFolder")}
                          aria-label={tr("browser.downloadShowInFolder")}
                          onClick={() => {
                            void api?.browser.downloadAction({ id: item.id, action: "showInFolder" }).catch(() => {});
                          }}
                        >
                          <Icon name="folder" size={11} />
                        </button>
                      ) : null}
                      {item.state === "interrupted" || item.state === "cancelled" ? (
                        <button
                          type="button"
                          className="chrome-pop-action"
                          title={tr("chromePage.downloads.retry")}
                          aria-label={tr("chromePage.downloads.retry")}
                          onClick={() => runDownloadAction(item, "retry")}
                        >
                          <Icon name="refresh" size={11} />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="chrome-pop-action"
                        title={tr("browser.downloadRemove")}
                        aria-label={tr("browser.downloadRemove")}
                        onClick={() => {
                          void api?.browser
                            .downloadAction({ id: item.id, action: "remove" })
                            .catch(() => {})
                            .finally(() => void refreshDownloads());
                        }}
                      >
                        <Icon name="delete-record" size={12} />
                      </button>
                    </span>
                  </div>
                );
              })}
          </div>
        )}
        {viewMore("downloads")}
      </>
    );
  };

  const renderTabMenu = (): React.ReactElement => {
    const tabs = tabMenuTabs;
    const tab = tabs?.find((item) => item.id === TAB_MENU_TARGET);
    if (!tabs) return <div className="chrome-pop-empty">{tr("browser.loading")}</div>;
    if (!tab) return <div className="chrome-pop-error">{tr("browser.tabMenuUnavailable")}</div>;
    const index = tabs.findIndex((item) => item.id === tab.id);
    const hasOthers = tabs.some((item) => item.id !== tab.id && item.pinned !== true);
    const hasRight = index >= 0 && tabs.slice(index + 1).some((item) => item.pinned !== true);
    const run = (tabAction: string, payload: Record<string, unknown> = {}): void => {
      void dispatch("tabAction", { tabAction, tabId: tab.id, ...payload });
    };
    return (
      <div className="chrome-pop-menu" role="menu" aria-label={tr("browser.tabsAria")}>
        <button type="button" role="menuitem" className="chrome-pop-item" onClick={() => run("new-right")}>
          <Icon name="plus" size={16} className="chrome-pop-icon" />
          <span className="chrome-pop-label">{tr("browser.tabMenuNewRight")}</span>
        </button>
        <button type="button" role="menuitem" className="chrome-pop-item" onClick={() => run("reload")}>
          <Icon name="refresh" size={16} className="chrome-pop-icon" />
          <span className="chrome-pop-label">{tr("browser.tabMenuReload")}</span>
          <span className="chrome-pop-shortcut">Ctrl+R</span>
        </button>
        <button type="button" role="menuitem" className="chrome-pop-item" onClick={() => run("duplicate")}>
          <Icon name="copy" size={16} className="chrome-pop-icon" />
          <span className="chrome-pop-label">{tr("browser.tabMenuDuplicate")}</span>
          <span className="chrome-pop-shortcut">Ctrl+Shift+K</span>
        </button>
        <div className="chrome-pop-sep" />
        <button
          type="button"
          role="menuitem"
          className="chrome-pop-item"
          onClick={() => run(tab.muted ? "unmute" : "mute")}
        >
          <Icon name={tab.muted ? "volume-2" : "volume-x"} size={18} className="chrome-pop-icon" />
          <span className="chrome-pop-label">{tab.muted ? tr("browser.tabMenuUnmute") : tr("browser.tabMenuMute")}</span>
          <span className="chrome-pop-shortcut">Ctrl+M</span>
        </button>
        <button type="button" role="menuitem" className="chrome-pop-item" onClick={() => run(tab.pinned ? "unpin" : "pin")}>
          <Icon name="pin" size={16} className="chrome-pop-icon" />
          <span className="chrome-pop-label">{tab.pinned ? tr("browser.tabMenuUnpin") : tr("browser.tabMenuPin")}</span>
        </button>
        <div className="chrome-pop-sep" />
        <button type="button" role="menuitem" className="chrome-pop-item" onClick={() => run("close")}>
          <Icon name="close" size={16} className="chrome-pop-icon" />
          <span className="chrome-pop-label">{tr("browser.tabMenuClose")}</span>
          <span className="chrome-pop-shortcut">Ctrl+W</span>
        </button>
        <button type="button" role="menuitem" className="chrome-pop-item" onClick={() => run("reopen")}>
          <Icon name="history" size={16} className="chrome-pop-icon" />
          <span className="chrome-pop-label">{tr("browser.tabMenuReopen")}</span>
          <span className="chrome-pop-shortcut">Ctrl+Shift+T</span>
        </button>
        <div className="chrome-pop-sep" />
        <button
          type="button"
          role="menuitem"
          className="chrome-pop-item"
          disabled={!hasOthers}
          onClick={() => run("close-others")}
        >
          <span className="chrome-pop-icon" aria-hidden="true" />
          <span className="chrome-pop-label">{tr("browser.tabMenuCloseOthers")}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          className="chrome-pop-item"
          disabled={!hasRight}
          onClick={() => run("close-right")}
        >
          <span className="chrome-pop-icon" aria-hidden="true" />
          <span className="chrome-pop-label">{tr("browser.tabMenuCloseRight")}</span>
        </button>
        <div className="chrome-pop-sep" />
        <button type="button" role="menuitem" className="chrome-pop-item" disabled={!tab.url} onClick={() => run("copy-url")}>
          <Icon name="link" size={16} className="chrome-pop-icon" />
          <span className="chrome-pop-label">{tr("browser.tabMenuCopyUrl")}</span>
        </button>
      </div>
    );
  };

  return (
    <div
      ref={rootRef}
      className="chrome-pop-shell"
      tabIndex={-1}
      onKeyDown={onListKeyDown}
      onPointerDown={(event) => {
        // 300×380 的透明窗口比菜单卡片略大：点在卡片外的透明区域也应视为「点列表外」。
        if (event.target !== event.currentTarget) return;
        void api?.ui?.closePopover().catch(() => undefined);
      }}
    >
      <div className={`chrome-pop-card chrome-pop-${kind}`} role="presentation">
        {kind === "tabmenu"
          ? renderTabMenu()
          : kind === "workspace"
          ? renderWorkspaceTabs()
          : kind === "more"
            ? renderMore()
            : kind === "workspaces"
            ? renderWorkspaces()
            : kind === "bookmarks"
              ? renderBookmarks()
              : kind === "history"
                ? renderHistory()
                : renderDownloads()}
      </div>
      {rowMenu ? <RowContextMenu x={rowMenu.x} y={rowMenu.y} items={menuItems} onClose={() => setRowMenu(null)} /> : null}
    </div>
  );
}
