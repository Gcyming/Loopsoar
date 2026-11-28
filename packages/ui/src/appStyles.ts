/** App 外壳样式：仅顶层布局；拆分后 App.tsx 保留行为，样式独立演进。 */
import React from "react";
import { LAYOUT } from "loopsoar-contracts/layout";
import { BRAND } from "./theme.js";

export const styles: Record<string, React.CSSProperties> = {
  app: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    margin: 0,
    background: BRAND.ink,
    color: BRAND.linen,
    fontFamily: "system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif",
    boxSizing: "border-box",
    overflow: "hidden",
  },
  // 独立小窗：透明窗口只负责「桌面留白」，可见面全部由面板裁切（圆角/悬浮都由面板决定）。
  agentShellMini: {
    position: "relative",
    width: "100%",
    height: "100vh",
    margin: 0,
    background: "transparent",
    overflow: "hidden",
  },
  // 小窗面板：Slime float 的盒模型（圆角 + overflow:hidden），左侧/顶部/宽高由过渡状态驱动。
  agentPanel: {
    position: "absolute",
    boxSizing: "border-box",
    overflow: "hidden",
    background: BRAND.ink,
    color: BRAND.linen,
    borderRadius: 14,
  },
  // 面板上的图标层：固定 56px logo（不随面板缩放），淡入淡出，图标态可拖动/点击还原。
  agentFloatIcon: {
    position: "absolute",
    inset: 0,
    zIndex: 2,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    userSelect: "none",
    touchAction: "none",
  },
  // chrome 外壳：工具条、splitter、会话栏共用同一块抬高的面（BRAND.inkRaised），
  // 页框四边内缩成「深色门户」；中间那一点缝（splitter + 会话栏左侧留白）因此被填满，
  // 顶部网址栏与会话栏连成一体，再用页框圆角形成闭合外框。
  workRow: {
    display: "flex",
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
    background: BRAND.inkRaised,
  },
  // 网页列：导航工具条（第二行）只覆盖这一列；页框在 StartPage 里内缩成圆角面板。
  pageColumn: { display: "flex", flexDirection: "column", flex: 1, minWidth: 0, overflow: "hidden" },
  /** 隐藏原生网页视图期间显示的静态底图：只占网页面板几何，不拦截交互。 */
  browserFreeze: {
    position: "absolute",
    left: LAYOUT.BROWSER_VIEW_INSET_LEFT,
    right: LAYOUT.BROWSER_VIEW_INSET_RIGHT,
    top: LAYOUT.TOP_BAR_HEIGHT + LAYOUT.BROWSER_VIEW_INSET,
    bottom: LAYOUT.BROWSER_VIEW_INSET,
    zIndex: 1,
    overflow: "hidden",
    borderRadius: LAYOUT.BROWSER_VIEW_RADIUS,
    background: BRAND.ink,
    pointerEvents: "none",
  },
  browserFreezeImage: { display: "block", width: "100%", height: "100%", objectFit: "cover" },
  splitter: {
    // 净占位仍是 2px，但命中区向左多覆盖 4px，正好盖住页框右侧留白 —— 鼠标停在
    // 「网页深色面板 ↔ 抬高外壳」的视觉交界处就能拖拽（用户 m04830：之前命中区在交界右侧 4px）。
    width: LAYOUT.SPLITTER_WIDTH + 4,
    marginLeft: -4,
    flexShrink: 0,
    cursor: "col-resize",
    // 不画分隔线：网页区与会话区之间只靠「页框内缩 + 2px 热区」形成一道细缝。
    background: "transparent",
    transition: "background 120ms",
  },
};
