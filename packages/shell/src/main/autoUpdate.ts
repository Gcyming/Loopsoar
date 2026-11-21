/**
 * 自动更新（发布阶段 §6.2）：electron-updater + NSIS 全量包。
 *
 * 硬约束（与发布门一致）：
 *   · 只在打包态启用；开发态直接 disabled；
 *   · 启动后延迟检查，绝不阻塞主窗口（默认 60s，可由调用方覆盖）；
 *   · 自动下载关闭：发现新版本只通知，用户确认后才下载；
 *   · 下载完成也不静默重启：用户确认、且没有 Agent 回合在跑，才安装；
 *   · 更新前走 shutdown（落盘会话/浏览器状态、杀后台任务），复用既有退出清理；
 *   · 任何异常都只进入 error 状态，不影响应用使用。
 */
import { app } from "electron";
import { autoUpdater } from "electron-updater";
import { canInstallUpdate } from "./updatePolicy.js";

export type UpdateState =
  | "disabled"
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error";

export interface UpdateSnapshot {
  state: UpdateState;
  /** 可用/已下载的版本号。 */
  version?: string;
  /** 下载进度 0-100。 */
  percent?: number;
  error?: string;
  /** 最近一次检查时间（ISO）。 */
  checkedAt?: string;
}

export interface AutoUpdateDeps {
  isPackaged: boolean;
  currentVersion: string;
  platform: NodeJS.Platform;
  /** 推送状态到渲染层（事件 update:state）。 */
  pushEvent(snapshot: UpdateSnapshot): void;
  /** 是否有 Agent 回合在跑（有则拒绝安装）。 */
  hasActiveStreams(): boolean;
  /** 退出清理（落盘/杀子进程）；幂等。 */
  shutdown(): Promise<void>;
  /** 更新下载源覆盖（本地联调/灰度用）；生产走 app-update.yml。 */
  feedUrl?: string;
  log?(message: string): void;
}

export interface AutoUpdateHandle {
  status(): UpdateSnapshot;
  check(): Promise<UpdateSnapshot>;
  download(): Promise<UpdateSnapshot>;
  install(): Promise<{ ok: boolean; error?: string }>;
  /** 是否正在安装更新（退出守卫据此放行退出流程）。 */
  isInstalling(): boolean;
  /** 启动后延迟检查（不阻塞首帧）。 */
  scheduleStartupCheck(delayMs?: number): void;
}

const DEFAULT_CHECK_DELAY_MS = 60_000;

export function createAutoUpdate(deps: AutoUpdateDeps): AutoUpdateHandle {
  const log = deps.log ?? ((message: string) => console.log(message));
  let snapshot: UpdateSnapshot = {
    state: deps.isPackaged && deps.platform === "win32" ? "idle" : "disabled",
  };
  let installing = false;

  const set = (next: UpdateSnapshot): UpdateSnapshot => {
    snapshot = { ...next, checkedAt: next.checkedAt ?? snapshot.checkedAt };
    try {
      deps.pushEvent(snapshot);
    } catch {
      // 渲染层已关闭：状态仍在内存里
    }
    return snapshot;
  };

  const enabled = snapshot.state !== "disabled";
  if (enabled) {
    autoUpdater.autoDownload = false;
    // 必须为 false：安装只能由用户确认触发，不能随普通退出顺带执行。
    autoUpdater.autoInstallOnAppQuit = false;
    try {
      autoUpdater.logger = {
        info: (message?: unknown) => log(`[update] ${String(message ?? "")}`),
        warn: (message?: unknown) => log(`[update] warn ${String(message ?? "")}`),
        error: (message?: unknown) => log(`[update] error ${String(message ?? "")}`),
        debug: () => undefined,
      } as unknown as typeof autoUpdater.logger;
    } catch {
      // 自定义 logger 失败不影响更新
    }
    if (deps.feedUrl) {
      try {
        autoUpdater.setFeedURL({ provider: "generic", url: deps.feedUrl });
      } catch (err) {
        log(`[update] 更新源设置失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    autoUpdater.on("checking-for-update", () => set({ state: "checking" }));
    autoUpdater.on("update-available", (info) => set({ state: "available", version: info.version }));
    autoUpdater.on("update-not-available", () => set({ state: "not-available", checkedAt: new Date().toISOString() }));
    autoUpdater.on("download-progress", (progress) =>
      set({ state: "downloading", percent: Math.round(progress.percent), version: snapshot.version }),
    );
    autoUpdater.on("update-downloaded", (info) => set({ state: "downloaded", version: info.version }));
    autoUpdater.on("error", (err) => set({ state: "error", error: err instanceof Error ? err.message : String(err) }));
  }

  const check = async (): Promise<UpdateSnapshot> => {
    if (!enabled) return snapshot;
    try {
      set({ state: "checking" });
      await autoUpdater.checkForUpdates();
    } catch (err) {
      set({ state: "error", error: err instanceof Error ? err.message : String(err) });
    }
    return snapshot;
  };

  const download = async (): Promise<UpdateSnapshot> => {
    if (!enabled || snapshot.state !== "available") return snapshot;
    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      set({ state: "error", error: err instanceof Error ? err.message : String(err) });
    }
    return snapshot;
  };

  const install = async (): Promise<{ ok: boolean; error?: string }> => {
    const decision = canInstallUpdate(snapshot, deps.hasActiveStreams());
    if (!decision.ok) return decision;
    installing = true;
    set({ state: "installing", version: snapshot.version });
    try {
      // 先落盘/清理，再交给 electron-updater 启动安装器并退出。
      await deps.shutdown();
    } catch {
      // 清理失败不阻断安装（更新包已下载）
    }
    autoUpdater.quitAndInstall(false, true);
    return { ok: true };
  };

  return {
    status: () => snapshot,
    check,
    download,
    install,
    isInstalling: () => installing,
    scheduleStartupCheck: (delayMs?: number) => {
      if (!enabled) return;
      const delay = delayMs ?? DEFAULT_CHECK_DELAY_MS;
      const timer = setTimeout(() => {
        void check();
      }, delay);
      timer.unref?.();
    },
  };
}

/** 应用是否支持自动更新（打包态 + Windows）。 */
export function autoUpdateSupported(): boolean {
  return app.isPackaged && process.platform === "win32";
}
