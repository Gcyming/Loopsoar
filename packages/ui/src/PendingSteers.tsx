/**
 * 待发指令卡片（slime ChatPanel 待发卡的 Loopsoar 精简移植）。
 *
 * 视觉对照 slime：左条 + 徽标 + 图标操作
 *   · 待发（queue）  = 虚线左条 + 「待发」徽标 + 三个图标：
 *       edit.svg        修改（取回输入框，并撤销主进程缓冲）
 *       guide-arrow.svg 引导（立即投递进当前这一轮；A-1151 用户指定的「引导」图标）
 *       close.svg       撤销删除（撤销主进程缓冲并移出队列）
 *   · 已投递（delivered） = 实线强调左条 + 「已注入」徽标 + 「已作为引导注入当前这轮」状态行，
 *     不出现箭头（已经进去了）；保留 修改 / 撤销删除。
 * 只在会话栏（AgentSidebar）里、Composer 上方渲染。
 */
import * as React from "react";
import { BRAND, RADIUS } from "./theme.js";
import { Icon } from "./Icon.js";
import { useT } from "./i18n.js";
import type { PendingSteer } from "./steerQueue.js";

export interface PendingSteersProps {
  items: PendingSteer[];
  onEdit: (id: string) => void;
  onInsertNow: (id: string) => void;
  onRemove: (id: string) => void;
}

export default function PendingSteers({ items, onEdit, onInsertNow, onRemove }: PendingSteersProps): React.JSX.Element | null {
  const tr = useT();
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  if (items.length === 0) return null;

  return (
    <div style={styles.wrap} role="list" aria-label={tr("pendingSteers.title")}>
      {items.map((item) => {
        const open = expanded[item.id] ?? item.text.length <= 40;
        const delivered = item.status === "delivered";
        const failed = item.status === "failed";
        const statusText = delivered
          ? tr("pendingSteers.deliveredHint")
          : failed
            ? tr("pendingSteers.failedNotice").replace("{reason}", item.error ?? "")
            : tr("pendingSteers.queuedHint");
        return (
          <div
            key={item.id}
            style={{ ...styles.card, ...(delivered ? styles.cardDelivered : failed ? styles.cardFailed : styles.cardQueued) }}
            role="listitem"
          >
            <div style={styles.head}>
              <span style={{ ...styles.badge, ...(delivered ? styles.badgeDelivered : failed ? styles.badgeFailed : null) }}>
                {delivered ? tr("pendingSteers.delivered") : tr("pendingSteers.badge")}
              </span>
              <span style={styles.statusText} title={statusText}>{statusText}</span>
            </div>
            <button
              type="button"
              className="pending-steer-text"
              style={styles.textBtn}
              title={open ? tr("pendingSteers.collapse") : tr("pendingSteers.expand")}
              onClick={() => setExpanded((prev) => ({ ...prev, [item.id]: !open }))}
            >
              {open ? (
                <span style={styles.fullText}>{item.text}</span>
              ) : (
                <span style={styles.preview}>{item.text.replace(/\s+/g, " ").trim()}</span>
              )}
            </button>
            <div style={styles.actions}>
              <button type="button" className="icon-btn" title={tr("pendingSteers.edit")} aria-label={tr("pendingSteers.edit")} onClick={() => onEdit(item.id)}>
                <Icon name="edit" size={11} />
              </button>
              {delivered ? null : (
                <button
                  type="button"
                  className="icon-btn"
                  title={tr("pendingSteers.insertNow")}
                  aria-label={tr("pendingSteers.insertNow")}
                  onClick={() => onInsertNow(item.id)}
                >
                  <Icon name="guide-arrow" size={11} />
                </button>
              )}
              <button type="button" className="icon-btn" title={tr("pendingSteers.remove")} aria-label={tr("pendingSteers.remove")} onClick={() => onRemove(item.id)}>
                <Icon name="close" size={11} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: "8px 12px 0",
    flexShrink: 0,
  },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: 3,
    padding: "7px 9px 7px 11px",
    borderRadius: RADIUS.md,
    minWidth: 0,
  },
  cardQueued: {
    border: `1px solid ${BRAND.border}`,
    borderLeft: `2px dashed ${BRAND.ochre}`,
    background: BRAND.ochreSoft,
  },
  cardDelivered: {
    border: `1px solid ${BRAND.border}`,
    borderLeft: `2px solid ${BRAND.ochre}`,
    background: BRAND.inkRaised,
  },
  cardFailed: {
    border: `1px solid ${BRAND.border}`,
    borderLeft: `2px solid ${BRAND.danger}`,
    background: BRAND.dangerSoft,
  },
  head: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    minWidth: 0,
  },
  badge: {
    flexShrink: 0,
    fontSize: 10,
    fontWeight: 600,
    padding: "1px 6px",
    borderRadius: RADIUS.pill,
    background: BRAND.ochre,
    color: "#1a140f",
    lineHeight: 1.5,
  },
  badgeDelivered: {
    background: BRAND.teal,
    color: "#0d1a17",
  },
  badgeFailed: {
    background: BRAND.danger,
    color: "#fff",
  },
  statusText: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: 10,
    color: BRAND.linenMuted,
  },
  textBtn: {
    flex: 1,
    minWidth: 0,
    border: "none",
    background: "transparent",
    padding: 0,
    margin: 0,
    textAlign: "left",
    cursor: "pointer",
    color: BRAND.linen,
    fontSize: 12,
    lineHeight: 1.5,
  },
  preview: {
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  fullText: {
    display: "block",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: 2,
    alignSelf: "flex-end",
    flexShrink: 0,
    marginTop: 1,
  },
};
