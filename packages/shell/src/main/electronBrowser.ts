/**
 * Electron 侧 BrowserHost 装配 + 下载桥。
 * 允许 import electron 的文件之一（另一个是 main/index.ts）：只做「electron API → 依赖注入」的薄适配。
 * 修复 ①：webContents.setWindowOpenHandler 把 target=_blank/window.open 转为应用内新标签，
 *        不再产生 Electron 独立窗口（旧行为看起来像「弹窗」）。
 */
import path from "node:path";
import { app, BrowserWindow, session, shell, WebContentsView } from "electron";
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

/* ────────────────────────────── 下载桥 ────────────────────────────── */

export type DownloadState = "progressing" | "completed" | "cancelled" | "interrupted";

export interface DownloadView {
  id: string;
  filename: string;
  savePath: string;
  state: DownloadState;
  received: number;
  total: number;
  startedAt: number;
}

interface DownloadHandle {
  view: DownloadView;
  cancel: () => void;
  open: () => Promise<string>;
  showInFolder: () => void;
  done: boolean;
}

/** 下载管理：会话级 will-download → 内存条目 + 变更推送；文件落盘目录由偏好注入。 */
export class DownloadsBridge {
  private handles = new Map<string, DownloadHandle>();
  private seq = 0;

  constructor(
    private getDownloadDir: () => string,
    private onChange: () => void,
  ) {
    session.fromPartition(SESSION_PARTITION).on("will-download", (_event, item) => {
      this.register(item);
    });
  }

  private dir(): string {
    const custom = this.getDownloadDir().trim();
    if (custom) return custom;
    try {
      return app.getPath("downloads");
    } catch {
      return app.getPath("temp");
    }
  }

  private register(item: Electron.DownloadItem): void {
    this.seq += 1;
    const id = `dl-${this.seq}`;
    const filename = item.getFilename() || `download-${this.seq}`;
    const savePath = path.join(this.dir(), filename.replace(/[\\/:*?"<>|]/g, "_"));
    try {
      item.setSavePath(savePath);
    } catch {
      // 目录不可用时交给 electron 默认路径
    }
    const view: DownloadView = {
      id,
      filename,
      savePath,
      state: "progressing",
      received: 0,
      total: Math.max(0, item.getTotalBytes()),
      startedAt: Date.now(),
    };
    const handle: DownloadHandle = {
      view,
      cancel: () => {
        try {
          item.cancel();
        } catch {
          // 已结束
        }
      },
      open: () => shell.openPath(view.savePath),
      showInFolder: () => shell.showItemInFolder(view.savePath),
      done: false,
    };
    this.handles.set(id, handle);

    item.on("updated", (_e, state) => {
      view.received = item.getReceivedBytes();
      view.total = Math.max(view.total, item.getTotalBytes());
      if (state === "interrupted") view.state = "interrupted";
      this.onChange();
    });
    item.once("done", (_e, state) => {
      handle.done = true;
      view.state = state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "interrupted";
      view.received = item.getReceivedBytes();
      view.total = Math.max(view.total, item.getTotalBytes());
      this.onChange();
    });
    this.onChange();
  }

  list(): DownloadView[] {
    return [...this.handles.values()].map((h) => ({ ...h.view })).sort((a, b) => b.startedAt - a.startedAt);
  }

  action(id: string, action: "cancel" | "open" | "showInFolder" | "remove"): boolean {
    const handle = this.handles.get(id);
    if (!handle) return false;
    switch (action) {
      case "cancel":
        handle.cancel();
        return true;
      case "open":
        if (handle.view.state !== "completed") return false;
        void handle.open();
        return true;
      case "showInFolder":
        if (!handle.view.savePath) return false;
        handle.showInFolder();
        return true;
      case "remove":
        this.handles.delete(id);
        this.onChange();
        return true;
    }
  }
}
