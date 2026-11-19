/**
 * 浮层定位纯函数：把「锚点 + 期望尺寸 + 视口」换算成 `position: fixed` 的 top/left。
 *
 * 为什么必须集中成纯函数：
 *   · 自绘菜单散落在 Composer/侧栏/顶栏，各处各自算 `top: 100%` 或 `absolute`，
 *     靠近窗口边缘必然被裁切（用户反馈的“边缘部分被截断”就是同一类 bug）；
 *   · 定位只依赖几何数据，与 React/DOM 无关 → 可以用四角/翻转/夹取矩阵直接单测，
 *     不依赖 jsdom/真实浏览器。
 *
 * 规则（自上而下，越靠前优先级越高）：
 *   1. 垂直方向优先使用调用方期望的一侧（默认下方）；放不下则翻到另一侧；
 *   2. 两侧都放不下 → 取空间更大的一侧，并用 maxHeight 把高度限制在该侧可用空间内；
 *   3. 水平方向按 start（左对齐锚点）/ end（右对齐锚点）尝试，放不下就换另一侧，
 *      都不行则 clamp 到视口内；宽度超过视口时用 maxWidth 收紧；
 *   4. 最终 top/left 再做一次安全夹取 —— 保证返回的四条边**永远**不越出
 *      `[margin, viewport - margin]` 范围（视口极小时按半屏收紧 margin）。
 */

export type PopoverPlacement = "bottom-start" | "bottom-end" | "top-start" | "top-end";

/** 锚点矩形（通常来自 getBoundingClientRect）。 */
export interface PopoverAnchorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlacePopoverInput {
  anchor: PopoverAnchorRect;
  /** 期望尺寸（自然内容尺寸；宽度会按视口收紧）。 */
  size: { width: number; height: number };
  /** 视口尺寸（window.innerWidth/innerHeight 或 visualViewport）。 */
  viewport: { width: number; height: number };
  /** 期望方位（默认 bottom-start）；空间不足时会自动翻转/换对齐端。 */
  placement?: PopoverPlacement;
  /** 浮层与锚点的间距（默认 8）。 */
  gap?: number;
  /** 视口内边距（默认 8）。 */
  margin?: number;
  /**
   * 不应遮挡的矩形（原生网页区域）。浮层若与它相交且旁边有空间，
   * 会整体平移到该矩形的左侧或右侧，避免为了 12px 交集把整页冻结成静态底图。
   */
  avoid?: PopoverAnchorRect | null;
}

export interface PopoverPosition {
  top: number;
  left: number;
  /** 实际采用的方位（可能因翻转/换端与期望值不同，可用于箭头方向等）。 */
  placement: PopoverPlacement;
  /** 可用高度上限（上下都放不下时等于较大一侧的可用空间；需写入 style.maxHeight）。 */
  maxHeight: number;
  /** 可用宽度上限（尺寸超出视口时收紧；需写入 style.maxWidth）。 */
  maxWidth: number;
}

/** 默认与锚点间距。 */
export const POPOVER_GAP = 8;
/** 默认视口内边距。 */
export const POPOVER_MARGIN = 8;

function clampNumber(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

/** margin 不能超过视口一半（极小窗口下仍保证四边约束成立）。 */
function sanitizeMargin(margin: number, viewportWidth: number, viewportHeight: number): number {
  const base = Number.isFinite(margin) && margin > 0 ? margin : 0;
  return Math.max(0, Math.min(base, Math.floor(viewportWidth / 2), Math.floor(viewportHeight / 2)));
}

function sanitizeSize(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * 计算浮层位置。纯函数、无副作用：相同输入永远得到相同输出。
 */
export function placePopover(input: PlacePopoverInput): PopoverPosition {
  const viewportWidth = Math.max(0, input.viewport.width);
  const viewportHeight = Math.max(0, input.viewport.height);
  const margin = sanitizeMargin(input.margin ?? POPOVER_MARGIN, viewportWidth, viewportHeight);
  const gap = Number.isFinite(input.gap) && (input.gap ?? 0) >= 0 ? (input.gap as number) : POPOVER_GAP;
  const preferred = input.placement ?? "bottom-start";
  const preferTop = preferred.startsWith("top");
  const preferEnd = preferred.endsWith("-end");

  // 宽度先按视口收紧；height 保留自然高度用于“是否放得下”的判断，放不下时由 maxHeight 兜底。
  const maxWidth = Math.max(0, viewportWidth - margin * 2);
  const width = Math.min(sanitizeSize(input.size.width), maxWidth);
  const height = sanitizeSize(input.size.height);

  const anchorBottom = input.anchor.y + input.anchor.height;
  const spaceBelow = viewportHeight - margin - (anchorBottom + gap);
  const spaceAbove = input.anchor.y - gap - margin;
  const fitsBelow = spaceBelow >= height;
  const fitsAbove = spaceAbove >= height;

  let side: "top" | "bottom";
  if (preferTop) {
    side = fitsAbove ? "top" : fitsBelow ? "bottom" : spaceAbove >= spaceBelow ? "top" : "bottom";
  } else {
    side = fitsBelow ? "bottom" : fitsAbove ? "top" : spaceBelow >= spaceAbove ? "bottom" : "top";
  }
  // 上限再夹一次视口：锚点本身滚出视口时（例如 y=视口外），原始侧空间可能大于视口高度，
  // 不收紧会出现 top=margin 但 maxHeight 超出视口 → 底部被截断。
  const viewportSpaceCap = Math.max(0, viewportHeight - margin * 2);
  const rawSideSpace = side === "bottom" ? spaceBelow : spaceAbove;
  const sideSpace = Math.min(Math.max(0, rawSideSpace), viewportSpaceCap);
  // 上下都放不下时限制 maxHeight；放得下时也给一个不小于自然高度的上限（内容异步变长时由重定位/RO 再算）。
  const maxHeight = sideSpace;
  const effectiveHeight = Math.min(height, maxHeight);

  const anchorTop = input.anchor.y;
  const rawTop = side === "top" ? anchorTop - gap - effectiveHeight : anchorBottom + gap;
  const top = clampNumber(rawTop, margin, Math.max(margin, viewportHeight - margin - effectiveHeight));

  // 水平：先尝试期望的对齐端，放不下换另一端，都不行再 clamp（宽度已 ≤ maxWidth，clamp 后必然放得下）。
  const startLeft = input.anchor.x;
  const endLeft = input.anchor.x + input.anchor.width - width;
  const fitsLeft = (left: number): boolean => left >= margin && left + width <= viewportWidth - margin;
  let alignment: "start" | "end" = preferEnd ? "end" : "start";
  const desiredLeft = alignment === "start" ? startLeft : endLeft;
  if (!fitsLeft(desiredLeft)) {
    const otherAlignment: "start" | "end" = alignment === "start" ? "end" : "start";
    const otherLeft = otherAlignment === "start" ? startLeft : endLeft;
    if (fitsLeft(otherLeft)) alignment = otherAlignment;
  }
  let left = clampNumber(
    alignment === "start" ? startLeft : endLeft,
    margin,
    Math.max(margin, viewportWidth - margin - width),
  );

  // 原生网页区域避让：菜单与网页只相交几像素时，宁可把菜单平移到网页旁边，
  // 也不要把整页隐藏成静态底图（那会让网页点击/跳转全部失效）。
  const avoid = input.avoid;
  if (avoid) {
    const verticalOverlap = top < avoid.y + avoid.height && top + effectiveHeight > avoid.y;
    const intersects = left < avoid.x + avoid.width && left + width > avoid.x;
    if (verticalOverlap && intersects) {
      const fits = (candidate: number): boolean => candidate >= margin && candidate + width <= viewportWidth - margin;
      const rightCandidate = avoid.x + avoid.width + gap;
      const leftCandidate = avoid.x - gap - width;
      if (fits(rightCandidate)) left = rightCandidate;
      else if (fits(leftCandidate)) left = leftCandidate;
    }
  }

  return {
    top,
    left,
    placement: `${side}-${alignment}` as PopoverPlacement,
    maxHeight,
    maxWidth,
  };
}
