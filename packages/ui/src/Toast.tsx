/**
 * 全局提示 Toast（从 App 抽出）：成功/失败/中断提示，点击关闭。
 *
 * 自动消失节奏（成功 4.5s、失败/中断 8s）由 App 的 notice effect 控制，本组件只负责展示。
 */
import * as React from "react";
import { BRAND } from "./theme.js";
import { Icon } from "./Icon.js";
import { useT } from "./i18n.js";

export interface ToastProps {
  text: string;
  onDismiss: () => void;
}

export default function Toast({ text, onDismiss }: ToastProps): React.JSX.Element {
  const tr = useT();
  return (
    <button type="button" className="toast" style={styles.toast} onClick={onDismiss} title={tr("common.dismiss")}>
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
    padding: "14px 30px",
    border: "none",
    // 无底板：中心最实、向四周均匀渐隐（与壳层 toast 窗口同一套渲染样式）。
    borderRadius: 999,
    background: "rgba(12,14,20,0.93)",
    maskImage: "radial-gradient(ellipse 100% 190% at 50% 50%, #000 58%, rgba(0,0,0,0) 100%)",
    WebkitMaskImage: "radial-gradient(ellipse 100% 190% at 50% 50%, #000 58%, rgba(0,0,0,0) 100%)",
    color: BRAND.linen,
    fontSize: 12.5,
    cursor: "pointer",
    boxShadow: "none",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
};
