/**
 * BrowserHost（多标签）：懒创建 / URL 白名单 / 标签切换 / 浮层遮挡 / 布局同步（假 View，无 electron）。
 */
import { describe, expect, it } from "vitest";
import { BrowserHost, type HostView } from "../../packages/shell/src/main/browserHost.ts";

interface FakeView extends HostView {
  bounds: { x: number; y: number; width: number; height: number } | null;
  navigated: string[];
  visible: boolean;
  closed: boolean;
}

function makeHost(size = { width: 1360, height: 860 }) {
  const created: FakeView[] = [];
  const host = new BrowserHost({
    createView: (): HostView => {
      const view: FakeView = {
        bounds: null,
        navigated: [],
        visible: true,
        closed: false,
        setBounds(b) {
          view.bounds = b;
        },
        setVisible(v) {
          view.visible = v;
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
            if (code.includes("document.title")) return "示例页面";
            if (code.includes("location.href")) {
              return { url: "https://example.com/", title: "Example", text: "hi", elements: [] };
            }
            return 3;
          },
          on() {},
        },
      };
      created.push(view);
      return view;
    },
    attachView: () => {},
    detachView: (view) => {
      (view as FakeView).closed = true;
    },
    getWindowSize: () => size,
  });
  return { host, created };
}

describe("BrowserHost（多标签）", () => {
  it("懒创建：未导航前没有标签", async () => {
    const { host, created } = makeHost();
    expect(host.hasAnyTab()).toBe(false);
    expect(created.length).toBe(0);
    expect(await host.snapshot()).toBeNull();
    expect(await host.screenshot()).toBeNull();
  });

  it("导航创建首个标签，并对齐布局区域（含标签栏偏移）", async () => {
    const { host, created } = makeHost();
    const result = await host.navigate("example.com");
    expect(result.ok).toBe(true);
    expect(host.hasAnyTab()).toBe(true);
    expect(host.listTabs().length).toBe(1);
    expect(host.listTabs()[0].active).toBe(true);
    expect(created[0].navigated[0]).toBe("https://example.com/");
    // 1360x860：y = 36+48+34 = 118，height = 860-36-34-48-32 = 710
    expect(created[0].bounds).toEqual({ x: 0, y: 118, width: 1000, height: 710 });
  });

  it("新建标签并切换：同一时刻只有一个活动标签可见", async () => {
    const { host, created } = makeHost();
    await host.navigate("https://a.example");
    const id2 = (await host.newTab("https://b.example")).tabId;
    expect(host.listTabs().length).toBe(2);
    expect(host.listTabs().find((t) => t.active)?.id).toBe(id2);
    expect(created.filter((v) => v.visible).length).toBe(1);
    const first = host.listTabs().find((t) => t.id !== id2)!.id;
    expect(host.selectTab(first)).toBe(true);
    expect(host.listTabs().find((t) => t.active)?.id).toBe(first);
    expect(created.filter((v) => v.visible).length).toBe(1);
  });

  it("空白新标签不显示原生视图（避免透明视图吞掉新建页鼠标事件）", async () => {
    const { host, created } = makeHost();
    const r = await host.newTab();
    expect(r.ok).toBe(true);
    expect(host.listTabs().length).toBe(1);
    const first = created[0];
    expect(first.visible).toBe(false);
    await host.navigate("https://example.com", r.tabId);
    expect(created[0].visible).toBe(true);
  });

  it("危险协议导航被拒绝，且不创建标签", async () => {
    const { host, created } = makeHost();
    const result = await host.navigate("javascript:alert(1)");
    expect(result.ok).toBe(false);
    expect(created.length).toBe(0);
  });

  it("浮层打开时隐藏原生视图（修复网页遮挡应用弹窗）", async () => {
    const { host, created } = makeHost();
    await host.navigate("https://example.com");
    host.setOverlayOpen(true);
    expect(created[0].visible).toBe(false);
    host.setOverlayOpen(false);
    expect(created[0].visible).toBe(true);
  });

  it("关闭标签：视图被销毁，活动标签回落到剩余标签", async () => {
    const { host, created } = makeHost();
    await host.navigate("https://a.example");
    const id2 = (await host.newTab("https://b.example")).tabId;
    expect(await host.closeTab(id2)).toBe(true);
    expect(host.listTabs().length).toBe(1);
    expect(created.some((v) => v.closed)).toBe(true);
    expect(host.listTabs()[0].active).toBe(true);
  });

  it("快照/截图在有活动标签后可用", async () => {
    const { host } = makeHost();
    await host.navigate("https://example.com");
    expect(await host.snapshot()).not.toBeNull();
    expect(await host.screenshot()).toBeTruthy();
  });

  it("窗口缩放 → syncBounds 重新对齐", async () => {
    const state = { width: 1360, height: 860 };
    const created: FakeView[] = [];
    const host = new BrowserHost({
      createView: () => {
        const view = {
          bounds: null as null | { x: number; y: number; width: number; height: number },
          setBounds(b: { x: number; y: number; width: number; height: number }) {
            view.bounds = b;
          },
          setVisible() {},
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
        created.push(view as unknown as FakeView);
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
    expect(created[0].bounds).toEqual({ x: 0, y: 118, width: 640, height: 550 });
  });
});

describe("BrowserHost（地址与网页强绑定）", () => {
  function makeHostWithEvents() {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const host = new BrowserHost({
      createView: () =>
        ({
          setBounds() {},
          setVisible() {},
          webContents: {
            async loadURL() {},
            getURL: () => "https://example.com/",
            async capturePage() {
              return { toPNG: () => Buffer.from("") };
            },
            async executeJavaScript(code: string) {
              return code.includes("document.title") ? "Example" : 1;
            },
            on(event: string, cb: (...args: unknown[]) => void) {
              handlers.set(event, cb);
            },
          },
        }) as unknown as HostView,
      attachView: () => {},
      detachView: () => {},
      getWindowSize: () => ({ width: 1360, height: 860 }),
    });
    return { host, handlers };
  }

  it("网页内点击链接（did-navigate）→ 标签 URL/历史/地址同步数据更新", async () => {
    const { host, handlers } = makeHostWithEvents();
    await host.navigate("https://example.com/");
    handlers.get("did-navigate")?.("https://example.com/next");
    const tab = host.listTabs()[0];
    expect(tab.url).toBe("https://example.com/next");
    expect(tab.canBack).toBe(true);
  });

  it("页面标题变化（page-title-updated）→ 标签标题同步", async () => {
    const { host, handlers } = makeHostWithEvents();
    await host.navigate("https://example.com/");
    handlers.get("page-title-updated")?.("新标题 - 站点");
    expect(host.listTabs()[0].title).toBe("新标题 - 站点");
  });
});
