/**
 * 浏览器顶栏的两个下拉面板（从 App 抽出，纯展示 + 回调注入）：
 *   · HistoryPanel —— 当前标签的历史记录（点击交给 App 导航并收起浮层）；
 *   · DownloadsPanel —— 下载列表与操作（取消/打开/打开所在文件夹/移除记录）。
 *
 * 浮层的锚定与开合由 BrowserChrome / AnchoredPopover 负责，这里只画内容。
 * `menuStyles` 同时被 AgentSidebar 的会话菜单复用（同一套下拉视觉，避免两处漂移）。
 */
import * as React from "react";
import { BRAND } from "./theme.js";
import { Icon } from "./Icon.js";
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

/** 历史记录（本标签）：点击条目由 App 负责导航并收起浮层。 */
export function HistoryPanel({ entries, onSelect }: HistoryPanelProps): React.JSX.Element {
  return (
    <div>
      <div style={menuStyles.dropTitle}>历史记录（本标签）</div>
      {entries.length === 0 ? (
        <div style={menuStyles.dropEmpty}>暂无历史</div>
      ) : (
        entries.map((h) => (
          <button
            key={`${h.index}-${h.url}`}
            type="button"
            className="model-item"
            style={{ ...menuStyles.dropItem, ...(h.current ? menuStyles.dropItemActive : {}) }}
            onClick={() => onSelect(h.url)}
            title={h.url}
          >
            {h.url}
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

/** 下载列表：进行中可取消，完成后可打开/定位，记录可移除。 */
export function DownloadsPanel({ downloads, api, onRefresh }: DownloadsPanelProps): React.JSX.Element {
  return (
    <div>
      <div style={menuStyles.dropTitle}>下载</div>
      {downloads.length === 0 ? (
        <div style={menuStyles.dropEmpty}>暂无下载</div>
      ) : (
        downloads.map((d) => (
          <div key={d.id} style={styles.dlRow}>
            <div style={styles.dlMeta}>
              <span style={styles.dlName} title={d.savePath}>{d.filename}</span>
              <span style={styles.dlState}>
                {d.state === "completed"
                  ? "已完成"
                  : d.state === "progressing"
                    ? `${Math.round((d.received / Math.max(1, d.total)) * 100)}%`
                    : d.state === "cancelled"
                      ? "已取消"
                      : "失败"}
              </span>
            </div>
            <div style={styles.dlActions}>
              {d.state === "progressing" ? (
                <button type="button" className="icon-btn" title="取消" onClick={() => void api?.browser.downloadAction({ id: d.id, action: "cancel" })}>
                  <Icon name="close" size={12} />
                </button>
              ) : null}
              {d.state === "completed" ? (
                <button type="button" className="icon-btn" title="打开" onClick={() => void api?.browser.downloadAction({ id: d.id, action: "open" })}>
                  <Icon name="arrow-go" size={12} />
                </button>
              ) : null}
              <button type="button" className="icon-btn" title="打开所在文件夹" onClick={() => void api?.browser.downloadAction({ id: d.id, action: "showInFolder" })}>
                <Icon name="folder" size={12} />
              </button>
              <button
                type="button"
                className="icon-btn"
                title="移除记录"
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
