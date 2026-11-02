/**
 * pageSave 域：注册 browser:savePage 通道（把当前标签页完整 HTML 存到磁盘）。
 *
 * 设计原则（与其它域一致）：
 *   · 参数校验只在契约层（SavePageSchema { tabId? }），域层只做转发与可读错误；
 *   · 失败用 { ok:false, error } 表达，不抛跨进程异常；
 *   · 不 import electron：页面抓取走 BrowserHost.executeScript，落盘走 node:fs（pageSave.ts）。
 */
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";
import type { BrowserHost } from "../browserHost.js";
import { saveActivePage, type SavePageResult } from "../pageSave.js";

export interface PageSaveDeps extends TrustedIpcDeps {
  browser?: BrowserHost;
  /** 数据目录（下载目录为空时的兜底）。 */
  dataDir: string;
  /** 下载目录：可传 getter，保存时读取最新偏好。 */
  downloadDir?: string | (() => string);
}

/** 解析当前保存目录（偏好随时可变，必须在执行时读取）。 */
function currentDownloadDir(downloadDir: PageSaveDeps["downloadDir"]): string {
  if (typeof downloadDir === "function") return String(downloadDir() ?? "").trim();
  return String(downloadDir ?? "").trim();
}

export function registerPageSaveDomain(deps: PageSaveDeps): void {
  handleTrusted(deps, "browser:savePage", async (payload): Promise<SavePageResult> => {
    if (!deps.browser) return { ok: false, error: "浏览器宿主未装配" };
    const browser = deps.browser;
    const request = (payload ?? {}) as { tabId?: string };

    // 保存取的是「活动标签」的可执行上下文：指定了非活动标签时先切过去。
    // （保存是用户/Agent 显式动作，切换标签的副作用可接受；同时校验 tabId 真的存在。）
    if (request.tabId) {
      const exists = browser.listTabs().some((tab) => tab.id === request.tabId);
      if (!exists) return { ok: false, error: `标签不存在：${request.tabId}` };
      if (browser.activeTabId() !== request.tabId) browser.selectTab(request.tabId);
    }

    return saveActivePage({
      host: browser,
      dataDir: deps.dataDir,
      downloadDir: currentDownloadDir(deps.downloadDir),
      sessionId: undefined,
    });
  });
}
