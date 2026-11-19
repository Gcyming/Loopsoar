/**
 * 锚定浮层（Portal）：菜单渲染到 document.body，按触发按钮的实际位置定位。
 *
 * 为什么不用父节点里的 absolute：
 *   · 输入区/侧栏的祖先有滚动容器与层级，absolute 会被裁切或被后绘制区域覆盖
 *     （表现就是权限/模型菜单被输入区挡住、只剩半截）；
 *   · Portal + fixed 定位不受祖先 overflow/stacking context 影响，始终浮在最上层。
 *
 * 为什么定位不用 `top: 100%` 而是 placePopover：
 *   固定方向在窗口边缘必然被裁切（靠下/靠右的触发按钮尤其明显）。
 *   这里用纯函数 placePopover 做「下方优先 → 空间不足翻上方 → 左右夹取 → 上下都放不下
 *   取大侧 + maxHeight」，并监听 resize / 滚动 / 内容尺寸变化（ResizeObserver）重新定位，
 *   保证浮层四条边永远不越出视口。
 *
 * 交互（点击外部、Esc、互斥）由 popover.ts 的 usePopover 负责。
 */
import * as React from "react";
import { createPortal } from "react-dom";
import { BRAND } from "./theme.js";
import { placePopover, type PopoverPlacement, type PopoverPosition } from "./popoverPosition.js";

export interface PopoverProps {
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  width?: number;
  /** 期望方位（默认 bottom-start；空间不足自动翻转/换端）。 */
  placement?: PopoverPlacement;
  /** 与锚点间距（默认 8）。 */
  gap?: number;
  children: React.ReactNode;
}

/**
 * 应用内浮层统一层级：高于所有页面/模态/工具栏，避免新增页面时又把菜单盖住。
 * 原生 WebContentsView 不参与 DOM 层级，必须由 App 同时调用 browser.setOverlay 让位。
 */
export const POPOVER_Z_INDEX = 2_147_483_000;

function readViewport(): { width: number; height: number } {
  if (typeof window === "undefined") return { width: 0, height: 0 };
  return {
    width: window.innerWidth || document.documentElement.clientWidth || 0,
    height: window.innerHeight || document.documentElement.clientHeight || 0,
  };
}

function samePosition(previous: PopoverPosition | null, next: PopoverPosition): boolean {
  return (
    previous !== null &&
    previous.top === next.top &&
    previous.left === next.left &&
    previous.placement === next.placement &&
    previous.maxHeight === next.maxHeight &&
    previous.maxWidth === next.maxWidth
  );
}

export default function Popover({
  anchorRef,
  open,
  onClose: _onClose,
  width,
  placement,
  gap,
  children,
}: PopoverProps): React.ReactElement | null {
  /** 计算后的位置；null = 尚未测量（先隐藏渲染，拿到尺寸后立即定位）。 */
  const [position, setPosition] = React.useState<PopoverPosition | null>(null);
  const boxRef = React.useRef<HTMLDivElement | null>(null);

  /** 测量锚点/内容并重算位置（读 DOM，不产生渲染副作用）。 */
  const update = React.useCallback((): void => {
    const anchor = anchorRef.current;
    const box = boxRef.current;
    if (!anchor || !box) return;
    const rect = anchor.getBoundingClientRect();
    // 自然尺寸：scroll* 反映完整内容（即使已被上一轮 maxHeight 限制成滚动区）
    const measuredWidth = width ?? Math.max(box.offsetWidth, box.scrollWidth, 0);
    const measuredHeight = Math.max(box.offsetHeight, box.scrollHeight, 0);
    // 原生网页可见时，菜单不遮挡网页：能平移到网页侧边就平移，避免触发整页冻结。
    const pageEl = document.querySelector<HTMLElement>('[data-native-page="live"]');
    const pageRect = pageEl?.getBoundingClientRect() ?? null;
    const next = placePopover({
      anchor: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      size: { width: measuredWidth, height: measuredHeight },
      viewport: readViewport(),
      ...(placement ? { placement } : {}),
      ...(gap !== undefined ? { gap } : {}),
      avoid: pageRect ? { x: pageRect.x, y: pageRect.y, width: pageRect.width, height: pageRect.height } : null,
    });
    setPosition((previous) => (samePosition(previous, next) ? previous : next));
  }, [anchorRef, width, placement, gap]);

  React.useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    // 首次定位（layout effect 内同步 setState，浏览器绘制前完成，不会闪到 0,0）
    update();
    const onViewportChange = (): void => update();
    window.addEventListener("resize", onViewportChange);
    // 捕获滚动：聊天区/侧栏/页面滚动时浮层跟随触发按钮
    window.addEventListener("scroll", onViewportChange, true);
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => update());
      // 内容异步变长（模型列表加载/会话列表刷新）与锚点尺寸变化都要重新定位
      if (boxRef.current) observer.observe(boxRef.current);
      if (anchorRef.current) observer.observe(anchorRef.current);
    }
    // 页面从搜索主页切到真实网页时，原生视图区域才出现；菜单需要立刻避让。
    const pageObserver =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver(() => update())
        : null;
    pageObserver?.observe(document.body, { attributes: true, attributeFilter: ["data-native-page"], subtree: true });
    return () => {
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
      observer?.disconnect();
      pageObserver?.disconnect();
    };
  }, [open, update, anchorRef]);

  if (!open) return null;

  /** 有 width 时按 maxWidth 收紧（极小窗口下菜单不越界）；无 width 时交给内容自然宽度 + maxWidth。 */
  const effectiveWidth = width !== undefined ? Math.min(width, position?.maxWidth ?? width) : undefined;

  return createPortal(
    <div
      ref={boxRef}
      data-popover
      className="pop-in anchored-popover"
      style={{
        position: "fixed",
        top: position?.top ?? -9999,
        left: position?.left ?? -9999,
        ...(effectiveWidth !== undefined ? { width: effectiveWidth } : {}),
        maxWidth: position?.maxWidth ?? "calc(100vw - 24px)",
        ...(position ? { maxHeight: position.maxHeight } : {}),
        overflowY: "auto",
        overflowX: "hidden",
        // 测量阶段先隐藏，避免未定位时闪一下
        visibility: position ? "visible" : "hidden",
        zIndex: POPOVER_Z_INDEX,
        background: BRAND.inkRaised,
        border: `1px solid ${BRAND.borderStrong}`,
        borderRadius: 10,
        // 窗口内 Portal 浮层：保留轻微层叠即可；原来的 40px/0.55 大投影在浅色主题下
        // 会形成一圈发光的「大方框阴影」（用户 m02115 反馈），这里收小/减淡。
        boxShadow: "0 10px 26px rgba(0,0,0,0.42)",
        padding: 8,
      }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}
