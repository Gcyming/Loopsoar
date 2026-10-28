/**
 * 布局契约（单一产地）：UI 与 shell 共享同一份几何，避免「原生视图和 DOM 各算各的」错位。
 * 为什么放 contracts：WebContentsView 由主进程定位，外壳布局由渲染进程绘制；
 * 两边的数值必须来自同一处，否则窗口缩放后浏览器区必然错位。
 */
import { z } from "zod";

export const LAYOUT = {
  /** 自定义标题栏高度（品牌 + 窗口控制；原生 frame 已隐藏）。 */
  TITLE_BAR_HEIGHT: 36,
  /** 标签栏高度（多标签页；原生视图需让出该高度）。 */
  TAB_BAR_HEIGHT: 34,
  /** 顶部栏高度（omnibox + 操作按钮）。 */
  TOP_BAR_HEIGHT: 48,
  /** 右侧 Agent 面板宽度。 */
  SIDEBAR_WIDTH: 320,
  /** 底部状态条高度。 */
  STATUS_BAR_HEIGHT: 32,
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
 * 顶部让出 TOP_BAR，右侧让出 SIDEBAR，底部让出 STATUS_BAR；宽高不足时钳制为 0（不产生负尺寸）。
 */
export function computeBrowserViewBounds(
  size: WindowSize,
  layout: typeof LAYOUT = LAYOUT,
): BrowserViewBounds {
  const width = Math.max(0, size.width - layout.SIDEBAR_WIDTH);
  const height = Math.max(
    0,
    size.height -
      layout.TITLE_BAR_HEIGHT -
      layout.TAB_BAR_HEIGHT -
      layout.TOP_BAR_HEIGHT -
      layout.STATUS_BAR_HEIGHT,
  );
  return { x: 0, y: layout.TITLE_BAR_HEIGHT + layout.TOP_BAR_HEIGHT + layout.TAB_BAR_HEIGHT, width, height };
}
