/**
 * 浏览器顶栏的两个下拉面板（从 App 抽出，纯展示 + 回调注入）：
 *   · HistoryPanel —— 全局历史记录（所有标签/会话共享；点击交给 App 导航并收起浮层）；
 *   · DownloadsPanel —— 下载列表与操作（取消/打开/打开所在文件夹/移除记录）。
 *
 * 浮层的锚定与开合由 BrowserChrome / AnchoredPopover 负责，这里只画内容。
 * `menuStyles` 同时被 AgentSidebar 的会话菜单复用（同一套下拉视觉，避免两处漂移）。
 */
import * as React from "react";
import { BRAND } from "./theme.js";
import { Icon } from "./Icon.js";
import { useT } from "./i18n.js";
import type { DownloadItem, HistoryEntry, LoopsoarAPI } from "./types.js";

/** 下拉菜单的公共视觉（历史/下载/会话列表共用）。 */
export const menuStyles: Record<string, React.CSSProperties> = {
  dropTitle: { fontSize: 10.5, color: BRAND.linenFaint, padding: "2px 6px 6px" },
  dropEmpty: { fontSize: 11.5, color: BRAND.linenFaint, padding: "8px 6px" },
  dropItem: {
    display: "block",
    width: "100%",
    textAlign: "left",
    padding: "6px 8px",
    borderRadius: 7,
    border: "none",
    background: "transparent",
    color: BRAND.linenMuted,
    fontSize: 11.5,
    cursor: "pointer",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  dropItemActive: { background: BRAND.ochreSoft, color: BRAND.ochreHover },
};

export interface HistoryPanelProps {
  entries: HistoryEntry[];
  onSelect: (url: string) => void;
}

/** 历史记录（全局）：点击条目由 App 负责导航并收起浮层。 */
export function HistoryPanel({ entries, onSelect }: HistoryPanelProps): React.JSX.Element {
  const tr = useT();
  return (
    <div>
      <div style={menuStyles.dropTitle}>{tr("browser.historyTitle")}</div>
      {entries.length === 0 ? (
        <div style={menuStyles.dropEmpty}>{tr("browser.historyEmpty")}</div>
      ) : (
        entries.map((h) => (
          <button
            key={`${h.visitedAt ?? 0}-${h.url}`}
            type="button"
            className="model-item"
            style={{ ...menuStyles.dropItem, ...(h.current ? menuStyles.dropItemActive : {}) }}
            onClick={() => onSelect(h.url)}
            title={`${h.title ? `${h.title}
` : ""}${h.url}${h.visitCount && h.visitCount > 1 ? ` · ${tr("browser.historyVisits", { count: String(h.visitCount) })}` : ""}`}
          >
            {h.title?.trim() ? h.title : h.url}
          </button>
        ))
      )}
    </div>
  );
}

export interface DownloadsPanelProps {
  downloads: DownloadItem[];
  api: LoopsoarAPI | null;
  /** 移除记录后刷新列表（主进程已返回新列表，这里统一拉一次）。 */
  onRefresh: () => void;
}

/** 下载状态文案：文件被删除 > 异常原因 > 基础状态。 */
function downloadStatusText(item: DownloadItem, tr: (key: string, vars?: Record<string, string | number>) => string): string {
  if (item.missing) return tr("chromePage.downloads.deleted");
  if (item.reason === "cancelled") return tr("chromePage.downloads.cancelledByUser");
  if (item.reason === "permission") return tr("chromePage.downloads.permission");
  if (item.reason === "app-closed") return tr("chromePage.downloads.appClosed");
  if (item.reason === "stale") return tr("chromePage.downloads.stale");
  if (item.state === "interrupted") return tr("chromePage.downloads.failedReason");
  if (item.state === "cancelled") return tr("browser.downloadCancelled");
  return tr("browser.downloadCompleted");
}

/** 下载列表：进行中可取消，完成后可打开/定位，记录可移除。 */
export function DownloadsPanel({ downloads, api, onRefresh }: DownloadsPanelProps): React.JSX.Element {
  const tr = useT();
  return (
    <div>
      <div style={menuStyles.dropTitle}>{tr("browser.downloads")}</div>
      {downloads.length === 0 ? (
        <div style={menuStyles.dropEmpty}>{tr("browser.downloadEmpty")}</div>
      ) : (
        downloads.map((d) => (
          <div key={d.id} style={styles.dlRow}>
            <div style={styles.dlMeta}>
              <span style={d.missing ? { ...styles.dlName, textDecoration: "line-through", opacity: 0.55 } : styles.dlName} title={d.savePath}>{d.filename}</span>
              <span style={styles.dlState}>
                {d.queued
                  ? tr("browser.downloadQueued")
                  : d.state === "progressing"
                    ? `${Math.round((d.received / Math.max(1, d.total)) * 100)}%`
                    : d.state === "completed" && !d.missing
                      ? (
                        <button type="button" className="chrome-pop-open-link" onClick={() => void api?.browser.downloadAction({ id: d.id, action: "open" }).catch(() => undefined)}>
                          {tr("chromePage.downloads.openFile")}
                        </button>
                      )
                      : downloadStatusText(d, tr)}
              </span>
            </div>
            <div style={styles.dlActions}>
              {d.state === "progressing" && d.queued ? (
                <button type="button" className="icon-btn" title={tr("browser.downloadStart")} onClick={() => void api?.browser.downloadAction({ id: d.id, action: "start" }).then(() => onRefresh())}>
                  <Icon name="play" size={12} />
                </button>
              ) : null}
              {d.state === "progressing" ? (
                <button type="button" className="icon-btn" title={tr("browser.downloadCancel")} onClick={() => void api?.browser.downloadAction({ id: d.id, action: "cancel" })}>
                  <Icon name="close" size={12} />
                </button>
              ) : null}
              {d.state === "interrupted" || d.state === "cancelled" ? (
                <button type="button" className="icon-btn" title={tr("chromePage.downloads.retry")} onClick={() => void api?.browser.downloadAction({ id: d.id, action: "retry" }).then(() => onRefresh()).catch(() => undefined)}>
                  <Icon name="refresh" size={12} />
                </button>
              ) : null}
              {d.state === "completed" && !d.missing ? (
                <button type="button" className="icon-btn" title={tr("browser.downloadShowInFolder")} onClick={() => void api?.browser.downloadAction({ id: d.id, action: "showInFolder" })}>
                  <Icon name="folder" size={12} />
                </button>
              ) : null}
              <button
                type="button"
                className="icon-btn"
                title={tr("browser.downloadRemove")}
                onClick={() => void api?.browser.downloadAction({ id: d.id, action: "remove" }).then(() => onRefresh())}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  dlRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    padding: "6px 8px",
    borderBottom: `1px solid ${BRAND.border}`,
  },
  dlMeta: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
  dlName: { fontSize: 11.5, color: BRAND.linen, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 240 },
  dlState: { fontSize: 10.5, color: BRAND.linenFaint },
  dlActions: { display: "inline-flex", gap: 2, flexShrink: 0 },
};
