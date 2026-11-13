/**
 * 浏览器 preload（商店安装按钮拦截）的纯匹配逻辑：
 *   · Chrome / Edge 商店 URL 判定与扩展 ID 提取；
 *   · “添加至 Chrome / Add to Chrome / 获取” 等按钮文案匹配；
 *   · 负例：卸载/删除按钮不能误判。
 * 直接 require preload 的 CJS（Node 下没有 ipcRenderer，只导出纯函数）。
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const match = require("../../packages/shell/src/preload/browser.cjs") as {
  isWebStoreUrl: (url: string) => boolean;
  extractStoreId: (url: string) => string | null;
  isInstallButtonText: (text: string) => boolean;
};

const CHROME_ID = "aapbdbdomjkkjkaonfhkkikfgjllcleb";
const EDGE_ID = "eimadpbcbfnmbkopoojfekhnkhdbieeh";

describe("浏览器 preload · 商店匹配", () => {
  it("识别 Chrome / Edge 商店 URL", () => {
    expect(match.isWebStoreUrl("https://chromewebstore.google.com/detail/x/" + CHROME_ID)).toBe(true);
    expect(match.isWebStoreUrl("https://chrome.google.com/webstore/detail/" + CHROME_ID)).toBe(true);
    expect(match.isWebStoreUrl("https://microsoftedge.microsoft.com/addons/detail/" + EDGE_ID)).toBe(true);
    expect(match.isWebStoreUrl("https://example.com/")).toBe(false);
    expect(match.isWebStoreUrl("not a url")).toBe(false);
  });

  it("从详情页 URL 提取扩展 ID", () => {
    expect(match.extractStoreId("https://chromewebstore.google.com/detail/name/" + CHROME_ID)).toBe(CHROME_ID);
    expect(match.extractStoreId("https://chromewebstore.google.com/detail/" + CHROME_ID)).toBe(CHROME_ID);
    expect(match.extractStoreId("https://microsoftedge.microsoft.com/addons/detail/name/" + EDGE_ID)).toBe(EDGE_ID);
    expect(match.extractStoreId("https://example.com/detail/" + CHROME_ID)).toBe(CHROME_ID);
    expect(match.extractStoreId("https://chromewebstore.google.com/")).toBeNull();
  });

  it("识别安装按钮文案，排除卸载/删除", () => {
    expect(match.isInstallButtonText("Add to Chrome")).toBe(true);
    expect(match.isInstallButtonText("添加至 Chrome")).toBe(true);
    expect(match.isInstallButtonText("添加到 Chrome")).toBe(true);
    expect(match.isInstallButtonText("Get")).toBe(false); // 商店的 Get 无上下文时太宽泛，依赖 aria 文案
    expect(match.isInstallButtonText("获取")).toBe(true);
    expect(match.isInstallButtonText("Install extension")).toBe(true);
    expect(match.isInstallButtonText("Remove from Chrome")).toBe(false);
    expect(match.isInstallButtonText("卸载")).toBe(false);
    expect(match.isInstallButtonText("")).toBe(false);
  });
});
