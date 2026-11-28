/**
 * 标题栏最左侧 · 工作区下拉（Loopsoar 左上角、标签页之前）。
 *
 * 用户 m09567：入口应在顶部导航栏、标签页最左侧；m09840：只留箭头；m09866：与标签页齐高（30px）、
 * 圆角方块、箭头更大；m09937：只要高光、不加边框，且再次点击必须能收起；
 * m10071：展开时**不能把网页藏掉**，也不要带阴影。
 *
 * 菜单为什么要独立浮层窗口：主窗口 DOM 永远在原生 WebContentsView 之下，DOM 菜单会被网页盖住；
 * 直接隐藏网页又会让内容消失（用户否掉）。因此复用工具栏浮层子窗口（PopoverApp 的 workspaces 类型）：
 * 菜单天然浮在网页之上，网页保持显示；动作经 ui:popoverAction 回传主窗口执行。
 *
 * 再次点击能收起：主进程对「点回主窗口导致的 blur」不立即关浮层（见 chromePopover.ts），
 * 由 click 的 togglePopover 原子关闭；点其它位置由 hover 轮询关闭。
 */
import * as React from "react";
import { BRAND } from "./theme.js";
import { Icon } from "./Icon.js";
import { getLanguage, useT } from "./i18n.js";
import { useLoopsoarApi } from "./useLoopsoarApi.js";
import type { WorkspaceRecord } from "./types.js";

/** 必须与主进程 DEFAULT_POPOVER_SIZES.workspaces 的宽度一致（左对齐锚点计算依赖它）。 */
const WORKSPACE_POPOVER_WIDTH = 296;

export interface WorkspaceSwitcherProps {
  workspaces: WorkspaceRecord[];
  activeWorkspaceId: string | null;
}

const S: Record<string, React.CSSProperties> = {
  trigger: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 30,
    height: 30,
    marginTop: 10,
    marginLeft: 6,
    flexShrink: 0,
    padding: 0,
    border: "none",
    borderRadius: 8,
    background: "transparent",
    color: BRAND.linenMuted,
    cursor: "pointer",
    transition: "background 120ms ease, color 120ms ease",
  },
  // 高光即可，不再给按钮加一圈边框（用户 m09937）
  triggerOpen: { background: "rgba(200,118,60,0.18)", color: BRAND.ochreHover },
};

export default function WorkspaceSwitcher({
  workspaces,
  activeWorkspaceId,
}: WorkspaceSwitcherProps): React.ReactElement {
  const api = useLoopsoarApi();
  const tr = useT();
  const [open, setOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);

  // 浮层由主进程管理：外部点击/Esc 关闭后会推 chrome:popoverClosed，渲染层据此复位高光态。
  React.useEffect(() => {
    if (!api?.on) return;
    return api.on("chrome:popoverClosed", () => setOpen(false));
  }, [api]);

  const activeName =
    workspaces.find((item) => item.id === activeWorkspaceId)?.name ?? tr("browser.workspaceNone");
  const title = tr("browser.workspaceCurrent", { name: activeName });

  const toggle = (): void => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect || !api) return;
    // 虚拟锚点：宽度取浮层宽度，使主进程「右对齐」计算后的左边缘正好落在按钮左边；
    // y 取按钮顶部，浮层出现在按钮正下方。
    const anchor = {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: WORKSPACE_POPOVER_WIDTH,
      height: Math.round(rect.height),
    };
    void api.ui
      .togglePopover({ kind: "workspaces", anchor, lang: getLanguage() })
      .then((result) => setOpen(Boolean(result?.open)))
      .catch(() => undefined);
  };

  return (
    <button
      ref={triggerRef}
      type="button"
      className="icon-btn"
      style={{ ...S.trigger, ...(open ? S.triggerOpen : {}) }}
      title={title}
      aria-label={tr("browser.workspaceMenuAria")}
      aria-haspopup="menu"
      aria-expanded={open}
      data-chrome-popover-trigger
      data-testid="browser-workspace-toggle"
      onClick={toggle}
    >
      <Icon name="chevron-down" size={18} />
    </button>
  );
}
