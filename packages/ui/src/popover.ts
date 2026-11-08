/**
 * 浮层（popover）协调器：全局同一时刻只允许一个菜单展开，点击外部 / Esc 收起。
 *
 * 为什么单独成模块：Composer 的权限/模型/命令菜单与顶栏历史/侧栏会话列表分属不同组件，
 * 如果各自维护「打开状态」，就会出现多个菜单同时展开、点击空白处不收起。
 * 这里只做"谁打开"的仲裁与外部点击检测，不关心菜单内容，业务状态仍归各自组件。
 *
 * **全局收起规则（用户 m02115）**：任何展开的列表/浮层，在用户进入其它界面
 * （设置/整页/工作区/快照/新建会话/切会话/切标签/窗口失焦）时都必须立刻收起。
 * 统一入口是 dismissAllPopovers()，由 App 在对应时机调用。
 *
 * 约定：**所有展开列表 / 浮层必须走 usePopover 或响应 dismissAllPopovers**，
 * 不要自己维护 open 状态 + 自己的 document 监听——那样会漏掉这些全局收起时机
 * （典型问题是设置页打开后，Composer 的「本会话工具权限」还浮在上面）。
 */
import * as React from "react";

let openId: string | null = null;
const listeners = new Set<(id: string | null) => void>();

function emit(): void {
  for (const listener of listeners) listener(openId);
}

/** 订阅「当前浮层 id」变化（usePopover 内部使用；测试/诊断也可用）。 */
export function subscribePopovers(listener: (id: string | null) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
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

/** 当前打开中的浮层 id（null = 没有）；供测试与 E2E 诊断。 */
export function getOpenPopoverId(): string | null {
  return openId;
}

/**
 * 一键收起当前所有已打开的浮层。
 *
 * 由 App 在「进入其它界面（设置/ChromePage/工作区/快照/向导）、切会话、新建会话、
 * 切浏览器标签、窗口失焦」时统一调用。只做关闭：**不 preventDefault / 不 stopPropagation**，
 * 否则会吞掉触发这次界面切换的第一次点击（用户必须点两次才能生效）。
 */
export function dismissAllPopovers(): void {
  if (openId === null) return;
  openId = null;
  emit();
}

/**
 * 绑定一个浮层的开合：
 * - 打开时向协调器登记（其它浮层自动关闭）；
 * - 点击带 [data-popover] / [data-popover-trigger] 之外的区域，或按 Esc，自动关闭；
 * - 其它浮层打开 / dismissAllPopovers() 时也会关闭。
 *
 * 使用方需要给浮层根节点加 data-popover，给触发按钮外层加 data-popover-trigger。
 */
export function usePopover(id: string, open: boolean, setOpen: (next: boolean) => void): void {
  React.useEffect(() => {
    if (open) claimPopover(id);
    else releasePopover(id);
  }, [id, open]);

  React.useEffect(() => {
    return subscribePopovers((current) => {
      if (current !== id && open) setOpen(false);
    });
  }, [id, open, setOpen]);

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-popover],[data-popover-trigger]")) return;
      // 注意：这里不能 preventDefault/stopPropagation —— 点击要透传给目标元素，
      // 只负责关闭浮层，否则会吞掉用户的第一次点击。
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
