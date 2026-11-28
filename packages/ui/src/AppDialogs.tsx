import type { AskUserRequest } from "./types.js";
import PermissionDialog from "./PermissionDialog.js";
import Toast from "./Toast.js";
import { getLanguage, t } from "./i18n.js";

export interface AppDialogsProps {
  permReq: {
    requestId: string;
    toolName: string;
    target?: string;
    kind?: string;
    reason?: string;
    category?: string;
  } | null;
  onRespondPermission: (choice: "allow-once" | "allow-session" | "deny") => void;
  otherSessionAsk: AskUserRequest | null;
  /** 其它会话有挂起的权限确认（只给入口，不抢当前界面）。 */
  otherSessionPerm?: { sessionId?: string } | null;
  onSwitchSession: (sessionId: string) => void;
  notice: string;
  miniWindow: boolean;
  onDismissNotice: () => void;
}

/**
 * 应用级对话框栈：权限确认、当前会话询问、其它会话询问入口、小窗内联 Toast。
 * 纯展示组件，状态与回填仍由 App 持有；抽出后 App 只负责编排，不再堆叠弹窗标记。
 */
export default function AppDialogs({
  permReq,
  onRespondPermission,
  otherSessionAsk,
  otherSessionPerm,
  onSwitchSession,
  notice,
  miniWindow,
  onDismissNotice,
}: AppDialogsProps) {
  return (
    <>
      {permReq ? <PermissionDialog request={permReq} onRespond={onRespondPermission} /> : null}

      {/* 当前会话的提问已改为「会话内卡片」（见 App 的 chat 列），这里只处理后台会话入口 */}
      {otherSessionAsk?.sessionId ? (
        <button
          type="button"
          className="ask-pending-other"
          onClick={() => onSwitchSession(otherSessionAsk.sessionId as string)}
          title={t(getLanguage(), "ask.pendingOther")}
        >
          {t(getLanguage(), "ask.pendingOther")}
        </button>
      ) : null}

      {/* 其它会话有权限确认：同样给一个可点击入口，切过去再弹窗确认。 */}
      {!permReq && !otherSessionAsk && otherSessionPerm?.sessionId ? (
        <button
          type="button"
          className="ask-pending-other"
          onClick={() => onSwitchSession(otherSessionPerm.sessionId as string)}
          title={t(getLanguage(), "ask.pendingOther")}
        >
          {t(getLanguage(), "ask.pendingOther")}
        </button>
      ) : null}

      {/* 主窗口的提示走独立子窗口（原生网页会盖住 DOM）；只有独立的小窗模式仍用内联 Toast。 */}
      {notice && miniWindow ? <Toast text={notice} onDismiss={onDismissNotice} /> : null}
    </>
  );
}
