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
   * 网页面板四周留白：**已归零**。
   *
   * 历史：0.0.2 及以前网页是「浮在应用底色上的圆角面板」（8px 留白 + 14px 圆角），
   * 但用户在跳转/加载时反复看到页面四周露出应用底色（黑边/黑圈），要求彻底消除。
   * 现在网页主体仍铺满浏览器列（顶部/右侧/底部不留缝），只在左侧留 8px 呼吸位，
   * 避免网页内容顶到程序左边界；四角仍由壳层遮罩补齐圆角。常量保留是为了兼容既有调用面。
   */
  BROWSER_VIEW_INSET: 0,
  // 左侧单独留白：0 会让网页内容顶到程序左边界（用户反馈「左侧和程序边界挤在一起」）。
  // 只收左侧，不动顶部/底部/右侧，避免整块页面明显缩小。
  BROWSER_VIEW_INSET_LEFT: 8,
  /** 网页面板右侧留白（历史值 4；顶部/右侧/底部归零，仅左侧保留 8px 呼吸位）。 */
  BROWSER_VIEW_INSET_RIGHT: 0,
  /** 网页面板圆角（与窗口/面板语言一致；Windows 原生视图不裁剪内容，壳层用四角遮罩补齐）。 */
  BROWSER_VIEW_RADIUS: 12,
  /** 右侧 Agent 面板默认宽度（可拖拽覆盖）。 */
  SIDEBAR_WIDTH: 360,
  /** 侧栏宽度/透明度过渡时长（ms）：UI 动效 token 与壳层布局共用。 */
  SIDEBAR_MOTION_MS: 320,
  /**
   * 侧栏最小宽度占窗口宽度的比例（ADR-0037，用户裁决：把当前左右栏比例固定为侧栏的最小窄度）。
   * 当前布局实测：侧栏 720px / 窗口 2048px ≈ 35.2% ⇒ 取 0.35。
   * 语义：拖拽不能把侧栏压到「窗口宽度 × 该比例」以下；窗口变窄时下限按比例同步降低。
   */
  SIDEBAR_MIN_WIDTH_RATIO: 0.35,
  /** 侧栏最小宽度绝对下限（极窄窗口兜底；与偏好 schema 的 240 下限一致）。 */
  SIDEBAR_MIN_WIDTH_FLOOR: 240,
  /** 侧栏最大宽度（与偏好 schema 上限 720 一致；宽屏下比例下限由该上限截住）。 */
  SIDEBAR_MAX_WIDTH: 720,
  /**
   * 侧栏最小/最大宽度之间至少保留的可拖拽像素（用户 m05586：全屏时比例下限把宽度锁死）。
   * 超宽屏/全屏下 ratioMin 会顶到 SIDEBAR_MAX_WIDTH，导致 min === max 完全拖不动；
   * 这里强制把 min 压到 max 之下至少这么多像素。
   */
  SIDEBAR_MIN_DRAG_RANGE: 200,
  /** Vibecoding 模式侧栏最小宽度 = 标准模式最小宽度 × 该比例（用户要求约一半）。 */
  SIDEBAR_VIBE_MIN_RATIO: 0.5,
  /** Vibecoding 模式侧栏最大宽度 = 标准模式最小宽度 × 该比例（用户要求 3/5）。 */
  SIDEBAR_VIBE_MAX_RATIO: 0.6,
  /** Vibecoding 模式宽度绝对下限（极窄窗口兜底，避免会话列表无法阅读）。 */
  SIDEBAR_VIBE_MIN_WIDTH_FLOOR: 120,
  /** 浏览器列至少保留的宽度（侧栏上限不能把网页区挤没）。 */
  BROWSER_COLUMN_MIN_WIDTH: 320,
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
  /**
   * 顶部被 DOM 面板占用的高度（Agent 工作区展开列表）。
   * 与 bottomInset 同一思路：不隐藏页面，而是把原生视图整体下移，页面和面板同时可见。
   */
  topInset?: number;
}

export function computeBrowserViewBounds(
  size: WindowSize,
  layout: typeof LAYOUT = LAYOUT,
  options: BrowserBoundsOptions = {},
): BrowserViewBounds {
  const sidebarWidth = Math.max(0, options.sidebarWidth ?? layout.SIDEBAR_WIDTH);
  const bottomInset = Math.max(0, Math.min(options.bottomInset ?? 0, size.height));
  const topInset = Math.max(0, Math.min(options.topInset ?? 0, size.height));
  // 分隔条只在「停靠且展开」时渲染：收起态（48px rail）与窗口化（侧栏让位为 0）都没有分隔条，
  // 此时再扣 SPLITTER_WIDTH 会让原生网页右侧留一条 DOM 缝（网页不铺满，用户可见）。
  // 宽度 2px：拖拽热区由 DOM 上的透明条提供，视觉上网页与会话之间只隔页框留白 + 一条细缝，
  // 不再出现用户反馈的「看似一线、实际一大段」的空白带。
  const splitterWidth =
    sidebarWidth > 0 && sidebarWidth !== layout.SIDEBAR_COLLAPSED_WIDTH ? layout.SPLITTER_WIDTH : 0;
  const inset = Math.max(0, layout.BROWSER_VIEW_INSET);
  const insetLeft = Math.max(0, layout.BROWSER_VIEW_INSET_LEFT);
  const insetRight = Math.max(0, layout.BROWSER_VIEW_INSET_RIGHT);
  const width = Math.max(0, size.width - sidebarWidth - splitterWidth - insetLeft - insetRight);
  const height = Math.max(
    0,
    size.height -
      layout.TITLE_BAR_HEIGHT -
      layout.TOP_BAR_HEIGHT -
      layout.STATUS_BAR_HEIGHT -
      bottomInset -
      topInset -
      inset * 2,
  );
  return {
    x: insetLeft,
    y: layout.TITLE_BAR_HEIGHT + layout.TOP_BAR_HEIGHT + inset + topInset,
    width,
    height,
  };
}

/**
 * 视口宽度下侧栏的**最小宽度**（ADR-0037 的唯一产地，UI 拖拽夹紧与窗口 resize 夹紧共用）：
 * 「窗口宽度 × SIDEBAR_MIN_WIDTH_RATIO」作为比例下限，再夹在 [FLOOR, MAX] 之间。
 * 为什么按比例而不是写死 720：用户要求「把当前左右栏比例作为最小窄度」——
 * 窗口变窄时若仍用绝对像素下限，会把浏览器列越挤越窄；按比例下限随窗口等比收缩，视觉比例恒定。
 */
export function computeSidebarMinWidth(
  viewportWidth: number,
  layout: typeof LAYOUT = LAYOUT,
): number {
  const width = Number.isFinite(viewportWidth) ? Math.max(0, viewportWidth) : 0;
  const ratioMin = Math.round(width * layout.SIDEBAR_MIN_WIDTH_RATIO);
  const base = Math.min(layout.SIDEBAR_MAX_WIDTH, Math.max(layout.SIDEBAR_MIN_WIDTH_FLOOR, ratioMin));
  // 全屏/超宽屏：ratioMin 可能顶到 SIDEBAR_MAX_WIDTH，使 min === max（用户 m05586 反馈全屏无法调整）。
  // 保证「至少还能拖动 SIDEBAR_MIN_DRAG_RANGE 像素」，但绝不低于绝对下限。
  const maxForWindow = Math.min(layout.SIDEBAR_MAX_WIDTH, Math.max(0, width - layout.BROWSER_COLUMN_MIN_WIDTH));
  const adjustable = Math.max(layout.SIDEBAR_MIN_WIDTH_FLOOR, maxForWindow - layout.SIDEBAR_MIN_DRAG_RANGE);
  return Math.max(layout.SIDEBAR_MIN_WIDTH_FLOOR, Math.min(base, adjustable));
}

/** Vibecoding 模式的侧栏宽度区间（用户 m05586：约为标准最小宽度的一半，最大不超过 3/5）。 */
export function computeVibeSidebarBounds(
  viewportWidth: number,
  layout: typeof LAYOUT = LAYOUT,
): { min: number; max: number; normalMin: number } {
  const normalMin = computeSidebarMinWidth(viewportWidth, layout);
  const min = Math.max(
    layout.SIDEBAR_VIBE_MIN_WIDTH_FLOOR,
    Math.round(normalMin * layout.SIDEBAR_VIBE_MIN_RATIO),
  );
  const max = Math.max(min, Math.min(layout.SIDEBAR_MAX_WIDTH, Math.round(normalMin * layout.SIDEBAR_VIBE_MAX_RATIO)));
  return { min, max, normalMin };
}

/**
 * 视口宽度下侧栏的**最大宽度**：同时受绝对上限与「浏览器列至少 BROWSER_COLUMN_MIN_WIDTH」约束，
 * 且永远不小于 min（避免极窄窗口出现 min > max 导致夹取结果为负区间）。
 */
export function computeSidebarMaxWidth(
  viewportWidth: number,
  layout: typeof LAYOUT = LAYOUT,
): number {
  const width = Number.isFinite(viewportWidth) ? Math.max(0, viewportWidth) : 0;
  const capped = Math.min(
    layout.SIDEBAR_MAX_WIDTH,
    Math.max(0, width - layout.BROWSER_COLUMN_MIN_WIDTH),
  );
  return Math.max(computeSidebarMinWidth(width, layout), capped);
}
