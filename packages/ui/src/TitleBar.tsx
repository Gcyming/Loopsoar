/**
 * 自定义标题栏：最顶行。
 * 纯展示组件，只通过 preload 暴露的 window API 操作窗口。
 *
 * 两种形态：
 * - main（默认）：Chrome/Edge 式——左侧标签页插槽（`tabs`，由 App 传入 BrowserTabs），
 *   中间空白拖动区（双击最大化），右侧最小化/最大化/关闭。标签与窗口按钮同列。
 * - agent：Agent 独立窗口（无系统边框），左侧品牌 +「Agent 对话」+ 右侧最小化/关闭。
 */
import * as React from "react";
import { LAYOUT } from "loopsoar-contracts/layout";
import { BRAND, DRAG_REGION, NO_DRAG_REGION } from "./theme.js";
import { Icon } from "./Icon.js";
import { useLoopsoarApi } from "./useLoopsoarApi.js";
import { dismissAllPopovers } from "./popover.js";
import { useT } from "./i18n.js";

export interface TitleBarProps {
  maximized: boolean;
  /** 窗口形态：main = 主窗口；agent = Agent 独立窗口（无系统边框，仅最小化/关闭）。 */
  variant?: "main" | "agent";
  /** main 形态的标签页插槽（与窗口按钮同一行）；agent 形态忽略。 */
  tabs?: React.ReactNode;
}

export default function TitleBar({ maximized, variant = "main", tabs }: TitleBarProps): React.ReactElement {
  const api = useLoopsoarApi();
  const tr = useT();
  const isAgent = variant === "agent";
  // i18n key 由 Lead 统一补齐；暂缺时回退中文，避免把 key 直接显示给用户。
  const rawAgentTitle = tr("agentWindow.title");
  const agentTitle = rawAgentTitle === "agentWindow.title" ? "Agent 对话" : rawAgentTitle;

  return (
    <div style={{ ...styles.titleBar, ...(isAgent ? styles.titleBarAgent : styles.titleBarMain) }}>
      {isAgent ? (
        <div
          style={{ ...styles.titleDrag, ...DRAG_REGION }}
          onDoubleClick={undefined}
        >
          <img src="./logo.png" alt="" width={18} height={18} style={styles.titleLogo} />
          <span style={styles.titleText}>{agentTitle}</span>
        </div>
      ) : (
        <>
          {/* 标签页与窗口按钮同列：整条标签区 no-drag，空白区才是拖动区 */}
          <div style={styles.tabsSlot}>{tabs}</div>
          <div
            style={{ ...styles.dragFiller, ...DRAG_REGION }}
            onDoubleClick={() => void api?.window.maximize()}
            aria-hidden
          />
        </>
      )}
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
          onClick={() => {
            // 关窗前先收起所有展开列表/浮层：避免关闭流程里残留浮层窗口/监听；
            // 也保证「点多次关闭没反应」时每次都先把 UI 状态清干净（用户 m02115）。
            dismissAllPopovers();
            if (isAgent) {
              void api?.ui.closeAgentWindow();
            } else if (api) {
              void api.window.close();
            } else {
              // preload 未注入（极端降级环境）时退回浏览器标准关闭，避免按钮完全失效。
              window.close();
            }
          }}
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
    alignItems: "stretch",
    height: LAYOUT.TITLE_BAR_HEIGHT,
    background: BRAND.ink,
    flexShrink: 0,
    userSelect: "none",
  },
  /** 主窗口：标签条与工具条连成一片，不留横向硬线。 */
  titleBarMain: { borderBottom: "none" },
  /** Agent 小窗：标题栏与下方会话区需要一层极轻分隔（软主题下 border 已透明）。 */
  titleBarAgent: { borderBottom: `1px solid ${BRAND.border}` },
  tabsSlot: { display: "flex", alignItems: "stretch", minWidth: 0, maxWidth: "72%", overflow: "hidden" },
  titleDrag: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flex: 1,
    height: "100%",
    paddingLeft: 12,
    minWidth: 0,
  },
  /** 主窗口的空白拖动区：只承担拖动/双击最大化，不画任何东西（标签右侧起）。 */
  dragFiller: { flex: 1, height: "100%", minWidth: 24 },
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
