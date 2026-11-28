/**
 * 非前台通知：只有 Loopsoar 不在前台时才打扰用户。
 *
 * 触发点：
 *   · 聊天回合完成/异常中断（ChatService.onTurnComplete）
 *   · ask_user 询问（AskBus → coreServices.onAskUser）
 *
 * 用户可在「设置 · 通用」分别关闭系统通知和提示音；提示音先使用系统默认音，
 * 自定义音效等设计定稿后再接。通知点击会恢复并聚焦主窗口。
 */
import { loadPreferences } from "./domains/settings.js";
import {
  beepSystemSound,
  focusNotifyWindow,
  isAnyWindowFocused,
  showDesktopNotification,
  type NotifyWindow,
} from "./desktopNotify.js";

export interface NotifyTurnInput {
  sessionId?: string;
  userText: string;
  status: string;
  reason?: string;
  finalText?: string;
}

export interface NotifyAskInput {
  sessionId?: string;
  question?: string;
  header?: string;
}

export interface Notifier {
  turn(input: NotifyTurnInput): void;
  ask(input: NotifyAskInput): void;
  /** 定时任务等通用系统通知（同样遵守前台/开关/提示音设置）；sessionId 用于和回合通知去重。 */
  system(title: string, body: string, sessionId?: string): void;
}

/** 本模块只做决策：前台判断/聚焦/弹通知/提示音都由 desktopNotify（Electron 层）提供。 */
export function createNotifier(options: {
  configDir: string;
  getWindow: () => NotifyWindow | null;
}): Notifier {
  const isForeground = isAnyWindowFocused;
  const focusWindow = (): void => focusNotifyWindow(options.getWindow());

  // 定时任务的收尾通知和 ChatService 的回合完成通知可能同时到达；
  // 同一会话 5 秒内只提醒一次（谁先到谁决定文案）。
  const recentTurn = new Map<string, number>();
  const seenTurn = (sessionId?: string): boolean => {
    if (!sessionId) return false;
    const now = Date.now();
    const last = recentTurn.get(sessionId) ?? 0;
    if (last && now - last < 5000) return true;
    recentTurn.set(sessionId, now);
    if (recentTurn.size > 100) {
      for (const [key, at] of recentTurn) if (now - at > 5000) recentTurn.delete(key);
    }
    return false;
  };

  const fire = (title: string, body: string): boolean => {
    const prefs = loadPreferences(options.configDir);
    const sound = prefs.notificationSoundEnabled !== false;
    const notify = prefs.notificationsEnabled !== false;
    if (!notify && !sound) return false;
    if (notify) {
      const shown = showDesktopNotification(title, body, { silent: !sound, onClick: focusWindow });
      if (shown) return true;
    }
    // 通知被系统关闭/不支持，但用户仍要提示音：退回系统默认音。
    if (sound) {
      beepSystemSound();
      return true;
    }
    return false;
  };

  const clip = (text: string, limit = 160): string => {
    const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
    if (!normalized) return "";
    return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
  };

  const titleFor = (status: string, language: string | undefined): string => {
    const en = language === "en-US";
    if (status === "done") return en ? "Loopsoar · Task complete" : "Loopsoar · 任务完成";
    return en ? "Loopsoar · Task interrupted" : "Loopsoar · 任务中断";
  };

  return {
    turn(input: NotifyTurnInput): void {
      if (isForeground()) return;
      // 用户主动停止不是异常，也没有「完成任务」的价值；不打扰。
      if (input.status === "aborted") return;
      if (seenTurn(input.sessionId)) return;
      const prefs = loadPreferences(options.configDir);
      const done = input.status === "done";
      const body = done
        ? clip(input.finalText || input.userText || (prefs.language === "en-US" ? "Task completed" : "任务已完成"))
        : clip(input.reason || (prefs.language === "en-US" ? "The task stopped abnormally." : "任务异常中断，请回到应用查看。"));
      fire(titleFor(input.status, prefs.language), body);
    },
    system(title: string, body: string, sessionId?: string): void {
      if (isForeground()) return;
      if (seenTurn(sessionId)) return;
      fire(title, body);
    },
    ask(input: NotifyAskInput): void {
      if (isForeground()) return;
      const prefs = loadPreferences(options.configDir);
      const en = prefs.language === "en-US";
      const question = clip(input.question ?? "", 180);
      const header = clip(input.header ?? "", 60);
      const body = header && question ? `${header}：${question}` : question || header || (en ? "The agent needs your input." : "Agent 需要你的选择。");
      fire(en ? "Loopsoar · Input needed" : "Loopsoar · 需要你的选择", body);
    },
  };
}
