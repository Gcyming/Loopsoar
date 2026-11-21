/**
 * 桌面通知（定时任务完成/失败）。托盘模式下窗口可能完全隐藏，
 * 没有通知用户就不知道后台任务已经跑完。系统不支持时静默跳过。
 */
import { Notification } from "electron";

export function showDesktopNotification(title: string, body: string): void {
  try {
    if (!Notification.isSupported()) return;
    new Notification({ title, body }).show();
  } catch {
    // 通知失败不能影响调度器本身。
  }
}
