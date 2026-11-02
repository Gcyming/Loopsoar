/**
 * 全局提示 Toast（从 App 抽出）：成功/失败/中断提示，点击关闭。
 *
 * 自动消失节奏（成功 4.5s、失败/中断 8s）由 App 的 notice effect 控制，本组件只负责展示。
 */
import * as React from "react";
import { BRAND } from "./theme.js";
import { Icon } from "./Icon.js";

export interface ToastProps {
  text: string;
  onDismiss: () => void;
}

export default function Toast({ text, onDismiss }: ToastProps): React.JSX.Element {
  return (
    <button type="button" className="toast" style={styles.toast} onClick={onDismiss} title="点击关闭">
      <Icon name="bolt" size={13} style={{ marginRight: 6, verticalAlign: "-2px" }} />
      {text.slice(0, 260)}
      {text.length > 260 ? "…" : ""}
    </button>
  );
}

const styles: Record<string, React.CSSProperties> = {
  toast: {
    position: "absolute",
    left: "50%",
    bottom: 46,
    transform: "translateX(-50%)",
    display: "inline-flex",
    alignItems: "center",
    maxWidth: "70%",
    padding: "7px 14px",
    borderRadius: 8,
    border: `1px solid ${BRAND.borderStrong}`,
    background: BRAND.inkRaised,
    color: BRAND.linen,
    fontSize: 12,
    cursor: "pointer",
    boxShadow: "0 6px 20px rgba(0,0,0,0.45)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
};
