/**
 * 导航 Referer 兼容：程序化导航要模仿用户点击；防盗链下载站（CLDisk）必须带来源域 Referer，
 * 否则 WAF 直接 403（实测：空 Referer → 403；目标站 origin → 200）。
 */
import { describe, expect, it } from "vitest";
import {
  downloadCompatibleReferer,
  isDownloadHost,
  refererForNavigation,
} from "../../packages/shell/src/main/browserNavigationSupport.ts";

describe("isDownloadHost", () => {
  it("识别下载域及其子域", () => {
    expect(isDownloadHost("https://d0.cldisk.com/download/x")).toBe(true);
    expect(isDownloadHost("https://www.cldisk.com/a")).toBe(true);
    expect(isDownloadHost("https://cldisk.com/a")).toBe(true);
    expect(isDownloadHost("https://clisk.com/a")).toBe(true);
  });

  it("不误伤相似域名", () => {
    expect(isDownloadHost("https://notcldisk.com/a")).toBe(false);
    expect(isDownloadHost("https://cldisk.com.evil.example/a")).toBe(false);
    expect(isDownloadHost("not a url")).toBe(false);
  });
});

describe("downloadCompatibleReferer", () => {
  it("下载域返回目标站 origin（WAF 白名单放行）", () => {
    expect(downloadCompatibleReferer("https://d0.cldisk.com/download/x?at_=1")).toBe("https://d0.cldisk.com/");
  });

  it("普通站点不补 Referer", () => {
    expect(downloadCompatibleReferer("https://example.com/a")).toBeUndefined();
    expect(downloadCompatibleReferer("not a url")).toBeUndefined();
  });
});

describe("refererForNavigation", () => {
  it("同源给完整路径，跨源也给完整 URL（含查询串、不含 hash）", () => {
    expect(refererForNavigation("https://a.example/page?q=1#x", "https://a.example/next")).toBe(
      "https://a.example/page?q=1",
    );
    expect(refererForNavigation("https://a.example/page?q=1", "https://b.example/dl")).toBe(
      "https://a.example/page?q=1",
    );
  });

  it("非 http(s)、同 URL 无法给 Referer", () => {
    expect(refererForNavigation("file:///a", "https://b.example/")).toBeUndefined();
    expect(refererForNavigation("https://a.example/", "https://a.example/")).toBeUndefined();
  });
});
