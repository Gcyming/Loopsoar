/**
 * Electron 侧 BrowserHost 装配 + 下载桥。
 * 允许 import electron 的文件之一（另一个是 main/index.ts）：只做「electron API → 依赖注入」的薄适配。
 * 修复 ①：webContents.setWindowOpenHandler 把 target=_blank/window.open 转为应用内新标签，
 *        不再产生 Electron 独立窗口（旧行为看起来像「弹窗」）。
 */
import path from "node:path";
import { lookup } from "node:dns/promises";
import { app, BrowserWindow, session, shell, WebContentsView } from "electron";
import { SESSION_PARTITION } from "../shared/brand.js";
import { BrowserHost, type HostView, type PersistedBrowserState } from "./browserHost.js";
import {
  browserRequestHost,
  createBrowserRequestChecker,
  createBrowserRequestPolicy,
} from "./browserRequestGuard.js";

export interface ElectronBrowserHostOptions {
  initialSessionId?: string;
  onSessionStateChanged?: (sessionId: string, state: PersistedBrowserState) => void;
  /** DNS 解析注入（测试/E2E 可替换；默认用 node:dns）。 */
  resolveIps?: (host: string) => Promise<string[]>;
  /** 浏览器是否允许回环（默认 true：E2E/本地页面需要；LOOPSOAR_STRICT_NET=1 关闭）。 */
  allowLoopback?: boolean;
}

/** 默认 DNS 解析：只把地址交给守卫，解析失败返回空数组（守卫按 fail-closed 拦截）。 */
async function defaultResolveIps(host: string): Promise<string[]> {
  try {
    const rows = await lookup(host, { all: true });
    return rows.map((row) => row.address);
  } catch {
    return [];
  }
}

/**
 * 模块级防重复注册：`onBeforeRequest` 是「追加监听」语义，重复注册会让同一个请求被判定多次，
 * 且没有任何 API 能单独移除——所以必须在进程内只装一次。
 */
let browserRequestGuardInstalled = false;

/**
 * 给浏览器 session 装一次出网守卫（两阶段：同步 URL 策略 → 异步 DNS 校验）。
 * 失败路径一律 cancel（fail-closed）；日志只打 host，避免把完整 URL 的敏感查询参数写进日志。
 */
function installBrowserRequestGuard(partitionSession: Electron.Session, options: ElectronBrowserHostOptions): void {
  if (browserRequestGuardInstalled) return;
  browserRequestGuardInstalled = true;

  const policy = createBrowserRequestPolicy({ allowLoopback: options.allowLoopback });
  const check = createBrowserRequestChecker({
    resolveIps: options.resolveIps ?? defaultResolveIps,
    policy,
  });

  partitionSession.webRequest.onBeforeRequest((details, callback) => {
    // Electron 要求每个请求恰好回调一次：用 finished 守卫防止「resolve 后 catch 又调一次」。
    let finished = false;
    const done = (response: { cancel?: boolean }): void => {
      if (finished) return;
      finished = true;
      try {
        callback(response);
      } catch {
        // 请求可能已随标签销毁而结束，忽略
      }
    };
    void check(details.url)
      .then((decision) => {
        if (decision.action === "allow") {
          done({});
          return;
        }
        console.warn(`[browser-guard] 拦截请求 host=${browserRequestHost(details.url)} reason=${decision.reason ?? "未说明"}`);
        done({ cancel: true });
      })
      .catch(() => done({ cancel: true }));
  });
}

export function createElectronBrowserHost(
  getWindow: () => BrowserWindow | null,
  openInNewTab: (url: string) => void,
  options: ElectronBrowserHostOptions = {},
): BrowserHost {
  // 守卫必须在任何 WebContentsView 创建之前装好（否则首批请求会漏检）；
  // 只在浏览器分区上挂，不影响主窗口（loopsoar://）与下载。
  installBrowserRequestGuard(session.fromPartition(SESSION_PARTITION), options);
  return new BrowserHost({
    initialSessionId: options.initialSessionId,
    onSessionStateChanged: options.onSessionStateChanged,
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
