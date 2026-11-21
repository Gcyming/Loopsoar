import { describe, expect, it, vi } from "vitest";
import {
  createBrowserExternalLinks,
  httpUrlFromArg,
  httpUrlsFromArgv,
  type BrowserHostLike,
  type BrowserWindowLike,
} from "../../packages/shell/src/main/browserExternalLinks.js";

function fakeWindow(): BrowserWindowLike & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    show: () => calls.push("show"),
    focus: () => calls.push("focus"),
    isMinimized: () => false,
    restore: () => calls.push("restore"),
  };
}

function fakeHost(): BrowserHostLike & {
  calls: { url: string; sessionId?: string; origin?: string; forceNew?: boolean }[];
  shown: number;
} {
  const calls: { url: string; sessionId?: string; origin?: string; forceNew?: boolean }[] = [];
  return {
    calls,
    shown: 0,
    showUserTabs() {
      this.shown += 1;
    },
    async newTab(url, sessionId, origin, options) {
      calls.push({ url, sessionId, origin, forceNew: options?.forceNew });
      return { ok: true };
    },
  };
}

describe("默认浏览器 URL 入口", () => {
  it("只接受 http/https，并规范化 URL", () => {
    expect(httpUrlFromArg("https://example.com/a")).toBe("https://example.com/a");
    expect(httpUrlFromArg("HTTP://EXAMPLE.COM")).toBe("http://example.com/");
    expect(httpUrlFromArg("file:///C:/secret")).toBeNull();
    expect(httpUrlFromArg("javascript:alert(1)")).toBeNull();
    expect(httpUrlsFromArgv(["electron.exe", "https://a.test", "https://a.test", "https://b.test"])).toEqual([
      "https://a.test/",
      "https://b.test/",
    ]);
  });

  it("BrowserHost 未就绪时先排队，drain 后开在用户全局标签并聚焦窗口", async () => {
    const host = fakeHost();
    const win = fakeWindow();
    let ready = false;
    const links = createBrowserExternalLinks({
      appName: "Loopsoar",
      executablePath: "C:\\Loopsoar.exe",
      packaged: true,
      platform: "win32",
      initialArgv: ["Loopsoar.exe", "https://example.com"],
      userTabsSession: "__user_tabs__",
      register: false,
      getBrowserHost: () => (ready ? host : null),
      getMainWindow: () => win,
    });
    expect(host.calls).toEqual([]);
    ready = true;
    links.drain();
    await Promise.resolve();
    expect(host.shown).toBe(1);
    expect(host.calls[0]).toMatchObject({
      url: "https://example.com/",
      sessionId: "__user_tabs__",
      origin: "user",
      forceNew: true,
    });
    expect(win.calls).toEqual(["show", "focus"]);
  });

  it("第二实例参数到达时直接打开；非法 URL 不触发 BrowserHost", async () => {
    const host = fakeHost();
    const links = createBrowserExternalLinks({
      appName: "Loopsoar",
      executablePath: "C:\\Loopsoar.exe",
      packaged: true,
      platform: "win32",
      userTabsSession: "__user_tabs__",
      register: false,
      getBrowserHost: () => host,
      getMainWindow: () => fakeWindow(),
    });
    links.acceptArgs(["Loopsoar.exe", "file:///C:/secret"]);
    expect(host.shown).toBe(0);
    links.acceptArgs(["Loopsoar.exe", "http://127.0.0.1:3000/"]);
    await Promise.resolve();
    expect(host.shown).toBe(1);
    expect(host.calls[0]?.url).toBe("http://127.0.0.1:3000/");
  });

  it("注册关闭时不触碰注册表（测试/E2E 可显式关闭）", () => {
    const links = createBrowserExternalLinks({
      appName: "Loopsoar",
      executablePath: "C:\\Loopsoar.exe",
      packaged: true,
      platform: "win32",
      userTabsSession: "__user_tabs__",
      register: false,
      getBrowserHost: () => null,
      getMainWindow: () => null,
    });
    expect(links.registration).toBeNull();
    links.acceptUrl("https://example.com");
    expect(() => links.drain()).not.toThrow();
    vi.restoreAllMocks();
  });
});
