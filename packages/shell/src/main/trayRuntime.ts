/**
 * 系统托盘与「关闭窗口」策略。
 *
 * 默认仍保持旧行为（关闭 = 退出）。用户在设置·通用选择「最小化到托盘」后：
 *   · 点窗口关闭按钮只隐藏窗口，主进程继续运行（定时任务 / Agent 后台回合不受影响）；
 *   · 托盘菜单提供显示、打开定时任务、真正退出；
 *   · 退出走 app.quit()，关闭事件不再拦截，避免「点了退出却还在托盘」。
 *
 * 托盘图标按需创建（首次关闭或启动时已是托盘模式），创建失败则退回直接关闭窗口，
 * 绝不出现「窗口没了、托盘也没有」的不可恢复状态。
 */
import { app, Menu, nativeImage, Tray, type BrowserWindow } from "electron";

export interface TrayCloseBehaviorOptions {
  window: BrowserWindow;
  iconPath: () => string | undefined;
  getCloseBehavior: () => "tray" | "quit";
  onOpenSchedules: () => void;
  appName?: string;
}

export function installTrayCloseBehavior(options: TrayCloseBehaviorOptions): () => void {
  const { window } = options;
  const appName = options.appName ?? "Loopsoar";
  let tray: Tray | null = null;
  let quitting = false;
  let balloonShown = false;

  const showWindow = (): void => {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };

  const ensureTray = (): Tray | null => {
    if (tray && !tray.isDestroyed()) return tray;
    const icon = options.iconPath();
    if (!icon) return null;
    let image = nativeImage.createFromPath(icon);
    if (image.isEmpty()) return null;
    // Windows 托盘区按 16px 展示：过大的 .ico/PNG 会缩得很糊；先缩放一次。
    if (process.platform === "win32") image = image.resize({ width: 16, height: 16 });
    try {
      tray = new Tray(image);
    } catch (err) {
      console.warn("[Loopsoar] 创建系统托盘失败，将退回直接退出：", err instanceof Error ? err.message : String(err));
      tray = null;
      return null;
    }
    tray.setToolTip(appName);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `显示 ${appName}`, click: showWindow },
        {
          label: "打开定时任务",
          click: () => {
            showWindow();
            options.onOpenSchedules();
          },
        },
        { type: "separator" },
        {
          label: `退出 ${appName}`,
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ]),
    );
    tray.on("click", showWindow);
    tray.on("double-click", showWindow);
    return tray;
  };

  window.on("close", (event) => {
    if (quitting) return;
    if (options.getCloseBehavior() !== "tray") return;
    const created = ensureTray();
    if (!created) return; // 托盘不可用：允许正常关闭，避免应用变成幽灵进程
    event.preventDefault();
    window.hide();
    if (!balloonShown) {
      balloonShown = true;
      try {
        created.displayBalloon({
          title: `${appName} 仍在运行`,
          content: "定时任务会继续执行；可从托盘图标重新打开或退出。",
        });
      } catch {
        // 部分桌面环境不支持气泡提示；托盘图标本身已足够。
      }
    }
  });

  const onBeforeQuit = (): void => {
    quitting = true;
    tray?.destroy();
    tray = null;
  };
  app.on("before-quit", onBeforeQuit);

  // 启动时已经是托盘模式：提前显示图标，让用户知道后台正在运行。
  if (options.getCloseBehavior() === "tray") {
    const timer = setTimeout(() => ensureTray(), 1_200);
    timer.unref?.();
  }

  return () => {
    app.removeListener("before-quit", onBeforeQuit);
    tray?.destroy();
    tray = null;
  };
}
