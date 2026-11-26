/**
 * 权限确认队列（跨会话隔离）。
 *
 * 背景：ChatService 的权限请求是全局 IPC 事件；旧实现只有一个 permReq 状态，
 * 后台会话的确认会直接盖到用户当前正在看的会话上（挡住输入/停止按钮，也分不清是谁的）。
 * 现在按 sessionId 入队：当前会话的请求才弹窗；其它会话的只显示「点击前往」入口，
 * 切过去后自动弹出，确认/超时后再从队列移除。
 */
import { useCallback, useMemo, useState } from "react";

export interface PermissionRequestState {
  requestId: string;
  sessionId?: string;
  toolName: string;
  target?: string;
  kind?: string;
  reason?: string;
  category?: string;
}

export interface PermissionQueueApi {
  /** 当前会话的挂起确认（有则弹窗）。 */
  permReq: PermissionRequestState | null;
  /** 其它会话的挂起确认（只给入口，不抢界面）。 */
  otherSessionPerm: PermissionRequestState | null;
  /** 加入请求；兼容旧调用：传 null 表示清空队列。 */
  addPermRequest: (value: PermissionRequestState | null) => void;
  /** 按 requestId 结算（确认/拒绝/超时/取消）。 */
  resolvePermRequest: (requestId: string) => void;
}

export function usePermissionQueue(currentSession: string | null): PermissionQueueApi {
  const [queue, setQueue] = useState<PermissionRequestState[]>([]);

  const addPermRequest = useCallback((value: PermissionRequestState | null): void => {
    if (!value) {
      setQueue([]);
      return;
    }
    setQueue((prev) => [...prev.filter((item) => item.requestId !== value.requestId), value]);
  }, []);

  const resolvePermRequest = useCallback((requestId: string): void => {
    setQueue((prev) => prev.filter((item) => item.requestId !== requestId));
  }, []);

  const { permReq, otherSessionPerm } = useMemo(() => {
    const mine = queue.find((item) => !item.sessionId || item.sessionId === currentSession) ?? null;
    const other = queue.find((item) => Boolean(item.sessionId) && item.sessionId !== currentSession) ?? null;
    return { permReq: mine, otherSessionPerm: other };
  }, [queue, currentSession]);

  return { permReq, otherSessionPerm, addPermRequest, resolvePermRequest };
}
