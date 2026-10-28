/**
 * Electron 侧 BrowserHost 装配。
 * 允许 import electron 的第二个文件（第一个是 main/index.ts）：理由——
 *   Electron 的 WebContentsView 构造与窗口挂载无法在无 electron 环境表达，
 *   若全部塞进 index.ts 会让入口超过可维护规模；这里只做「electron API → 依赖注入」的薄适配。
 */
import { BrowserWindow, WebContentsView } from "electron";
import { SESSION_PARTITION } from "../shared/brand.js";
import { BrowserHost, type HostView } from "./browserHost.js";

export function createElectronBrowserHost(getWindow: () => BrowserWindow | null): BrowserHost {
  return new BrowserHost({
    createView: () => {
      const view = new WebContentsView({
        webPreferences: {
          // 渲染内容同样走沙箱 + 上下文隔离；浏览器内容不暴露 Node
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          partition: SESSION_PARTITION,
        },
      });
      return view as unknown as HostView;
    },
    attachView: (view) => {
      const win = getWindow();
      win?.contentView.addChildView(view as unknown as WebContentsView);
    },
    detachView: (view) => {
      const win = getWindow();
      if (!win) return;
      try {
        win.contentView.removeChildView(view as unknown as WebContentsView);
      } catch {
        // 窗口已销毁时摘除失败可忽略
      }
    },
    getWindowSize: () => {
      const win = getWindow();
      if (!win) return { width: 1280, height: 800 };
      const [width, height] = win.getContentSize();
      return { width, height };
    },
  });
}
