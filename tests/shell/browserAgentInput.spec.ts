/**
 * Agent 真实输入注入（BrowserHost.agentClick / agentKey）：
 *   · 坐标按页面缩放换算（CSS 像素 → 视图像素）；
 *   · 先置位 __loopsoarAgentDriving 放行接管锁，再派发 mouseMove/mouseDown/mouseUp；
 *   · 视图不支持 sendInputEvent 时返回 false（调用方回退到脚本点击）。
 */
import { describe, expect, it } from "vitest";
import { BrowserHost, type HostView } from "../../packages/shell/src/main/browserHost.ts";

interface FakeView extends HostView {
  events: Record<string, unknown>[];
  scripts: string[];
}

function makeHost(options: { zoom?: number; input?: boolean; onViewLayout?: (rect: { x: number; y: number; width: number; height: number } | null) => void } = {}) {
  const views: FakeView[] = [];
  let lastBounds: { x: number; y: number; width: number; height: number } | null = null;
  const host = new BrowserHost({
    initialSessionId: "s1",
    onViewLayout: options.onViewLayout,
    createView: (): HostView => {
      const view = {
        events: [] as Record<string, unknown>[],
        scripts: [] as string[],
        setBounds(bounds: { x: number; y: number; width: number; height: number }) {
          lastBounds = bounds;
        },
        setVisible() {},
        webContents: {
          async loadURL() {},
          getURL: () => "https://example.com/",
          async executeJavaScript(code: string) {
            view.scripts.push(code);
            return 3;
          },
          ...(options.input === false
            ? {}
            : {
                sendInputEvent(event: Record<string, unknown>) {
                  view.events.push(event);
                },
                getZoomFactor: () => options.zoom ?? 1,
              }),
          on() {},
          async capturePage() {
            return { toPNG: () => Buffer.from("png") };
          },
        },
      } as unknown as FakeView;
      views.push(view);
      return view;
    },
    attachView: () => {},
    detachView: () => {},
    getWindowSize: () => ({ width: 1360, height: 860 }),
  });
  return { host, views, lastBounds: () => lastBounds };
}

describe("Agent 真实输入", () => {
  it("agentClick：按缩放换算坐标并派发可信鼠标事件；先放行接管锁", async () => {
    const { host, views } = makeHost({ zoom: 1.5 });
    const created = await host.newTab("https://example.com/", "s1", "agent");
    expect(created.tabId).toBeTruthy();

    const ok = await host.agentClick("s1", created.tabId, { x: 100, y: 50 });
    expect(ok).toBe(true);
    const view = views[0];
    expect(view.events.map((event) => event.type)).toEqual(["mouseMove", "mouseDown", "mouseUp"]);
    expect(view.events[0]).toMatchObject({ x: 150, y: 75 });
    expect(view.events[1]).toMatchObject({ x: 150, y: 75, button: "left", clickCount: 1 });
    // 驱动标志先置位（锁放行），事件之后异步清除
    expect(view.scripts.some((script) => script.includes("__loopsoarAgentDriving = true"))).toBe(true);
    expect(host.getPageZoom("s1", created.tabId)).toBe(1.5);
  });

  it("agentKey：命名键派发 keyDown/keyUp，单字符额外派发 char", async () => {
    const { host, views } = makeHost();
    const created = await host.newTab("https://example.com/", "s1", "agent");
    expect(await host.agentKey("s1", created.tabId, "Enter")).toBe(true);
    expect(views[0].events.map((event) => [event.type, event.keyCode])).toEqual([
      ["keyDown", "Enter"],
      ["keyUp", "Enter"],
    ]);

    views[0].events.length = 0;
    expect(await host.agentKey("s1", created.tabId, "a")).toBe(true);
    expect(views[0].events.map((event) => [event.type, event.keyCode])).toEqual([
      ["keyDown", "a"],
      ["char", "a"],
      ["keyUp", "a"],
    ]);
    // 非白名单命名键：拒绝（返回 false，调用方报 INVALID_KEY）
    expect(await host.agentKey("s1", created.tabId, "Control")).toBe(false);
  });

  it("onViewLayout：可见网页推送视图矩形（与原生视图同源），没有网页时清空", async () => {
    let layout: { x: number; y: number; width: number; height: number } | null | undefined;
    const { host, lastBounds } = makeHost({ onViewLayout: (rect) => { layout = rect; } });
    const created = await host.newTab("https://example.com/", "s1", "agent");
    expect(created.ok).toBe(true);
    expect(layout).toEqual(lastBounds());
    expect(layout?.width ?? 0).toBeGreaterThan(0);
    await host.closeAll();
    expect(layout).toBeNull();
  });

  it("视图不支持 sendInputEvent：返回 false（调用方回退到脚本点击）", async () => {
    const { host } = makeHost({ input: false });
    const created = await host.newTab("https://example.com/", "s1", "agent");
    expect(await host.agentClick("s1", created.tabId, { x: 10, y: 10 })).toBe(false);
    expect(await host.agentKey("s1", created.tabId, "Enter")).toBe(false);
  });
});
