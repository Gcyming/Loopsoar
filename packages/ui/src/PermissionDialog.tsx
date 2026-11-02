/**
 * 工具权限确认弹窗（从 App 抽出）：Agent 触发 confirm 类工具时置顶询问。
 *
 * 纯展示：请求对象与回填回调全部由 App 持有（perm:request 事件 → App；respondPermission → perm:respond）。
 */
import * as React from "react";
import { BRAND } from "./theme.js";
import { Icon } from "./Icon.js";
import { useT } from "./i18n.js";

export type PermissionChoice = "allow-once" | "allow-session" | "deny";

export interface PermissionDialogProps {
  request: { toolName: string; target?: string; reason?: string; category?: string };
  onRespond: (choice: PermissionChoice) => void;
}

export default function PermissionDialog({ request, onRespond }: PermissionDialogProps): React.JSX.Element {
  const tr = useT();
  return (
    <div style={styles.permOverlay}>
      <div style={styles.permCard}>
        <div style={styles.permTitle}>{tr("permission.title")}</div>
        <div style={styles.permTool}>
          <Icon name="bolt" size={14} style={{ marginRight: 6, color: BRAND.ochreHover }} />
          {request.toolName}
          {request.target ? <span style={styles.permTarget}> → {request.target}</span> : null}
        </div>
        {request.reason ? (
          <div style={styles.permSensitive}>{tr("permission.sensitiveReason", { reason: request.reason })}</div>
        ) : null}
        <div style={styles.permHint}>{tr("permission.hint")}</div>
        <div style={styles.permBtns}>
          <button type="button" className="btn-ghost" style={styles.ghostButton} onClick={() => onRespond("deny")}>
            {tr("permission.deny")}
          </button>
          <button type="button" className="btn-ghost" style={styles.ghostButton} onClick={() => onRespond("allow-session")}>
            {tr("permission.allowSession")}
          </button>
          <button type="button" className="btn-primary" style={styles.primaryButton} onClick={() => onRespond("allow-once")}>
            {tr("permission.allowOnce")}
          </button>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  permOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(8,9,12,0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 60,
  },
  permCard: {
    width: 420,
    borderRadius: 12,
    border: `1px solid ${BRAND.borderStrong}`,
    background: BRAND.inkRaised,
    padding: 16,
    boxShadow: "0 24px 60px rgba(0,0,0,0.55)",
  },
  permTitle: { fontSize: 13, fontWeight: 700, marginBottom: 10 },
  permTool: { display: "flex", alignItems: "center", fontSize: 13, color: BRAND.linen },
  permTarget: { color: BRAND.linenMuted, fontSize: 11.5, marginLeft: 4, wordBreak: "break-all" },
  // 敏感步骤原因（登录/支付/不可撤销）：比普通提示更显眼，避免用户顺手批准
  permSensitive: {
    marginTop: 8,
    padding: "6px 8px",
    borderRadius: 6,
    border: `1px solid rgba(var(--ls-accent-rgb, 200, 118, 60), 0.33)`,
    background: `rgba(var(--ls-accent-rgb, 200, 118, 60), 0.08)`,
    color: BRAND.ochreHover,
    fontSize: 12,
    lineHeight: 1.5,
  },
  permHint: { marginTop: 8, fontSize: 11, color: BRAND.linenFaint, lineHeight: 1.6 },
  permBtns: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 },
  ghostButton: {
    height: 28,
    padding: "0 11px",
    borderRadius: 7,
    border: `1px solid ${BRAND.borderStrong}`,
    background: "transparent",
    color: BRAND.linenMuted,
    fontSize: 12.5,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
  },
  primaryButton: {
    height: 28,
    padding: "0 12px",
    borderRadius: 7,
    border: "none",
    background: BRAND.ochre,
    color: BRAND.ink,
    fontWeight: 700,
    fontSize: 12.5,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
  },
};
