/**
 * BrowserHost：懒创建 / URL 白名单 / 布局同步（假 View，无 electron）。
 */
import { describe, expect, it } from "vitest";
import { BrowserHost, type HostView } from "../../packages/shell/src/main/browserHost.ts";

interface FakeView extends HostView {
  bounds: { x: number; y: number; width: number; height: number } | null;
  navigated: string[];
}

function makeHost(options: { size?: { width: number; height: number } } = {}) {
  const created: FakeView[] = [];
  const size = options.size ?? { width: 1360, height: 860 };
  const host = new BrowserHost({
    createView: (): HostView => {
      const view: FakeView = {
        bounds: null,
        navigated: [],
        setBounds(b) {
          view.bounds = b;
        },
        webContents: {
          async loadURL(url: string) {
            view.navigated.push(url);
          },
          getURL: () => view.navigated[view.navigated.length - 1] ?? "",
          async capturePage() {
            return { toPNG: () => Buffer.from("png") };
          },
          async executeJavaScript(code: string) {
            if (code.includes("querySelectorAll")) return 3;
            if (code.includes("location.href")) {
              return { url: "https://example.com/", title: "Example", text: "hi", elements: [] };
            }
            return true;
          },
          on() {},
        },
      };
      created.push(view);
      return view;
    },
    attachView: () => {},
    detachView: () => {},
    getWindowSize: () => size,
  });
  return { host, created, size };
}

describe("BrowserHost", () => {
  it("懒创建：未导航前不建视图", async () => {
    const { host, created } = makeHost();
    expect(host.hasView()).toBe(false);
    expect(created.length).toBe(0);
    expect(await host.snapshot()).toBeNull();
    expect(await host.screenshot()).toBeNull();
  });

  it("导航后创建视图并对齐布局区域", async () => {
    const { host, created } = makeHost();
    const result = await host.navigate("example.com");
    expect(result.ok).toBe(true);
    expect(host.hasView()).toBe(true);
    expect(created.length).toBe(1);
    expect(created[0].navigated[0]).toBe("https://example.com/");
    expect(created[0].bounds).toEqual({ x: 0, y: 84, width: 1040, height: 744 });
  });

  it("危险协议导航被拒绝，且不创建视图", async () => {
    const { host, created } = makeHost();
    const result = await host.navigate("javascript:alert(1)");
    expect(result.ok).toBe(false);
    expect(created.length).toBe(0);
  });

  it("窗口缩放 → syncBounds 重新对齐", async () => {
    const state = { width: 1360, height: 860 };
    const created: HostView[] = [];
    const host = new BrowserHost({
      createView: () => {
        const view = {
          bounds: null as null | { x: number; y: number; width: number; height: number },
          setBounds(b: { x: number; y: number; width: number; height: number }) {
            view.bounds = b;
          },
          webContents: {
            async loadURL() {},
            getURL: () => "",
            async capturePage() {
              return { toPNG: () => Buffer.from("") };
            },
            async executeJavaScript() {
              return 1;
            },
            on() {},
          },
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        created.push(view as any);
        return view as unknown as HostView;
      },
      attachView: () => {},
      detachView: () => {},
      getWindowSize: () => ({ width: state.width, height: state.height }),
    });
    await host.navigate("https://example.com");
    state.width = 1000;
    state.height = 700;
    host.syncBounds();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((created[0] as any).bounds).toEqual({ x: 0, y: 84, width: 680, height: 584 });
  });

  it("快照/截图在有视图后可用；close 后不可用", async () => {
    const { host } = makeHost();
    await host.navigate("https://example.com");
    expect(await host.snapshot()).not.toBeNull();
    expect(await host.screenshot()).toBeTruthy();
    await host.close();
    expect(host.hasView()).toBe(false);
    expect(await host.snapshot()).toBeNull();
  });
});
