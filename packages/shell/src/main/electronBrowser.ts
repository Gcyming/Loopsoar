/**
 * Electron 侧 BrowserHost 装配。
 * 允许 import electron 的文件之一（另一个是 main/index.ts）：只做「electron API → 依赖注入」的薄适配。
 * 修复 ①：webContents.setWindowOpenHandler 把 target=_blank/window.open 转为应用内新标签，
 *        不再产生 Electron 独立窗口（旧行为看起来像「弹窗」）。
 */
import { BrowserWindow, WebContentsView } from "electron";
import { SESSION_PARTITION } from "../shared/brand.js";
import { BrowserHost, type HostView } from "./browserHost.js";

export function createElectronBrowserHost(
  getWindow: () => BrowserWindow | null,
  openInNewTab: (url: string) => void,
): BrowserHost {
  return new BrowserHost({
    createView: () => {
      const view = new WebContentsView({
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          partition: SESSION_PARTITION,
        },
      });
      view.webContents.setWindowOpenHandler(({ url }) => {
        // 在应用内开新标签，拒绝 Electron 默认新建窗口
        openInNewTab(url);
        return { action: "deny" };
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
        // 窗口已销毁时忽略
      }
    },
    getWindowSize: () => {
      const win = getWindow();
      if (!win) return { width: 1360, height: 860 };
      const [width, height] = win.getContentSize();
      return { width, height };
    },
    onTabsChanged: (tabs) => {
      const win = getWindow();
      win?.webContents.send("loopsoar:browser:tabs", { tabs });
    },
    openInNewTab,
  });
}
