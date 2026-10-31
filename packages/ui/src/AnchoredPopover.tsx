/**
 * 锚定浮层（Portal）：菜单渲染到 document.body，按触发按钮的实际位置定位。
 *
 * 为什么不用父节点里的 absolute：
 *   · 输入区/侧栏的祖先有滚动容器与层级，absolute 会被裁切或被后绘制区域覆盖
 *     （表现就是权限/模型菜单被输入区挡住、只剩半截）；
 *   · Portal + fixed 定位不受祖先 overflow/stacking context 影响，始终浮在最上层。
 *
 * 交互（点击外部、Esc、互斥）由 popover.ts 的 usePopover 负责。
 */
import * as React from "react";
import { createPortal } from "react-dom";
import { BRAND } from "./theme.js";

export interface PopoverProps {
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  width?: number;
  children: React.ReactNode;
}

interface Position {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
  maxHeight: number;
}

export default function Popover({ anchorRef, open, onClose, width, children }: PopoverProps): React.ReactElement | null {
  const [position, setPosition] = React.useState<Position | null>(null);

  React.useLayoutEffect(() => {
    if (!open) return;
    const update = (): void => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const gap = 8;
      const spaceAbove = rect.top - gap;
      const spaceBelow = window.innerHeight - rect.bottom - gap;
      const placeAbove = spaceAbove >= 180 || spaceAbove >= spaceBelow;
      const maxHeight = Math.max(160, (placeAbove ? spaceAbove : spaceBelow) - 8);
      if (placeAbove) {
        setPosition({ bottom: window.innerHeight - rect.top + gap, right: window.innerWidth - rect.right, maxHeight });
      } else {
        setPosition({ top: rect.bottom + gap, right: window.innerWidth - rect.right, maxHeight });
      }
    };
    update();
    window.addEventListener("resize", update);
    // 捕获滚动：聊天区/页面滚动时浮层跟随触发按钮
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef, open]);

  if (!open || !position) return null;
  return createPortal(
    <div
      data-popover
      className="pop-in anchored-popover"
      style={{
        position: "fixed",
        ...position,
        width,
        maxWidth: "calc(100vw - 24px)",
        overflowY: "auto",
        zIndex: 2000,
        background: BRAND.inkRaised,
        border: `1px solid ${BRAND.borderStrong}`,
        borderRadius: 10,
        boxShadow: "0 14px 40px rgba(0,0,0,0.55)",
        padding: 8,
      }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}
