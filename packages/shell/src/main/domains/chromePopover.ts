/**
 * chromePopover 域：工具栏浮层（独立子窗口）的 IPC 入口。
 *
 * 三条通道（契约 manifest 已含，sensitive）：
 *   · ui:openPopover   —— 主窗口渲染层请求打开浮层（{kind, anchor, lang?}）；**只允许主窗口调用**，
 *                         子窗口（浮层自己）即使拿到 trusted 帧也不能递归打开新浮层；
 *   · ui:closePopover  —— 关闭浮层（Esc / 点击外部 / 切换按钮）；
 *   · ui:popoverAction —— 浮层里的菜单项被点击：{action,payload} 经 deps.push("chrome:popoverAction", …)
 *                         转发给主窗口渲染层执行（openPage/navigate/savePage/openSettings…），并关闭浮层。
 *
 * 边界：本文件不碰 electron（管理器由 index 用真实 BrowserWindow/screen 装配；测试注入假对象），
 * 因此可以只装配域来验证通道/handler 一致性（发布门 2）。
 */
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";
import {
  CHROME_POPOVER_KINDS,
  type ChromePopoverActionInput,
  type ChromePopoverKind,
  type ChromePopoverManager,
  type PopoverRect,
} from "../chromePopover.js";

/** ui:openPopover 的请求体（与契约 OpenChromePopoverSchema 同形）。 */
export interface ChromePopoverOpenPayload {
  kind: ChromePopoverKind;
  /** 锚点矩形：相对主窗口内容区的 CSS px。 */
  anchor: PopoverRect;
  lang?: "zh-CN" | "en-US";
  /** tabmenu 专用：被右键的标签 id。 */
  tabId?: string;
}

export interface ChromePopoverDomainDeps extends TrustedIpcDeps {
  /** 事件推送（index 传 pushToRenderer；缺省不推）。 */
  push?: (event: string, payload: unknown) => void;
  /**
   * 主窗口 webContents.id（用于 ui:openPopover 的发送者校验）。
   * 给了就必须只接受该 id 的调用；返回 null 视为主窗口不可用 → 拒绝（fail-closed）。
   */
  getMainWebContentsId?: () => number | null;
}

/**
 * 包裹一层发送者校验：handleTrusted 只校验「帧来源可信」，无法区分主窗口与浮层子窗口（同源 loopsoar://）；
 * 这里在真正的 ipcMain handler 之前按 event.sender.id 精确限定主窗口，其余仍完全走 handleTrusted 的四要素校验。
 */
function withMainSenderGuard(deps: ChromePopoverDomainDeps): TrustedIpcDeps {
  if (!deps.getMainWebContentsId) return deps;
  const getMainId = deps.getMainWebContentsId;
  return {
    audit: deps.audit,
    ipc: {
      handle(channel, fn) {
        deps.ipc.handle(channel, async (event, payload) => {
          const expected = getMainId();
          const senderId = (event as { sender?: { id?: number } } | null)?.sender?.id;
          if (expected === null || typeof expected !== "number" || senderId !== expected) {
            deps.audit({
              channel,
              sender: typeof senderId === "number" ? String(senderId) : "-",
              status: "rejected",
              reason: "仅主窗口可打开工具栏浮层",
            });
            throw new Error("IPC 拒绝：仅主窗口可打开工具栏浮层");
          }
          return fn(event, payload);
        });
      },
    },
  };
}

function isFiniteRect(value: unknown): value is PopoverRect {
  if (!value || typeof value !== "object") return false;
  const rect = value as Record<string, unknown>;
  return (
    typeof rect.x === "number" &&
    typeof rect.y === "number" &&
    typeof rect.width === "number" &&
    typeof rect.height === "number" &&
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

/** 注册浮层通道；manager 由 index 用真实 Electron 装配，测试注入假对象。 */
export function registerChromePopoverDomain(
  deps: ChromePopoverDomainDeps,
  manager: ChromePopoverManager,
): void {
  handleTrusted(withMainSenderGuard(deps), "ui:openPopover", (payload) => {
    const input = (payload ?? {}) as Partial<ChromePopoverOpenPayload> & Record<string, unknown>;
    if (!CHROME_POPOVER_KINDS.includes(input.kind as ChromePopoverKind)) {
      // 契约 zod 已校验过一次；这里再判一次（fail-closed，防止绕过契约直接调用）
      return { ok: false, error: "未知浮层类型" };
    }
    if (!isFiniteRect(input.anchor)) {
      return { ok: false, error: "浮层锚点参数无效" };
    }
    const lang = input.lang === "zh-CN" || input.lang === "en-US" ? input.lang : undefined;
    const tabId = typeof input.tabId === "string" && input.tabId.length > 0 ? input.tabId : undefined;
    return manager.open({ kind: input.kind as ChromePopoverKind, anchor: input.anchor as PopoverRect, lang, tabId });
  });

  handleTrusted(withMainSenderGuard(deps), "ui:togglePopover", (payload) => {
    if (manager.isOpen()) {
      manager.close();
      return { ok: true, open: false };
    }
    const input = (payload ?? {}) as Partial<ChromePopoverOpenPayload> & Record<string, unknown>;
    if (!CHROME_POPOVER_KINDS.includes(input.kind as ChromePopoverKind)) {
      return { ok: false, error: "未知浮层类型", open: false };
    }
    if (!isFiniteRect(input.anchor)) {
      return { ok: false, error: "浮层锚点参数无效", open: false };
    }
    const lang = input.lang === "zh-CN" || input.lang === "en-US" ? input.lang : undefined;
    const tabId = typeof input.tabId === "string" && input.tabId.length > 0 ? input.tabId : undefined;
    const result = manager.open({ kind: input.kind as ChromePopoverKind, anchor: input.anchor as PopoverRect, lang, tabId });
    return { ...result, open: result.ok };
  });

  handleTrusted(deps, "ui:closePopover", () => {
    manager.close();
    return { ok: true };
  });

  handleTrusted(deps, "ui:popoverAction", (payload) => {
    const action = payload as ChromePopoverActionInput;
    try {
      deps.push?.("chrome:popoverAction", action);
    } catch {
      // 推送失败（主窗口正在销毁等）也要继续关闭浮层，避免悬空窗口
    }
    // domain 自己转发 + 关闭（manager.handleAction 的 onAction 仅作为嵌入方直连时的备选）
    manager.close();
    return { ok: true };
  });
}
