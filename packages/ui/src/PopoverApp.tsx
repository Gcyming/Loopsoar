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
import { BRAND } from "./theme.js";
import { Icon } from "./Icon.js";
import { useLoopsoarApi } from "./useLoopsoarApi.js";
import { getLanguage, setLanguage, useT } from "./i18n.js";
import type { BookmarkItem, ChromePopoverKind, DownloadItem, HistoryEntry } from "./types.js";

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

/** 浮层窗口透明背景（CSS 里 html[data-popover] 兜底，这里同步打标避免首帧白底闪烁）。 */
if (typeof document !== "undefined") {
  document.documentElement.dataset.popover = "1";
}

/** 预览条数上限（限条数 + 底部「查看更多」）。 */
const BOOKMARK_PREVIEW = 8;
const HISTORY_PREVIEW = 8;
const DOWNLOAD_PREVIEW = 5;

const POPOVER_KINDS: ChromePopoverKind[] = ["more", "bookmarks", "history", "downloads"];

function isPopoverKind(value: unknown): value is ChromePopoverKind {
  return typeof value === "string" && POPOVER_KINDS.includes(value as ChromePopoverKind);
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

export default function PopoverApp({ kind: kindProp }: PopoverAppProps): React.ReactElement {
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
  const [error, setError] = React.useState("");

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

  React.useEffect(() => {
    let alive = true;
    setError("");
    void (async () => {
      try {
        if (kind === "bookmarks") {
          const result = await api?.bookmarks.list();
          if (alive) setBookmarks(result?.bookmarks ?? []);
        } else if (kind === "history") {
          const result = await api?.browser.history({});
          if (alive) setHistory(result?.entries ?? []);
        } else if (kind === "downloads") {
          const result = await api?.browser.downloads();
          if (alive) setDownloads(result?.downloads ?? []);
        }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, kind]);

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
        <Icon name="arrow-go" size={12} className="chrome-pop-viewmore-icon" />
      </button>
    </div>
  );

  const loadingView = (): React.ReactElement => <div className="chrome-pop-empty">{tr("browser.popover.loading")}</div>;
  const errorView = (message: string): React.ReactElement => (
    <div className="chrome-pop-error">{tr("browser.popover.loadFailed", { error: message })}</div>
  );
  const emptyView = (label: string): React.ReactElement => <div className="chrome-pop-empty">{label}</div>;

  const renderMore = (): React.ReactElement => (
    <div className="chrome-pop-menu" role="menu" aria-label={tr("browser.more")} onKeyDown={onListKeyDown}>
      <button type="button" role="menuitem" className="chrome-pop-item" onClick={() => openPage("history")}>
        <Icon name="history" size={14} className="chrome-pop-icon" />
        <span className="chrome-pop-label">{tr("browser.menuHistory")}</span>
      </button>
      <button type="button" role="menuitem" className="chrome-pop-item" onClick={() => openPage("downloads")}>
        <Icon name="download" size={14} className="chrome-pop-icon" />
        <span className="chrome-pop-label">{tr("browser.menuDownloads")}</span>
      </button>
      <button type="button" role="menuitem" className="chrome-pop-item" onClick={() => openPage("bookmarks")}>
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
                onClick={() => navigate(item.url)}
              >
                <Icon name="star-filled" size={13} className="chrome-pop-icon" />
                <span className="chrome-pop-main">
                  <span className="chrome-pop-label">{item.title || item.url}</span>
                  <span className="chrome-pop-sub">{item.url}</span>
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
                onClick={() => navigate(entry.url)}
              >
                <Icon name="history" size={13} className="chrome-pop-icon" />
                <span className="chrome-pop-main">
                  <span className="chrome-pop-label">{entry.title || entry.url}</span>
                  <span className="chrome-pop-sub">
                    {formatTime(entry.visitedAt, lang)}
                    {entry.visitedAt ? " · " : ""}
                    {entry.url}
                  </span>
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
                  <div key={item.id} className="chrome-pop-item chrome-pop-item-static">
                    <Icon name="file" size={13} className="chrome-pop-icon" />
                    <span className="chrome-pop-main">
                      <span className="chrome-pop-label" title={item.savePath}>{item.filename}</span>
                      <span className="chrome-pop-sub">
                        {item.state === "progressing"
                          ? `${Math.round(ratio * 100)}% · ${tr("browser.popover.downloading")}`
                          : tr(downloadStateKey(item.state))}
                      </span>
                    </span>
                    <span className="chrome-pop-actions">
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
                      {item.state === "completed" ? (
                        <>
                          <button
                            type="button"
                            className="chrome-pop-action"
                            title={tr("browser.downloadOpen")}
                            aria-label={tr("browser.downloadOpen")}
                            onClick={() => {
                              void api?.browser.downloadAction({ id: item.id, action: "open" }).catch(() => {});
                            }}
                          >
                            <Icon name="arrow-go" size={11} />
                          </button>
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
                        </>
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
                        <Icon name="close" size={11} />
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

  return (
    <div ref={rootRef} className="chrome-pop-shell" tabIndex={-1}>
      <div className={`chrome-pop-card chrome-pop-${kind}`} role="presentation">
        {kind === "more"
          ? renderMore()
          : kind === "bookmarks"
            ? renderBookmarks()
            : kind === "history"
              ? renderHistory()
              : renderDownloads()}
      </div>
    </div>
  );
}
