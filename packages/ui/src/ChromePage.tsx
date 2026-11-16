/**
 * ChromePage —— 浏览器管理整页（历史 / 下载 / 收藏夹 / 设置）。
 *
 * 背景：原来「查看更多 / 历史 / 下载 / 收藏夹 / 设置」是顶栏小浮层（锚定弹层），
 * 条目一多就挤成小滚动区；改为像 Edge 一样整页打开：覆盖主界面内容区、顶部返回栏 + 标题、
 * 内容区铺满，数据量再大也能正常浏览。
 *
 * 职责与边界：
 *   · 纯展示 + 数据加载：所有动作由 App 注入（onClose / onNavigate / onNotice…），本组件不碰 App 状态；
 *   · 数据全部经 preload 白名单：browser.history / browser.downloads + downloadAction / bookmarks.list + remove；
 *   · settings 页复用现有 Settings 组件（fullPage 模式：去掉模态外壳与自身标题栏）；
 *   · i18n：文案走 chromePage.* 词典（`useT()` 的 tr 调用），词典在 i18nChrome.ts（i18n.ts 已合并）。
 */
import * as React from "react";
import { LAYOUT } from "loopsoar-contracts/layout";
import { BRAND } from "./theme.js";
import { Icon } from "./Icon.js";
import Settings from "./Settings.js";
import { getLanguage, useT } from "./i18n.js";
import type {
  BookmarkItem,
  ChromePageKind,
  DownloadItem,
  HistoryEntry,
  LoopsoarAPI,
} from "./types.js";

export interface ChromePageProps {
  /** 打开哪一类管理页。 */
  kind: ChromePageKind;
  /** preload 暴露的受控 API（非 Electron 环境为 null，页面显示不可用）。 */
  api: LoopsoarAPI | null;
  /** 顶部「← 返回」与 Esc：由 App 收起整页、回到主界面。 */
  onClose: () => void;
  /** 点击历史/书签条目：由 App 导航当前标签。 */
  onNavigate: (url: string) => void;
  /** 顶栏页面按钮：在历史/下载/收藏/设置之间直接跳转（不再放「保存页面 / 刷新」这类无效入口）。 */
  onOpenPage?: (kind: ChromePageKind) => void;
  /** 可选：非 settings 页顶栏的「打开设置」快捷入口（缺省不显示）。 */
  onOpenSettings?: () => void;
  /** 可选：设置页内打开外链（商店等）；由 App 负责离开整页并真实打开页面。 */
  onOpenUrl?: (url: string) => void;
  /** 可选：操作结果提示（删除书签 / 移除下载记录等），缺省静默。 */
  onNotice?: (text: string) => void;
}

/** 列表加载状态：一份数据 + 明确的 loading/error 语义（避免"空列表"和"加载失败"混在一起）。 */
interface ListState<T> {
  status: "loading" | "ready" | "error";
  items: T[];
  error?: string;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 时间展示：按当前语言短格式；无有效时间戳返回空串（调用方回退「时间未知」）。 */
function formatTime(at: number | undefined): string {
  if (!at || !Number.isFinite(at)) return "";
  return new Date(at).toLocaleString(getLanguage() === "en-US" ? "en-US" : "zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 下载状态 → 词典 key。 */
function downloadStateKey(state: DownloadItem["state"]): string {
  switch (state) {
    case "completed":
      return "chromePage.downloads.completed";
    case "cancelled":
      return "chromePage.downloads.cancelled";
    case "interrupted":
      return "chromePage.downloads.interrupted";
    default:
      return "chromePage.downloads.progressing";
  }
}

/** 空态 / 错误态 / 加载态的统一小卡。 */
function StateBox({ kind, text, onRetry, retryLabel }: {
  kind: "loading" | "error" | "empty";
  text: string;
  onRetry?: () => void;
  retryLabel?: string;
}): React.ReactElement {
  return (
    <div style={kind === "error" ? styles.stateError : styles.stateBox}>
      {kind === "loading" ? <span className="spinner" style={{ marginRight: 8 }} /> : null}
      <span>{text}</span>
      {onRetry ? (
        <button type="button" className="btn-ghost" style={styles.stateRetry} onClick={onRetry}>
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}

export default function ChromePage({
  kind,
  api,
  onClose,
  onNavigate,
  onOpenPage,
  onOpenSettings,
  onOpenUrl,
  onNotice,
}: ChromePageProps): React.JSX.Element {
  const tr = useT();
  const [history, setHistory] = React.useState<ListState<HistoryEntry>>({ status: "loading", items: [] });
  const [downloads, setDownloads] = React.useState<ListState<DownloadItem>>({ status: "loading", items: [] });
  const [bookmarks, setBookmarks] = React.useState<ListState<BookmarkItem>>({ status: "loading", items: [] });
  /** 历史批量选择：进入后每行左侧出现勾选框、列表上方出现操作条。 */
  const [historySelectMode, setHistorySelectMode] = React.useState(false);
  const [historySelected, setHistorySelected] = React.useState<Set<string>>(new Set());
  const [historyDeleting, setHistoryDeleting] = React.useState(false);
  /** 缺图标的历史行：每个 URL 只回抓一次，抓到后写回 state 并刷新。 */
  const faviconTriedRef = React.useRef<Set<string>>(new Set());
  /** 左侧索引栏：搜索框 + 分类筛选（致敬 Edge 下载/收藏/历史页的三栏布局）。 */
  const [searchQuery, setSearchQuery] = React.useState("");
  const [sideFilter, setSideFilter] = React.useState("all");

  const title = tr(`chromePage.title.${kind}`);

  const loadHistory = React.useCallback(async (): Promise<void> => {
    if (!api) {
      setHistory({ status: "error", items: [], error: tr("chromePage.error", { error: "api unavailable" }) });
      return;
    }
    setHistory((prev) => ({ ...prev, status: "loading" }));
    try {
      const result = await api.browser.history({});
      setHistory({ status: "ready", items: result.entries });
    } catch (e) {
      setHistory({ status: "error", items: [], error: errorText(e) });
    }
  }, [api, tr]);

  const loadDownloads = React.useCallback(async (): Promise<void> => {
    if (!api) {
      setDownloads({ status: "error", items: [], error: tr("chromePage.error", { error: "api unavailable" }) });
      return;
    }
    setDownloads((prev) => ({ ...prev, status: "loading" }));
    try {
      const result = await api.browser.downloads();
      setDownloads({ status: "ready", items: result.downloads });
    } catch (e) {
      setDownloads({ status: "error", items: [], error: errorText(e) });
    }
  }, [api, tr]);

  const loadBookmarks = React.useCallback(async (): Promise<void> => {
    if (!api || !api.bookmarks) {
      setBookmarks({ status: "error", items: [], error: tr("chromePage.bookmarks.unavailable") });
      return;
    }
    setBookmarks((prev) => ({ ...prev, status: "loading" }));
    try {
      const result = await api.bookmarks.list();
      setBookmarks({ status: "ready", items: result.bookmarks });
    } catch (e) {
      setBookmarks({ status: "error", items: [], error: errorText(e) });
    }
  }, [api, tr]);

  // 按页面类型加载（切换 kind 会重新拉取；settings 不需要数据）
  React.useEffect(() => {
    if (kind === "history") void loadHistory();
    else if (kind === "downloads") void loadDownloads();
    else if (kind === "bookmarks") void loadBookmarks();
  }, [kind, loadHistory, loadDownloads, loadBookmarks]);

  // 切页时清空搜索/筛选/批量选择：避免带着上一页的状态进入新页面。
  React.useEffect(() => {
    setSearchQuery("");
    setSideFilter("all");
    setHistorySelectMode(false);
    setHistorySelected(new Set());
  }, [kind]);

  // 下载页跟随主进程推送实时刷新（进度/完成/取消都会变）
  React.useEffect(() => {
    if (!api || kind !== "downloads") return;
    try {
      return api.on("browser:downloads", () => {
        void loadDownloads();
      });
    } catch {
      // 旧 shell 未登记该事件：退化为手动刷新
      return undefined;
    }
  }, [api, kind, loadDownloads]);

  // Esc = 返回（与设置面板的键盘习惯一致）
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /* ── 左侧索引栏：搜索 + 分类（Edge 式三栏：索引 / 内容） ── */
  const dayStart = (offset: number): number => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - offset);
    return d.getTime();
  };
  const query = searchQuery.trim().toLowerCase();
  const matchText = (text: string | undefined): boolean => !query || (text ?? "").toLowerCase().includes(query);

  // 历史条目缺 favicon（旧数据/首次抓取失败）→ 按页面 URL 回抓，成功后原地替换该行图标。
  React.useEffect(() => {
    if (!api || kind !== "history" || history.status !== "ready") return;
    const missing = history.items.filter((item) => !item.favicon && !faviconTriedRef.current.has(item.url)).slice(0, 30);
    if (missing.length === 0) return;
    let alive = true;
    void Promise.allSettled(
      missing.map(async (item) => {
        faviconTriedRef.current.add(item.url);
        const resolved = await api.browser.resolveFavicon({ url: item.url });
        if (!alive || !resolved?.favicon) return;
        setHistory((prev) => ({
          ...prev,
          items: prev.items.map((row) => (row.url === item.url ? { ...row, favicon: resolved.favicon ?? undefined } : row)),
        }));
      }),
    );
    return () => {
      alive = false;
    };
  }, [api, kind, history]);

  const visibleHistory = history.items.filter((item) => {
    const visitedAt = item.visitedAt ?? 0;
    if (sideFilter === "today" && visitedAt < dayStart(0)) return false;
    if (sideFilter === "yesterday" && !(visitedAt >= dayStart(1) && visitedAt < dayStart(0))) return false;
    if (sideFilter === "earlier" && visitedAt >= dayStart(1)) return false;
    return matchText(item.title) || matchText(item.url);
  });
  const visibleDownloads = downloads.items.filter((item) => {
    if (sideFilter !== "all" && item.state !== sideFilter) return false;
    return matchText(item.filename) || matchText(item.savePath);
  });
  const visibleBookmarks = bookmarks.items.filter((item) => {
    const createdAt = item.createdAt ?? 0;
    if (sideFilter === "week" && createdAt < Date.now() - 7 * 24 * 3600 * 1000) return false;
    if (sideFilter === "earlier" && createdAt >= Date.now() - 7 * 24 * 3600 * 1000) return false;
    return matchText(item.title) || matchText(item.url);
  });

  interface SideFilterDef {
    id: string;
    labelKey: string;
    icon: string;
  }
  const sideFilters: SideFilterDef[] =
    kind === "history"
      ? [
          { id: "all", labelKey: "chromePage.filter.all", icon: "list-details" },
          { id: "today", labelKey: "chromePage.filter.today", icon: "clock" },
          { id: "yesterday", labelKey: "chromePage.filter.yesterday", icon: "clock" },
          { id: "earlier", labelKey: "chromePage.filter.earlier", icon: "history" },
        ]
      : kind === "downloads"
        ? [
            { id: "all", labelKey: "chromePage.filter.all", icon: "list-details" },
            { id: "progressing", labelKey: "chromePage.downloads.progressing", icon: "download" },
            { id: "completed", labelKey: "chromePage.downloads.completed", icon: "check" },
            { id: "cancelled", labelKey: "chromePage.downloads.cancelled", icon: "close" },
            { id: "interrupted", labelKey: "chromePage.downloads.interrupted", icon: "warning" },
          ]
        : [
            { id: "all", labelKey: "chromePage.filter.all", icon: "list-details" },
            { id: "week", labelKey: "chromePage.filter.recentWeek", icon: "star" },
            { id: "earlier", labelKey: "chromePage.filter.earlier", icon: "history" },
          ];
  const searchPlaceholderKey =
    kind === "history" ? "chromePage.search.history" : kind === "downloads" ? "chromePage.search.downloads" : "chromePage.search.bookmarks";

  // 筛选/搜索变化后清空已选：操作条删除的永远是当前可见集合，避免误删被过滤掉的条目。
  React.useEffect(() => {
    setHistorySelected(new Set());
  }, [sideFilter, searchQuery]);
  const count = kind === "history" ? history.items.length : kind === "downloads" ? downloads.items.length : kind === "bookmarks" ? bookmarks.items.length : -1;

  /* ── 历史批量选择 ── */
  const allHistorySelected = visibleHistory.length > 0 && visibleHistory.every((item) => historySelected.has(item.url));
  const exitHistorySelection = (): void => {
    setHistorySelectMode(false);
    setHistorySelected(new Set());
  };
  const toggleHistoryItem = (url: string): void => {
    setHistorySelected((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  };
  const toggleAllHistory = (): void => {
    setHistorySelected(allHistorySelected ? new Set() : new Set(visibleHistory.map((item) => item.url)));
  };
  const deleteSelectedHistory = async (): Promise<void> => {
    if (!api || historySelected.size === 0) return;
    setHistoryDeleting(true);
    try {
      const urls = [...historySelected];
      const result = await api.browser.historyRemove({ urls });
      onNotice?.(tr("chromePage.history.deleted", { count: result.removed }));
      await loadHistory();
      exitHistorySelection();
    } catch (e) {
      onNotice?.(tr("chromePage.error", { error: errorText(e) }));
    } finally {
      setHistoryDeleting(false);
    }
  };

  const downloadAction = (item: DownloadItem, action: "cancel" | "open" | "showInFolder" | "remove"): void => {
    if (!api) return;
    void api.browser
      .downloadAction({ id: item.id, action })
      .then(() => {
        if (action === "remove") {
          onNotice?.(tr("chromePage.downloads.removed"));
          void loadDownloads();
        }
      })
      .catch((e: unknown) => onNotice?.(tr("chromePage.error", { error: errorText(e) })));
  };

  const removeBookmark = (item: BookmarkItem): void => {
    if (!api || !api.bookmarks) return;
    void api.bookmarks
      .remove({ id: item.id })
      .then(() => {
        onNotice?.(tr("chromePage.bookmarks.removed"));
        void loadBookmarks();
      })
      .catch((e: unknown) => onNotice?.(tr("chromePage.error", { error: errorText(e) })));
  };

  /* ── 各页内容 ── */
  const historyContent = history.status === "loading" && history.items.length === 0
    ? <StateBox kind="loading" text={tr("chromePage.loading")} />
    : history.status === "error"
      ? <StateBox kind="error" text={tr("chromePage.error", { error: history.error ?? "unknown" })} onRetry={() => void loadHistory()} retryLabel={tr("chromePage.retry")} />
      : history.items.length === 0
        ? <StateBox kind="empty" text={tr("chromePage.history.empty")} />
        : (
          <div style={styles.listWrap}>
            {/* 批量操作条固定在列表最上方：与下方每一行同宽、同左缘（不再凸出列表之外）。 */}
            {historySelectMode ? (
              <div style={styles.selectionBar} data-testid="history-selection-bar">
                <button type="button" style={styles.selectionAll} role="checkbox" aria-checked={allHistorySelected} onClick={toggleAllHistory}>
                  <span style={{ ...styles.checkbox, ...(allHistorySelected ? styles.checkboxOn : null) }}>
                    {allHistorySelected ? <Icon name="check" size={10} /> : null}
                  </span>
                  <span>{tr("chromePage.history.selectAll")}</span>
                </button>
                <span style={styles.selectionCount}>{tr("chromePage.history.selected", { count: historySelected.size })}</span>
                <span style={styles.spacer} />
                <button type="button" className="btn-ghost" style={styles.selectionBtn} onClick={exitHistorySelection}>
                  {tr("chromePage.history.cancel")}
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  style={{ ...styles.selectionBtn, ...styles.selectionDelete }}
                  disabled={historySelected.size === 0 || historyDeleting}
                  onClick={() => void deleteSelectedHistory()}
                  data-testid="history-delete-selected"
                >
                  {tr("chromePage.history.delete", { count: historySelected.size })}
                </button>
              </div>
            ) : null}
            {visibleHistory.length === 0 ? (
              <StateBox kind="empty" text={tr("chromePage.filter.noMatch")} />
            ) : (
              <div style={styles.list}>
                {visibleHistory.map((item) => {
                  const selected = historySelected.has(item.url);
                  return (
                    <button
                      key={item.url}
                      type="button"
                      style={{
                        ...styles.row,
                        ...(historySelectMode ? styles.rowSelecting : null),
                        ...(selected ? styles.rowSelected : null),
                      }}
                      title={item.url}
                      onClick={() => {
                        if (historySelectMode) toggleHistoryItem(item.url);
                        else onNavigate(item.url);
                      }}
                    >
                      {/* 勾选框：只有批量模式才占位；宽度/透明度过渡 → 「平滑出现」而不是整行跳一下 */}
                      <span
                        style={{
                          ...styles.checkSlot,
                          width: historySelectMode ? 18 : 0,
                          marginRight: historySelectMode ? 9 : 0,
                          opacity: historySelectMode ? 1 : 0,
                        }}
                      >
                        <span style={{ ...styles.checkbox, ...(selected ? styles.checkboxOn : null) }}>
                          {selected ? <Icon name="check" size={10} /> : null}
                        </span>
                      </span>
                      <span style={styles.rowIcon}>
                        {item.favicon ? (
                          <img src={item.favicon} alt="" width={15} height={15} style={styles.rowFavicon} />
                        ) : (
                          <span style={styles.rowLetter}>{(item.title || item.url).replace(/^https?:\/\//, "").trim().charAt(0).toUpperCase() || "·"}</span>
                        )}
                      </span>
                      <span style={styles.rowMain}>
                        <span style={styles.rowTitle}>{item.title || tr("chromePage.history.untitled")}</span>
                        <span style={styles.rowUrl}>{item.url}</span>
                      </span>
                      <span style={styles.rowMeta}>
                        {item.visitCount && item.visitCount > 1 ? <span style={styles.badge}>{tr("chromePage.history.visits", { count: item.visitCount })}</span> : null}
                        <span style={styles.rowTime} title={tr("chromePage.history.visitedAt")}>{formatTime(item.visitedAt) || tr("chromePage.unknownTime")}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
  const downloadsContent = downloads.status === "loading" && downloads.items.length === 0
    ? <StateBox kind="loading" text={tr("chromePage.loading")} />
    : downloads.status === "error"
      ? <StateBox kind="error" text={tr("chromePage.error", { error: downloads.error ?? "unknown" })} onRetry={() => void loadDownloads()} retryLabel={tr("chromePage.retry")} />
      : downloads.items.length === 0
        ? <StateBox kind="empty" text={tr("chromePage.downloads.empty")} />
        : visibleDownloads.length === 0
          ? <StateBox kind="empty" text={tr("chromePage.filter.noMatch")} />
          : (
            <div style={styles.list}>
              {visibleDownloads.map((item) => {
                const pct = Math.round((item.received / Math.max(1, item.total)) * 100);
                return (
                  <div key={item.id} style={styles.dlRow}>
                    <span style={styles.rowIcon}><Icon name="download" size={15} /></span>
                    <span style={styles.rowMain}>
                      <span style={styles.rowTitle}>{item.filename}</span>
                      <span style={styles.rowUrl}>{tr("chromePage.downloads.savedTo", { path: item.savePath })}</span>
                    </span>
                    <span style={styles.rowMeta}>
                      <span style={item.state === "interrupted" ? styles.badgeError : styles.badge}>
                        {tr(downloadStateKey(item.state))}
                        {item.state === "progressing" ? ` · ${tr("chromePage.downloads.percent", { pct })}` : ""}
                      </span>
                      <span style={styles.rowTime}>{formatTime(item.startedAt)}</span>
                    </span>
                    <span style={styles.rowActions}>
                      {item.state === "progressing" ? (
                        <button type="button" className="icon-btn" title={tr("chromePage.downloads.cancel")} onClick={() => downloadAction(item, "cancel")}>
                          <Icon name="close" size={13} />
                        </button>
                      ) : null}
                      {item.state === "completed" ? (
                        <button type="button" className="icon-btn" title={tr("chromePage.open")} onClick={() => downloadAction(item, "open")}>
                          <Icon name="arrow-go" size={13} />
                        </button>
                      ) : null}
                      <button type="button" className="icon-btn" title={tr("chromePage.downloads.showInFolder")} onClick={() => downloadAction(item, "showInFolder")}>
                        <Icon name="folder" size={13} />
                      </button>
                      <button type="button" className="icon-btn" title={tr("chromePage.downloads.remove")} onClick={() => downloadAction(item, "remove")}>
                        <Icon name="close" size={13} />
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          );
  const bookmarksContent = bookmarks.status === "loading" && bookmarks.items.length === 0
    ? <StateBox kind="loading" text={tr("chromePage.loading")} />
    : bookmarks.status === "error"
      ? <StateBox kind="error" text={tr("chromePage.error", { error: bookmarks.error ?? "unknown" })} onRetry={() => void loadBookmarks()} retryLabel={tr("chromePage.retry")} />
      : bookmarks.items.length === 0
        ? <StateBox kind="empty" text={tr("chromePage.bookmarks.empty")} />
        : visibleBookmarks.length === 0
          ? <StateBox kind="empty" text={tr("chromePage.filter.noMatch")} />
          : (
            <div style={styles.list}>
              {visibleBookmarks.map((item) => (
                <div key={item.id} style={styles.dlRow}>
                  <button type="button" style={styles.rowButton} title={item.url} onClick={() => onNavigate(item.url)}>
                    <span style={styles.rowIcon}><Icon name="star-filled" size={15} /></span>
                    <span style={styles.rowMain}>
                      <span style={styles.rowTitle}>{item.title || item.url}</span>
                      <span style={styles.rowUrl}>{item.url}</span>
                    </span>
                    <span style={styles.rowMeta}>
                      <span style={styles.rowTime}>{tr("chromePage.bookmarks.addedAt", { time: formatTime(item.createdAt) || tr("chromePage.unknownTime") })}</span>
                    </span>
                  </button>
                  <span style={styles.rowActions}>
                    <button type="button" className="icon-btn" title={tr("chromePage.bookmarks.delete")} onClick={() => removeBookmark(item)}>
                      <Icon name="close" size={13} />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          );
  return (
    <div className="chrome-page" data-fullpage-overlay="chrome-page" style={styles.root} role="region" aria-label={title}>
      <header style={styles.topBar}>
        <button type="button" className="icon-btn" style={styles.backBtn} title={tr("chromePage.back")} aria-label={tr("chromePage.back")} onClick={onClose} autoFocus>
          <Icon name="back" size={16} />
        </button>
        <span style={styles.titleText}>{title}</span>
        {count >= 0 ? <span style={styles.countText}>{tr("chromePage.count", { count })}</span> : null}
        {kind === "settings" ? <span style={styles.hintText}>{tr("chromePage.settings.hint")}</span> : null}
        <span style={styles.spacer} />
        {kind !== "settings" ? (
          <span style={styles.actions}>
            {kind !== "history" && onOpenPage ? (
              <button type="button" className="icon-btn" title={tr("chromePage.openHistory")} aria-label={tr("chromePage.openHistory")} onClick={() => onOpenPage("history")}>
                <Icon name="history" size={15} />
              </button>
            ) : null}
            {kind !== "downloads" && onOpenPage ? (
              <button type="button" className="icon-btn" title={tr("chromePage.openDownloads")} aria-label={tr("chromePage.openDownloads")} onClick={() => onOpenPage("downloads")}>
                <Icon name="download" size={15} />
              </button>
            ) : null}
            {kind !== "bookmarks" && onOpenPage ? (
              <button type="button" className="icon-btn" title={tr("chromePage.openBookmarks")} aria-label={tr("chromePage.openBookmarks")} onClick={() => onOpenPage("bookmarks")}>
                <Icon name="star" size={15} />
              </button>
            ) : null}
            {onOpenSettings ? (
              <button type="button" className="icon-btn" title={tr("chromePage.openSettings")} aria-label={tr("chromePage.openSettings")} onClick={onOpenSettings}>
                <Icon name="settings" size={15} />
              </button>
            ) : null}
            {kind === "history" && !historySelectMode ? (
              <button
                type="button"
                className="btn-ghost"
                style={styles.clearBtn}
                title={tr("chromePage.history.clear")}
                onClick={() => {
                  setHistorySelected(new Set());
                  setHistorySelectMode(true);
                }}
                data-testid="history-clear"
              >
                {tr("chromePage.history.clear")}
              </button>
            ) : null}
          </span>
        ) : null}
      </header>
      <main style={kind === "settings" ? styles.bodyFill : styles.bodySplit}>
        {kind === "settings" ? (
          <Settings fullPage api={api} onClose={onClose} onOpenUrl={onOpenUrl} />
        ) : (
          <>
            {/* 左侧索引栏（Edge 式）：顶部搜索框 + 分类筛选，把每行左侧的空白利用起来 */}
            <aside style={styles.sidebar}>
              <div style={styles.sideSearch}>
                <Icon name="search" size={13} style={styles.sideSearchIcon} />
                <input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder={tr(searchPlaceholderKey)}
                  aria-label={tr(searchPlaceholderKey)}
                  style={styles.sideSearchInput}
                  data-testid="chrome-search"
                />
              </div>
              <div style={styles.sideList}>
                {sideFilters.map((filter) => (
                  <button
                    key={filter.id}
                    type="button"
                    style={{ ...styles.sideItem, ...(sideFilter === filter.id ? styles.sideItemActive : null) }}
                    onClick={() => setSideFilter(filter.id)}
                    aria-pressed={sideFilter === filter.id}
                  >
                    <Icon name={filter.icon} size={14} style={styles.sideItemIcon} />
                    <span>{tr(filter.labelKey)}</span>
                  </button>
                ))}
              </div>
            </aside>
            <div style={styles.contentCol}>
              {kind === "history" ? historyContent : kind === "downloads" ? downloadsContent : bookmarksContent}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  /** 整页覆盖主界面内容区：保留顶部自定义标题栏（窗口拖动/最小化/关闭仍可用），
   *  其余区域（浏览器工具栏/内容/状态栏）全部被本页接管；App 根节点是 position:relative。 */
  root: {
    position: "absolute",
    top: LAYOUT.TITLE_BAR_HEIGHT,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 45,
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    background: BRAND.ink,
    color: BRAND.linen,
    animation: "fadeUp 160ms ease both",
  },
  topBar: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexShrink: 0,
    height: 48,
    padding: "0 12px",
    borderBottom: `1px solid ${BRAND.border}`,
    background: BRAND.inkRaised,
  },
  backBtn: { width: 30, height: 30 },
  titleText: { fontSize: 14, fontWeight: 700, letterSpacing: 0.2 },
  countText: { fontSize: 11, color: BRAND.linenFaint },
  hintText: { fontSize: 11, color: BRAND.linenFaint, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  spacer: { flex: 1 },
  actions: { display: "inline-flex", alignItems: "center", gap: 4 },
  clearBtn: {
    height: 26,
    fontSize: 11.5,
    padding: "0 12px",
    borderRadius: 7,
    border: "1px solid rgba(200,118,60,0.55)",
    background: "rgba(200,118,60,0.14)",
    color: BRAND.ochreHover,
    cursor: "pointer",
    fontWeight: 600,
  },
  bodySplit: { flex: 1, minHeight: 0, minWidth: 0, display: "flex" },
  sidebar: {
    width: 216,
    flex: "none",
    display: "flex",
    flexDirection: "column",
    gap: 10,
    padding: "14px 10px 18px 14px",
    borderRight: `1px solid ${BRAND.border}`,
    boxSizing: "border-box",
  },
  sideSearch: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    height: 30,
    padding: "0 8px",
    borderRadius: 8,
    border: `1px solid ${BRAND.border}`,
    background: BRAND.inkRaised,
    boxSizing: "border-box",
  },
  sideSearchIcon: { color: BRAND.linenFaint, flex: "none" },
  sideSearchInput: { flex: 1, minWidth: 0, height: "100%", border: "none", outline: "none", background: "transparent", color: BRAND.linen, fontSize: 12 },
  sideList: { display: "flex", flexDirection: "column", gap: 2, marginTop: 2 },
  sideItem: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    height: 30,
    padding: "0 9px",
    borderRadius: 7,
    border: "none",
    background: "transparent",
    color: BRAND.linenMuted,
    fontSize: 12.5,
    cursor: "pointer",
    textAlign: "left",
    boxSizing: "border-box",
  },
  sideItemActive: { background: "rgba(200,118,60,0.14)", color: BRAND.ochreHover, fontWeight: 600 },
  sideItemIcon: { flex: "none", opacity: 0.85 },
  contentCol: { flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto", padding: "14px 16px 24px", boxSizing: "border-box" },
  listWrap: { width: "100%", maxWidth: 1100, display: "flex", flexDirection: "column", boxSizing: "border-box" },
  bodyFill: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" },
  list: { display: "flex", flexDirection: "column", gap: 6, width: "100%", boxSizing: "border-box" },
  row: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    width: "100%",
    textAlign: "left",
    padding: "9px 10px",
    borderRadius: 9,
    boxSizing: "border-box",
    border: `1px solid ${BRAND.border}`,
    background: BRAND.inkRaised,
    color: BRAND.linen,
    cursor: "pointer",
    transition: "background 120ms, border-color 120ms",
  },
  rowButton: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flex: 1,
    minWidth: 0,
    textAlign: "left",
    padding: 0,
    border: "none",
    background: "transparent",
    color: BRAND.linen,
    cursor: "pointer",
    font: "inherit",
  },
  dlRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "9px 10px",
    borderRadius: 9,
    border: `1px solid ${BRAND.border}`,
    background: BRAND.inkRaised,
    boxSizing: "border-box",
  },
  // —— 历史批量选择 ——
  rowSelecting: { cursor: "pointer" },
  rowSelected: { borderColor: "rgba(200,118,60,0.55)", background: "rgba(200,118,60,0.10)" },
  /** 勾选框占位：宽度/透明度过渡，进入批量模式时「平滑出现」而不是整行跳一下。 */
  checkSlot: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flex: "none",
    overflow: "hidden",
    transition: "width 140ms ease, opacity 140ms ease, margin 140ms ease",
  },
  checkbox: {
    width: 16,
    height: 16,
    flex: "none",
    borderRadius: 4,
    border: `1.5px solid ${BRAND.borderStrong}`,
    background: "transparent",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    color: BRAND.ink,
    transition: "background 120ms ease, border-color 120ms ease",
  },
  checkboxOn: { background: BRAND.ochre, borderColor: BRAND.ochre },
  /** 底部批量操作条：与列表同宽、同底色；出现时淡入上浮。 */
  selectionBar: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    width: "100%",
    marginBottom: 8,
    boxSizing: "border-box",
    padding: "9px 12px",
    borderRadius: 9,
    border: `1px solid ${BRAND.border}`,
    background: BRAND.inkRaised,
    animation: "fadeUp 160ms ease both",
  },
  selectionAll: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    border: "none",
    background: "transparent",
    color: BRAND.linen,
    fontSize: 12,
    cursor: "pointer",
    padding: 0,
  },
  selectionCount: { fontSize: 11, color: BRAND.linenFaint },
  selectionBtn: { height: 25, fontSize: 11.5, padding: "0 11px", borderRadius: 7 },
  selectionDelete: { color: "#f87171", borderColor: "rgba(248,113,113,0.45)" },
  rowIcon: { display: "inline-flex", flexShrink: 0, width: 22, justifyContent: "center", color: BRAND.ochreHover },
  rowFavicon: { borderRadius: 3, objectFit: "contain" },
  rowLetter: { width: 16, height: 16, borderRadius: 3, display: "inline-flex", alignItems: "center", justifyContent: "center", background: "rgba(255,255,255,0.06)", color: BRAND.linenMuted, fontSize: 10, fontWeight: 700 },
  rowMain: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 },
  rowTitle: { fontSize: 12.5, fontWeight: 600, color: BRAND.linen, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  rowUrl: { fontSize: 10.5, color: BRAND.linenFaint, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "ui-monospace, Consolas, monospace" },
  rowMeta: { display: "inline-flex", alignItems: "center", gap: 8, flexShrink: 0 },
  rowTime: { fontSize: 10.5, color: BRAND.linenFaint, whiteSpace: "nowrap" },
  rowActions: { display: "inline-flex", alignItems: "center", gap: 2, flexShrink: 0 },
  badge: {
    fontSize: 10,
    padding: "1px 6px",
    borderRadius: 999,
    border: `1px solid ${BRAND.border}`,
    color: BRAND.linenMuted,
    whiteSpace: "nowrap",
  },
  badgeError: {
    fontSize: 10,
    padding: "1px 6px",
    borderRadius: 999,
    border: "1px solid rgba(248,113,113,0.45)",
    color: "var(--ls-danger, #f87171)",
    whiteSpace: "nowrap",
  },
  stateBox: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    width: "100%",
    maxWidth: 1100,
    margin: "0 auto",
    padding: "72px 16px",
    color: BRAND.linenFaint,
    fontSize: 12.5,
  },
  stateError: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    width: "100%",
    maxWidth: 1100,
    margin: "0 auto",
    padding: "56px 16px",
    borderRadius: 10,
    background: "rgba(248,113,113,0.05)",
    color: "var(--ls-danger, #f87171)",
    fontSize: 12.5,
  },
  stateRetry: { height: 24, fontSize: 11, padding: "0 10px" },
};
