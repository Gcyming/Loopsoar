/**
 * 自定义标题栏：品牌标识 + 窗口控制（最小化/最大化/关闭）。
 * 纯展示组件，只通过 preload 暴露的 window API 操作窗口。
 *
 * 两种形态：
 * - main（默认）：主窗口，保留最大化/还原按钮，双击拖拽区最大化。
 * - agent：Agent 独立窗口（无系统边框），仅保留最小化/关闭，不提供最大化。
 */
import * as React from "react";
import { LAYOUT } from "loopsoar-contracts/layout";
import { BRAND, DRAG_REGION, NO_DRAG_REGION } from "./theme.js";
import { Icon } from "./Icon.js";
import { useLoopsoarApi } from "./useLoopsoarApi.js";
import { useT } from "./i18n.js";

export interface TitleBarProps {
  maximized: boolean;
  /** 窗口形态：main = 主窗口；agent = Agent 独立窗口（无系统边框，仅最小化/关闭）。 */
  variant?: "main" | "agent";
}

export default function TitleBar({ maximized, variant = "main" }: TitleBarProps): React.ReactElement {
  const api = useLoopsoarApi();
  const tr = useT();
  const isAgent = variant === "agent";
  // i18n key 由 Lead 统一补齐；暂缺时回退中文，避免把 key 直接显示给用户。
  const rawAgentTitle = tr("agentWindow.title");
  const agentTitle = rawAgentTitle === "agentWindow.title" ? "Agent 对话" : rawAgentTitle;

  return (
    <div style={styles.titleBar}>
      <div
        style={{ ...styles.titleDrag, ...DRAG_REGION }}
        onDoubleClick={isAgent ? undefined : () => void api?.window.maximize()}
      >
        <img src="./logo.png" alt="" width={18} height={18} style={styles.titleLogo} />
        <span style={styles.titleText}>{isAgent ? agentTitle : "Loopsoar"}</span>
      </div>
      <div style={{ ...styles.windowControls, ...NO_DRAG_REGION }}>
        <button
          type="button"
          aria-label={tr("titlebar.minimize")}
          title={tr("titlebar.minimize")}
          className="win-btn"
          style={styles.windowButton}
          onClick={() => void (isAgent ? api?.ui.minimizeAgentWindow() : api?.window.minimize())}
        >
          <Icon name="minimize" size={12} />
        </button>
        {isAgent ? null : (
          <button
            type="button"
            aria-label={maximized ? tr("titlebar.restore") : tr("titlebar.maximize")}
            title={maximized ? tr("titlebar.restore") : tr("titlebar.maximize")}
            className="win-btn"
            style={styles.windowButton}
            onClick={() => void api?.window.maximize()}
          >
            <Icon name={maximized ? "restore" : "maximize"} size={12} />
          </button>
        )}
        <button
          type="button"
          aria-label={tr("titlebar.close")}
          title={tr("titlebar.close")}
          className="win-btn win-close"
          style={styles.windowButton}
          onClick={() => void (isAgent ? api?.ui.closeAgentWindow() : api?.window.close())}
        >
          <Icon name="close" size={12} />
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  titleBar: {
    display: "flex",
    alignItems: "center",
    height: LAYOUT.TITLE_BAR_HEIGHT,
    background: BRAND.ink,
    borderBottom: `1px solid ${BRAND.border}`,
    flexShrink: 0,
    userSelect: "none",
  },
  titleDrag: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flex: 1,
    height: "100%",
    paddingLeft: 12,
    minWidth: 0,
  },
  titleLogo: { borderRadius: 4, display: "block" },
  titleText: { fontSize: 12, fontWeight: 600, letterSpacing: 0.6, color: BRAND.linenMuted },
  windowControls: { display: "flex", alignItems: "stretch", height: "100%", flexShrink: 0 },
  // 注意：这里不能写内联 background / color —— 内联样式优先级高于 index.html 的
  // `.win-btn` / `.win-btn:hover` 规则，会让窗口按钮失去 hover 反馈；
  // 底色与文字色完全交给 .win-btn 类（深色标题栏上也有正确对比度）。
  windowButton: {
    width: 46,
    height: "100%",
    border: "none",
    fontSize: 12,
    lineHeight: 1,
    cursor: "pointer",
    display: "grid",
    placeItems: "center",
  },
};
