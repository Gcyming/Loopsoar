/**
 * 桌面通知（定时任务完成/失败、聊天任务完成/异常、ask_user 询问）。
 * 托盘模式下窗口可能完全隐藏，没有通知用户就不知道后台任务已经跑完。
 * 系统不支持时静默跳过；提示音先使用系统默认音（shell.beep），后续可替换自定义音效。
 */
import { BrowserWindow, Notification, shell } from "electron";

/**
 * 通知只需要窗口的这几件事（结构类型）：notifications.ts 因此不必 import electron，
 * 分层守卫也只允许本文件（Electron 适配层）碰原生模块。
 */
export interface NotifyWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

/** 是否有任意窗口在前台：前台时不打扰用户（应用内已经能看到结果）。 */
export function isAnyWindowFocused(): boolean {
  return BrowserWindow.getAllWindows().some((win) => !win.isDestroyed() && win.isFocused());
}

/** 点击通知回到主窗口：最小化先还原，再显示并聚焦。 */
export function focusNotifyWindow(win: NotifyWindow | null | undefined): void {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

export interface DesktopNotifyOptions {
  /** 只弹通知、不播放系统通知音（用户关闭提示音时）。 */
  silent?: boolean;
  /** 点击通知：回到主窗口（询问/任务完成时用户能直接处理）。 */
  onClick?: () => void;
}

/** 发一条系统通知；返回是否真的弹出了（不支持/异常时 false，调用方可降级 beep）。 */
export function showDesktopNotification(title: string, body: string, options: DesktopNotifyOptions = {}): boolean {
  try {
    if (!Notification.isSupported()) return false;
    const notification = new Notification({
      title,
      body,
      ...(options.silent ? { silent: true } : {}),
    });
    if (options.onClick) notification.on("click", options.onClick);
    notification.show();
    return true;
  } catch {
    // 通知失败不能影响调度器/聊天本身。
    return false;
  }
}

/** 系统默认提示音（无通知或通知静音时使用）；部分平台可能无声，属系统策略。 */
export function beepSystemSound(): void {
  try {
    shell.beep();
  } catch {
    // 忽略：提示音不是核心功能。
  }
}
