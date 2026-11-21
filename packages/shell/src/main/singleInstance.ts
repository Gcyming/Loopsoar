/**
 * 单实例守卫：托盘后台驻留后，用户再次双击图标不应该启动第二套调度器/托盘/浏览器栈。
 * 第二个实例立即退出，并把已有窗口唤到前台。
 */
import type { App } from "electron";

export function ensureSingleInstance(app: App, onSecond: (argv: string[]) => void): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    // 给 Chromium 一点时间走完 quit；避免第二个实例继续初始化数据目录。
    setTimeout(() => process.exit(0), 0).unref?.();
    return false;
  }
  // 第二实例可能是被系统默认浏览器启动的：argv 里带着 http(s) URL，必须转交给主实例。
  app.on("second-instance", (_event, argv) => onSecond(argv));
  return true;
}
