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
  /** 可选：顶栏「保存当前页面」（浏览器主界面的能力回填，缺省不显示）。 */
  onSavePage?: () => void;
  /** 可选：非 settings 页顶栏的「打开设置」快捷入口（缺省不显示）。 */
  onOpenSettings?: () => void;
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
  onSavePage,
  onOpenSettings,
  onNotice,
}: ChromePageProps): React.JSX.Element {
  const tr = useT();
  const [history, setHistory] = React.useState<ListState<HistoryEntry>>({ status: "loading", items: [] });
  const [downloads, setDownloads] = React.useState<ListState<DownloadItem>>({ status: "loading", items: [] });
  const [bookmarks, setBookmarks] = React.useState<ListState<BookmarkItem>>({ status: "loading", items: [] });

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

  const refreshCurrent = (): void => {
    if (kind === "history") void loadHistory();
    else if (kind === "downloads") void loadDownloads();
    else if (kind === "bookmarks") void loadBookmarks();
  };

  const count = kind === "history" ? history.items.length : kind === "downloads" ? downloads.items.length : kind === "bookmarks" ? bookmarks.items.length : -1;

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
          <div style={styles.list}>
            {history.items.map((item, index) => (
              <button
                key={`${item.url}-${index}`}
                type="button"
                style={styles.row}
                title={item.url}
                onClick={() => onNavigate(item.url)}
              >
                <span style={styles.rowIcon}><Icon name="history" size={15} /></span>
                <span style={styles.rowMain}>
                  <span style={styles.rowTitle}>{item.title || tr("chromePage.history.untitled")}</span>
                  <span style={styles.rowUrl}>{item.url}</span>
                </span>
                <span style={styles.rowMeta}>
                  {item.visitCount && item.visitCount > 1 ? <span style={styles.badge}>{tr("chromePage.history.visits", { count: item.visitCount })}</span> : null}
                  <span style={styles.rowTime} title={tr("chromePage.history.visitedAt")}>{formatTime(item.visitedAt) || tr("chromePage.unknownTime")}</span>
                </span>
              </button>
            ))}
          </div>
        );

  const downloadsContent = downloads.status === "loading" && downloads.items.length === 0
    ? <StateBox kind="loading" text={tr("chromePage.loading")} />
    : downloads.status === "error"
      ? <StateBox kind="error" text={tr("chromePage.error", { error: downloads.error ?? "unknown" })} onRetry={() => void loadDownloads()} retryLabel={tr("chromePage.retry")} />
      : downloads.items.length === 0
        ? <StateBox kind="empty" text={tr("chromePage.downloads.empty")} />
        : (
          <div style={styles.list}>
            {downloads.items.map((item) => {
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
        : (
          <div style={styles.list}>
            {bookmarks.items.map((item) => (
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
            {onSavePage ? (
              <button type="button" className="icon-btn" title={tr("chromePage.savePage")} onClick={onSavePage}>
                <Icon name="download" size={15} />
              </button>
            ) : null}
            {onOpenSettings ? (
              <button type="button" className="icon-btn" title={tr("chromePage.openSettings")} onClick={onOpenSettings}>
                <Icon name="settings" size={15} />
              </button>
            ) : null}
            <button type="button" className="icon-btn" title={tr("chromePage.refresh")} onClick={refreshCurrent}>
              <Icon name="reload" size={15} />
            </button>
            {kind === "history" ? (
              <button
                type="button"
                className="btn-ghost"
                style={styles.clearBtn}
                disabled
                title={tr("chromePage.history.clearUnavailable")}
              >
                {tr("chromePage.history.clear")}
              </button>
            ) : null}
          </span>
        ) : null}
      </header>
      <main style={kind === "settings" ? styles.bodyFill : styles.bodyScroll}>
        {kind === "settings" ? (
          <Settings fullPage api={api} onClose={onClose} />
        ) : kind === "history" ? (
          historyContent
        ) : kind === "downloads" ? (
          downloadsContent
        ) : (
          bookmarksContent
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
  clearBtn: { height: 24, fontSize: 11, padding: "0 10px", opacity: 0.5, cursor: "not-allowed" },
  bodyScroll: { flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 16px 24px" },
  bodyFill: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" },
  list: { display: "flex", flexDirection: "column", gap: 6, maxWidth: 1100 },
  row: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    width: "100%",
    textAlign: "left",
    padding: "9px 10px",
    borderRadius: 9,
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
  },
  rowIcon: { display: "inline-flex", flexShrink: 0, width: 22, justifyContent: "center", color: BRAND.ochreHover },
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
    maxWidth: 1100,
    padding: "28px 16px",
    borderRadius: 10,
    border: `1px dashed ${BRAND.borderStrong}`,
    color: BRAND.linenFaint,
    fontSize: 12,
  },
  stateError: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    maxWidth: 1100,
    padding: "28px 16px",
    borderRadius: 10,
    border: "1px solid rgba(248,113,113,0.35)",
    background: "rgba(248,113,113,0.06)",
    color: "var(--ls-danger, #f87171)",
    fontSize: 12,
  },
  stateRetry: { height: 24, fontSize: 11, padding: "0 10px" },
};
