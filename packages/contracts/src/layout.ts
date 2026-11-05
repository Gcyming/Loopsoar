/**
 * 布局契约（单一产地）：UI 与 shell 共享同一份几何，避免「原生视图和 DOM 各算各的」错位。
 * 为什么放 contracts：WebContentsView 由主进程定位，外壳布局由渲染进程绘制；
 * 两边的数值必须来自同一处，否则窗口缩放后浏览器区必然错位。
 */
import { z } from "zod";

export const LAYOUT = {
  /**
   * 自定义标题栏高度：标签页 + 新建按钮 + 窗口控制（最小化/最大化/关闭）同一行，
   * 与 Chrome/Edge 一致；原生 frame 已隐藏。
   */
  TITLE_BAR_HEIGHT: 40,
  /** 顶部栏高度（omnibox + 操作按钮）。 */
  TOP_BAR_HEIGHT: 48,
  /**
   * 网页面板四周留白：网页不再顶到窗口边缘，而是作为独立圆角面板浮在应用底色上
   * （DOM 侧 StartPage 用同一数值做 margin，原生 WebContentsView 的 bounds 用同一数值内缩）。
   */
  BROWSER_VIEW_INSET: 8,
  /**
   * 网页面板右侧留白（比其它三边窄）：右侧紧邻会话栏，用户在视觉上希望「只隔一线」，
   * 所以右边单独收窄、其它三边保持 8px 的圆角门户留白。
   */
  BROWSER_VIEW_INSET_RIGHT: 4,
  /** 网页面板圆角（原生视图 setBorderRadius 与 DOM 页框共用，避免直角硬缝）。 */
  BROWSER_VIEW_RADIUS: 14,
  /** 右侧 Agent 面板默认宽度（可拖拽覆盖）。 */
  SIDEBAR_WIDTH: 360,
  /** 侧栏收起态宽度（只剩图标/展开按钮）。 */
  SIDEBAR_COLLAPSED_WIDTH: 48,
  /** 小窗化（浮动卡片）模式下侧栏四周留白。 */
  SIDEBAR_FLOAT_MARGIN: 8,
  /** 侧栏拖拽分隔条宽度：原生网页视图必须让出这 2px 透明热区，否则分隔条被视图盖住无法拖拽。 */
  SPLITTER_WIDTH: 2,
  /** 底部状态条高度。 */
  STATUS_BAR_HEIGHT: 32,
  /** 右侧 Agent 面板底部终端抽屉：默认/最小/最大高度。 */
  TERMINAL_PANEL_HEIGHT: 260,
  TERMINAL_PANEL_MIN_HEIGHT: 140,
  TERMINAL_PANEL_MAX_HEIGHT: 560,
} as const;

export const WindowSizeSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export type WindowSize = z.infer<typeof WindowSizeSchema>;

export interface BrowserViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 计算浏览器原生视图的包围盒（逻辑像素）：
 * 顶部让出 TITLE_BAR + TOP_BAR，右侧让出 SIDEBAR，底部让出 STATUS_BAR，
 * 四边再让出 BROWSER_VIEW_INSET 形成独立圆角网页面板；宽高不足时钳制为 0（不产生负尺寸）。
 */
export interface BrowserBoundsOptions {
  /** 右侧侧栏实际宽度（收起态 48 / 浮动卡片宽度）；缺省用 layout.SIDEBAR_WIDTH。 */
  sidebarWidth?: number;
  /** 底部被 DOM 面板（全宽终端）占用的高度；原生视图必须让出，否则被盖住。 */
  bottomInset?: number;
}

export function computeBrowserViewBounds(
  size: WindowSize,
  layout: typeof LAYOUT = LAYOUT,
  options: BrowserBoundsOptions = {},
): BrowserViewBounds {
  const sidebarWidth = Math.max(0, options.sidebarWidth ?? layout.SIDEBAR_WIDTH);
  const bottomInset = Math.max(0, Math.min(options.bottomInset ?? 0, size.height));
  // 分隔条只在「停靠且展开」时渲染：收起态（48px rail）与窗口化（侧栏让位为 0）都没有分隔条，
  // 此时再扣 SPLITTER_WIDTH 会让原生网页右侧留一条 DOM 缝（网页不铺满，用户可见）。
  // 宽度 2px：拖拽热区由 DOM 上的透明条提供，视觉上网页与会话之间只隔页框留白 + 一条细缝，
  // 不再出现用户反馈的「看似一线、实际一大段」的空白带。
  const splitterWidth =
    sidebarWidth > 0 && sidebarWidth !== layout.SIDEBAR_COLLAPSED_WIDTH ? layout.SPLITTER_WIDTH : 0;
  const inset = Math.max(0, layout.BROWSER_VIEW_INSET);
  const insetRight = Math.max(0, layout.BROWSER_VIEW_INSET_RIGHT);
  const width = Math.max(0, size.width - sidebarWidth - splitterWidth - inset - insetRight);
  const height = Math.max(
    0,
    size.height -
      layout.TITLE_BAR_HEIGHT -
      layout.TOP_BAR_HEIGHT -
      layout.STATUS_BAR_HEIGHT -
      bottomInset -
      inset * 2,
  );
  return {
    x: inset,
    y: layout.TITLE_BAR_HEIGHT + layout.TOP_BAR_HEIGHT + inset,
    width,
    height,
  };
}
