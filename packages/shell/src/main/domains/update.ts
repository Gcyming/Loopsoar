/**
 * 自动更新域：IPC 通道 + 装配辅助。
 *
 * 拆出原因：主进程入口是组合根，更新装配（创建 updater、注册 4 个通道、启动延迟检查）
 * 属于可独立阅读/测试的编排；入口只留一行调用。
 */
import { createAutoUpdate, type AutoUpdateHandle } from "../autoUpdate.js";
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";

export interface UpdateDomainDeps extends TrustedIpcDeps {
  updater: AutoUpdateHandle;
}

export function registerUpdateDomain(deps: UpdateDomainDeps): void {
  handleTrusted(deps, "update:status", () => deps.updater.status());
  handleTrusted(deps, "update:check", () => deps.updater.check());
  handleTrusted(deps, "update:download", () => deps.updater.download());
  handleTrusted(deps, "update:install", () => deps.updater.install());
}

/** 入口用的一步装配（懒取 shutdown：入口的关机处理器在装配之后才创建）。 */
export function installAutoUpdateForApp(options: {
  deps: TrustedIpcDeps;
  version: string;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  push: (event: string, payload: unknown) => void;
  hasActiveStreams: () => boolean;
  getShutdown: () => (() => Promise<void>) | null;
  feedUrl?: string;
}): AutoUpdateHandle {
  const updater = createAutoUpdate({
    isPackaged: options.isPackaged,
    currentVersion: options.version,
    platform: options.platform,
    pushEvent: (snapshot) => options.push("update:state", snapshot),
    hasActiveStreams: options.hasActiveStreams,
    shutdown: () => options.getShutdown()?.() ?? Promise.resolve(),
    feedUrl: options.feedUrl,
  });
  registerUpdateDomain({ ...options.deps, updater });
  updater.scheduleStartupCheck();
  return updater;
}

/** 入口用的一步装配：创建 updater + 注册通道 + 延迟检查（默认 60s）。 */
export function installAutoUpdate(options: {
  deps: TrustedIpcDeps;
  version: string;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  push: (event: string, payload: unknown) => void;
  hasActiveStreams: () => boolean;
  shutdown: () => Promise<void>;
  feedUrl?: string;
  delayMs?: number;
}): AutoUpdateHandle {
  const updater = createAutoUpdate({
    isPackaged: options.isPackaged,
    currentVersion: options.version,
    platform: options.platform,
    pushEvent: (snapshot) => options.push("update:state", snapshot),
    hasActiveStreams: options.hasActiveStreams,
    shutdown: options.shutdown,
    feedUrl: options.feedUrl,
  });
  registerUpdateDomain({ ...options.deps, updater });
  updater.scheduleStartupCheck(options.delayMs);
  return updater;
}
