/**
 * 外部链接入口：默认浏览器把 http(s) URL 作为 argv / open-url 交给我们时，
 * 必须落到「用户全局标签」而不是当前 Agent 任务会话，否则用户会看到新页面被塞进后台。
 *
 * 与 browserRegistration 分开：注册决定「系统认不认识 Loopsoar」，本模块决定
 * 「认识之后 URL 是否真的能打开」。两者都不需要 import electron，便于纯 Node 单测。
 */
import { registerAsBrowser, type BrowserRegistrationResult } from "./browserRegistration.js";

export interface BrowserHostLike {
  showUserTabs(): void;
  newTab(
    url: string,
    sessionId?: string,
    origin?: "agent" | "user",
    options?: { forceNew?: boolean },
  ): Promise<unknown>;
}

export interface BrowserWindowLike {
  show(): void;
  focus(): void;
  isMinimized?(): boolean;
  restore?(): void;
}

export interface BrowserExternalLinksOptions {
  appName: string;
  executablePath: string;
  appPath?: string | null;
  packaged?: boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  initialArgv?: readonly string[];
  /** 用户全局标签的会话 id（由组合根传入，避免模块重复定义 USER_TABS_SESSION）。 */
  userTabsSession: string;
  getBrowserHost: () => BrowserHostLike | null;
  getMainWindow: () => BrowserWindowLike | null;
  /** 窗口被托盘关闭后再次收到 URL 时，组合根负责重建主窗口。 */
  ensureWindow?: () => BrowserWindowLike | null;
  /** 单测/特殊环境可关闭注册，避免测试写真实注册表。 */
  register?: boolean;
}

export interface BrowserExternalLinks {
  acceptArgs(argv: readonly string[]): void;
  acceptUrl(raw: string): void;
  /** 启动恢复完成后再调用；把启动早期邮箱里的 URL 补开。 */
  drain(): void;
  registration: BrowserRegistrationResult | null;
}

/** 只接受真实 http(s) URL；file/javascript/loopsoar 等一律不当作默认浏览器入口。 */
export function httpUrlFromArg(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/** 从 Electron 的 process.argv / second-instance argv 中提取 URL（保持参数顺序）。 */
export function httpUrlsFromArgv(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of argv) {
    const url = httpUrlFromArg(raw);
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
}

export function createBrowserExternalLinks(options: BrowserExternalLinksOptions): BrowserExternalLinks {
  const pending: string[] = [];
  const registration =
    options.register === false
      ? null
      : registerAsBrowser({
          appName: options.appName,
          executablePath: options.executablePath,
          appPath: options.appPath,
          packaged: options.packaged,
          platform: options.platform,
          env: options.env,
          description: `${options.appName} 浏览器与 Agent 工作台`,
        });

  if (registration && !registration.ok) {
    console.warn("[Loopsoar] 浏览器注册未完成：", registration.error);
  }

  function focusWindow(): void {
    const win = options.getMainWindow() ?? options.ensureWindow?.() ?? null;
    if (!win) return;
    try {
      if (win.isMinimized?.()) win.restore?.();
      win.show();
      win.focus();
    } catch {
      // 窗口正在销毁/重建：URL 已经交给 BrowserHost，下一次 focus 再补即可。
    }
  }

  function openNow(url: string): boolean {
    const host = options.getBrowserHost();
    if (!host) {
      pending.push(url);
      return false;
    }
    host.showUserTabs();
    void host.newTab(url, options.userTabsSession, "user", { forceNew: true }).catch(() => undefined);
    focusWindow();
    return true;
  }

  function acceptArgs(argv: readonly string[]): void {
    for (const url of httpUrlsFromArgv(argv)) {
      if (!openNow(url) && !pending.includes(url)) pending.push(url);
    }
  }

  function acceptUrl(raw: string): void {
    const url = httpUrlFromArg(raw);
    if (url && !openNow(url) && !pending.includes(url)) pending.push(url);
  }

  function drain(): void {
    if (pending.length === 0) return;
    const urls = pending.splice(0);
    for (const url of urls) {
      if (openNow(url)) continue;
      if (!pending.includes(url)) pending.push(url);
      break;
    }
  }

  acceptArgs(options.initialArgv ?? []);

  return { acceptArgs, acceptUrl, drain, registration };
}
