/**
 * 浮层（popover）协调器：全局同一时刻只允许一个菜单展开，点击外部 / Esc 收起。
 *
 * 为什么单独成模块：Composer 的权限/模型菜单与顶栏的历史/下载、侧栏会话列表分属不同组件，
 * 如果各自维护「打开状态」，就会出现多个菜单同时展开、点击空白处不收起。
 * 这里只做"谁打开"的仲裁与外部点击检测，不关心菜单内容，业务状态仍归各自组件。
 */
import * as React from "react";

let openId: string | null = null;
const listeners = new Set<(id: string | null) => void>();

function emit(): void {
  for (const listener of listeners) listener(openId);
}

export function claimPopover(id: string): void {
  if (openId === id) return;
  openId = id;
  emit();
}

export function releasePopover(id: string): void {
  if (openId !== id) return;
  openId = null;
  emit();
}

/**
 * 绑定一个浮层的开合：
 * - 打开时向协调器登记（其它浮层自动关闭）；
 * - 点击带 [data-popover] / [data-popover-trigger] 之外的区域，或按 Esc，自动关闭。
 *
 * 使用方需要给浮层根节点加 data-popover，给触发按钮外层加 data-popover-trigger。
 */
export function usePopover(id: string, open: boolean, setOpen: (next: boolean) => void): void {
  React.useEffect(() => {
    if (open) claimPopover(id);
    else releasePopover(id);
  }, [id, open]);

  React.useEffect(() => {
    const listener = (current: string | null): void => {
      if (current !== id && open) setOpen(false);
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [id, open, setOpen]);

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-popover],[data-popover-trigger]")) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, setOpen]);
}
