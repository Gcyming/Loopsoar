/**
 * 布局契约 + 导航校验（单一产地，纯函数）。
 */
import { describe, expect, it } from "vitest";
import { LAYOUT, computeBrowserViewBounds } from "../../packages/contracts/src/layout.ts";
import { normalizeNavigateUrl } from "../../packages/contracts/src/navigation.ts";

describe("布局契约", () => {
  it("常量与 S2 规格一致", () => {
    expect(LAYOUT.TITLE_BAR_HEIGHT).toBe(36);
    expect(LAYOUT.TOP_BAR_HEIGHT).toBe(48);
    expect(LAYOUT.SIDEBAR_WIDTH).toBe(320);
    expect(LAYOUT.STATUS_BAR_HEIGHT).toBe(32);
  });

  it("原生浏览器视图避开标题栏/顶栏/侧栏/状态条", () => {
    expect(computeBrowserViewBounds({ width: 1280, height: 800 })).toEqual({
      x: 0,
      y: 118,
      width: 960,
      height: 650,
    });
  });

  it("窗口过小时钳制为 0（不产生负尺寸）", () => {
    expect(computeBrowserViewBounds({ width: 100, height: 40 })).toEqual({
      x: 0,
      y: 118,
      width: 0,
      height: 0,
    });
  });
});

describe("导航 URL 校验（UI 与主进程共用）", () => {
  it("无 scheme 补 https", () => {
    expect(normalizeNavigateUrl("example.com")).toEqual({ ok: true, url: "https://example.com/" });
  });

  it("https 原样通过", () => {
    expect(normalizeNavigateUrl("https://loopsoar.local/docs")).toEqual({
      ok: true,
      url: "https://loopsoar.local/docs",
    });
  });

  it("拒绝 javascript:/file:/data: 等危险协议", () => {
    expect(normalizeNavigateUrl("javascript:alert(1)").ok).toBe(false);
    expect(normalizeNavigateUrl("file:///C:/Windows/win.ini").ok).toBe(false);
    expect(normalizeNavigateUrl("data:text/html,<h1>x</h1>").ok).toBe(false);
    expect(normalizeNavigateUrl("about:blank").ok).toBe(false);
  });

  it("空地址拒绝", () => {
    expect(normalizeNavigateUrl("   ").ok).toBe(false);
  });
});
