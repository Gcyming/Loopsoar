/**
 * agentWindow 域：「Agent 会话栏独立窗口」的 IPC 入口（真·窗口化）。
 *
 * 三条通道（契约 manifest 已含，sensitive）：
 *   · ui:openAgentWindow     —— 打开/聚焦会话栏独立窗口（{sessionId?}）；**只允许主窗口调用**
 *                               （Agent 窗口自己再开一个窗口没有意义，也防递归/多实例）；
 *   · ui:closeAgentWindow    —— 关闭会话栏窗口；主窗口与 Agent 窗口自身都允许调用
 *                               （窗口内的关闭按钮/快捷键需要能关自己），程序性关闭不推事件；
 *   · ui:minimizeAgentWindow —— 最小化自己（无边框窗口的标题栏最小化按钮）；**只允许 Agent 窗口自身**
 *                               （主窗口的最小化由系统标题栏/其它入口负责，这里不越权）。
 *
 * 事件：窗口被用户/系统关闭时，经 manager.onClosed 订阅 → `deps.push("chrome:agentWindowClosed", {})`
 *       通知主窗口渲染层（主窗口据此把侧栏恢复显示/更新按钮状态）。程序性 close/dispose 不推。
 *
 * 边界：本文件不碰 electron（manager 由 index 用真实 BrowserWindow 装配；测试注入假对象），
 * 因此可以只装配域来验证通道/handler 一致性（发布门 2）。
 */
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";
import type { AgentWindowManager, AgentWindowOpenResult } from "../agentWindow.js";

/** ui:openAgentWindow 的请求体（与契约 OpenAgentWindowSchema 同形）。 */
export interface AgentWindowOpenPayload {
  /** 要展示的会话 id；缺省 = 主窗口当前会话（由渲染层决定传什么）。 */
  sessionId?: string;
}

export interface AgentWindowDomainDeps extends TrustedIpcDeps {
  /** 事件推送（index 传 pushToRenderer；缺省不推）。 */
  push?: (event: string, payload: unknown) => void;
  /**
   * 主窗口 webContents.id（ui:openAgentWindow 的发送者校验）。
   * 给了就必须只接受该 id 的调用；返回 null 视为主窗口不可用 → 拒绝（fail-closed）。
   */
  getMainWebContentsId?: () => number | null;
}

/**
 * 包裹一层发送者校验：handleTrusted 只校验「帧来源可信」，无法区分主窗口与 Agent 子窗口（同源 loopsoar://）；
 * 这里在真正的 ipcMain handler 之前按 event.sender.id 精确限定主窗口，其余仍完全走 handleTrusted 的四要素校验。
 */
function withMainSenderGuard(deps: AgentWindowDomainDeps): TrustedIpcDeps {
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
              reason: "仅主窗口可打开 Agent 会话栏窗口",
            });
            throw new Error("IPC 拒绝：仅主窗口可打开 Agent 会话栏窗口");
          }
          return fn(event, payload);
        });
      },
    },
  };
}

/** 归一化 sessionId：非字符串/空白 → undefined（缺省会话由渲染层用「当前会话」兜底）。 */
function normalizeSessionId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * 包裹一层「只允许 Agent 窗口自身」的发送者校验（ui:minimizeAgentWindow 专用）。
 * 与 withMainSenderGuard 同理：handleTrusted 只能保证帧来源可信（主窗口与 Agent 窗口同源），
 * 这里在真正的 ipcMain handler 之前按 event.sender.id 比对当前 Agent 窗口的 webContents.id；
 * 窗口未打开（webContentsId 为 null）或来源不匹配 → 审计 rejected 并拒绝（fail-closed）。
 */
function withAgentSenderGuard(deps: AgentWindowDomainDeps, manager: AgentWindowManager): TrustedIpcDeps {
  return {
    audit: deps.audit,
    ipc: {
      handle(channel, fn) {
        deps.ipc.handle(channel, async (event, payload) => {
          const expected = manager.webContentsId();
          const senderId = (event as { sender?: { id?: number } } | null)?.sender?.id;
          if (expected === null || typeof expected !== "number" || senderId !== expected) {
            deps.audit({
              channel,
              sender: typeof senderId === "number" ? String(senderId) : "-",
              status: "rejected",
              reason: "仅 Agent 会话栏窗口可最小化自身",
            });
            throw new Error("IPC 拒绝：仅 Agent 会话栏窗口可最小化自身");
          }
          return fn(event, payload);
        });
      },
    },
  };
}

/** 注册 Agent 会话栏窗口通道；manager 由 index 用真实 Electron 装配，测试注入假对象。 */
export function registerAgentWindowDomain(deps: AgentWindowDomainDeps, manager: AgentWindowManager): void {
  // 用户/系统关闭窗口 → 通知主窗口渲染层（程序性 close/dispose 不触发，避免 UI 自己关时收到二次通知）
  const unsubscribe = manager.onClosed(() => {
    try {
      deps.push?.("chrome:agentWindowClosed", {});
    } catch {
      // 推送失败（主窗口正在销毁等）不影响窗口已关闭的事实
    }
  });
  // 域生命周期与应用一致；保留取消订阅能力（未来热重载/测试可 dispose）
  void unsubscribe;

  handleTrusted(withMainSenderGuard(deps), "ui:openAgentWindow", (payload): AgentWindowOpenResult => {
    const input = (payload ?? {}) as AgentWindowOpenPayload;
    const sessionId = normalizeSessionId(input.sessionId);
    return manager.open(sessionId);
  });

  // 关闭通道不限制发送者：主窗口可关，Agent 窗口内的「关闭」按钮也可关自己；任何可信帧都是本应用窗口。
  // 关闭通知由 manager.onClosed 统一驱动（滑出动画结束后才触发），这里不再补推：
  // 提前 push 会让主窗口侧栏在窗口还盖在右侧时就展开，正是用户说的「收起位置反逻辑」。
  handleTrusted(deps, "ui:closeAgentWindow", () => {
    manager.close();
    return { ok: true };
  });

  // 最小化自己：只接受当前 Agent 窗口 webContents 的调用（主窗口无权替它最小化，避免误操作）。
  // 最小化后窗口滑到任务栏，主窗口右侧必须把侧栏让回来（否则主窗口侧栏仍隐藏、没有可见的再次打开入口）。
  // 复用 closed 事件语义「窗口已不在右缘」：主窗口据 agentWindowOpen=false 恢复侧栏；
  // 用户再点「小窗化」时 manager.open() 对已存在窗口走 focus()，会 restore 最小化窗口，届时 UI 重新隐藏侧栏。
  handleTrusted(withAgentSenderGuard(deps, manager), "ui:minimizeAgentWindow", (): { ok: boolean } => {
    const ok = manager.minimize();
    if (ok) {
      try {
        deps.push?.("chrome:agentWindowClosed", {});
      } catch {
        // 推送失败不影响窗口已最小化的事实
      }
    }
    return { ok };
  });
}
