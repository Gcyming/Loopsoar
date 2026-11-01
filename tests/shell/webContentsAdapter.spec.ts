/**
 * WebContentsView 适配器：页面内导航回调、标题回调、页面缩放快捷键。
 */
import { describe, expect, it } from "vitest";
import { createWebContentsViewAdapter } from "../../packages/shell/src/browserAdapter/backends/webContentsView.ts";

function fakeView() {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  let zoom = 1;
  const view = {
    webContents: {
      async loadURL() {},
      getURL: () => "https://example.com/",
      async capturePage() {
        return { toPNG: () => Buffer.from("") };
      },
      async executeJavaScript() {
        return 1;
      },
      setZoomFactor(factor: number) {
        zoom = factor;
      },
      on(event: string, cb: (...args: unknown[]) => void) {
        handlers.set(event, cb);
      },
    },
  };
  return { view, handlers, zoom: () => zoom };
}

describe("WebContentsView 适配器", () => {
  it("页面导航/标题事件回调给外壳（标题取 args[1]，避免 [object Object]）", () => {
    const { view, handlers } = fakeView();
    const navigated: string[] = [];
    const titles: string[] = [];
    createWebContentsViewAdapter({ view, onNavigate: (url) => navigated.push(url), onTitle: (title) => titles.push(title) });
    // Electron 签名：(event, url, ...)
    handlers.get("did-navigate")?.({}, "https://example.com/next");
    handlers.get("page-title-updated")?.(new Event("x"), "真实标题");
    expect(navigated).toEqual(["https://example.com/next"]);
    expect(titles).toEqual(["真实标题"]);
  });

  it("Ctrl + = / - / 0 调整页面缩放并 preventDefault", () => {
    const { view, handlers, zoom } = fakeView();
    createWebContentsViewAdapter({ view });
    const input = (key: string) => {
      let prevented = false;
      const event = { preventDefault: () => { prevented = true; } };
      handlers.get("before-input-event")?.(event, { type: "keyDown", key, control: true });
      return prevented;
    };
    expect(input("=")).toBe(true);
    expect(zoom()).toBe(1.1);
    input("+");
    expect(zoom()).toBe(1.2);
    input("-");
    expect(zoom()).toBe(1.1);
    input("0");
    expect(zoom()).toBe(1);
  });
});
