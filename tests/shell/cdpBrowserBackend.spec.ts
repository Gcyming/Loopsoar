import { describe, expect, it } from "vitest";
import { CdpBrowserBackend, createCdpBrowserBackendFromEnv, type CdpTransport } from "../../packages/shell/src/main/cdpBrowserBackend.ts";

/** 只验证 CDP 命令映射的假 transport；真实 WebSocket 由 createWebSocketTransport 承担。 */
function fakeTransport(): { transport: CdpTransport; calls: Array<{ method: string; params?: Record<string, unknown>; sessionId?: string }> } {
  const calls: Array<{ method: string; params?: Record<string, unknown>; sessionId?: string }> = [];
  const transport: CdpTransport = {
    async send(method, params = {}, sessionId) {
      calls.push({ method, params, ...(sessionId ? { sessionId } : {}) });
      if (method === "Target.createTarget") return { targetId: "target-1" };
      if (method === "Target.attachToTarget") return { sessionId: "session-1" };
      if (method === "Runtime.evaluate") {
        const expression = String(params.expression ?? "");
        if (expression.includes("loopsoar:snapshot")) {
          return {
            result: {
              value: {
                url: "https://example.com/",
                title: "示例页",
                text: "正文",
                elements: [{ tag: "button", role: "button", name: "点我", selector: "#go" }],
                elementTotal: 1,
              },
            },
          };
        }
        if (expression === "document.readyState") return { result: { value: "complete" } };
        if (expression.includes("innerWidth")) return { result: { value: { x: 200, y: 100 } } };
        if (expression.includes("location.href")) {
          return { result: { value: { url: "https://example.com/", title: "示例页", ready: "complete" } } };
        }
        return { result: { value: null } };
      }
      if (method === "Page.captureScreenshot") return { data: "cG5n" };
      if (method === "Page.getNavigationHistory") {
        return { currentIndex: 1, entries: [{ id: 1 }, { id: 2 }] };
      }
      return {};
    },
    close() {},
  };
  return { transport, calls };
}

describe("CdpBrowserBackend（P1-3 第二后端）", () => {
  it("navigate + snapshot 复用 refs 契约并返回 tabToken", async () => {
    const { transport, calls } = fakeTransport();
    const backend = new CdpBrowserBackend("ws://fake", { transport, loadTimeoutMs: 500 });
    const nav = await backend.navigate("https://example.com/");
    expect(nav).toEqual({ ok: true, url: "https://example.com/", tabId: "cdp-tab-1" });
    const snapshot = await backend.snapshot();
    expect(snapshot?.elements[0]).toMatchObject({ ref: "e1", name: "点我", selector: "#go" });
    expect(snapshot?.tabToken).toBeTruthy();
    expect(snapshot?.tabId).toBe("cdp-tab-1");
    expect(calls.some((call) => call.method === "Page.navigate")).toBe(true);
    expect(calls.some((call) => call.method === "Runtime.evaluate" && call.sessionId === "session-1")).toBe(true);
  });

  it("agentClick / agentType 映射到 CDP Input 事件", async () => {
    const { transport, calls } = fakeTransport();
    const backend = new CdpBrowserBackend("ws://fake", { transport, loadTimeoutMs: 500 });
    await backend.ensureAgentTab();
    expect(await backend.agentClick(undefined, undefined, { x: 10, y: 20 })).toBe(true);
    expect(await backend.agentType(undefined, undefined, "你好")).toBe(true);
    const clickTypes = calls
      .filter((call) => call.method === "Input.dispatchMouseEvent")
      .map((call) => call.params?.type);
    expect(clickTypes).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    expect(calls.some((call) => call.method === "Input.insertText" && call.params?.text === "你好")).toBe(true);
  });

  it("标签生命周期与截图", async () => {
    const { transport, calls } = fakeTransport();
    const backend = new CdpBrowserBackend("ws://fake", { transport, loadTimeoutMs: 500 });
    const created = await backend.newTab("https://example.com/");
    expect(created.ok).toBe(true);
    expect(backend.activeTabId()).toBe(created.tabId);
    expect(backend.listTabs()).toHaveLength(1);
    expect(backend.selectTab(created.tabId)).toBe(true);
    expect(await backend.screenshot()).toBe("cG5n");
    expect(await backend.closeTab(created.tabId)).toBe(true);
    expect(backend.activeTabId()).toBeNull();
    expect(calls.some((call) => call.method === "Target.closeTarget")).toBe(true);
  });

  it("会话标签隔离：不同 sessionId 的标签与激活项互不串线", async () => {
    const { transport } = fakeTransport();
    const backend = new CdpBrowserBackend("ws://fake", { transport, loadTimeoutMs: 500 });
    const a = await backend.newTab("https://a.example/", "session-a");
    const b = await backend.newTab("https://b.example/", "session-b");
    expect(backend.listTabs("session-a").map((tab) => tab.id)).toEqual([a.tabId]);
    expect(backend.listTabs("session-b").map((tab) => tab.id)).toEqual([b.tabId]);
    expect(backend.activeTabId("session-a")).toBe(a.tabId);
    expect(backend.activeTabId("session-b")).toBe(b.tabId);
    backend.selectTab(a.tabId, "session-a");
    expect(backend.activeTabId("session-a")).toBe(a.tabId);
    expect(backend.activeTabId("session-b")).toBe(b.tabId);
    await backend.closeTab(a.tabId, "session-a");
    expect(backend.listTabs("session-a")).toHaveLength(0);
    expect(backend.listTabs("session-b")).toHaveLength(1);
  });

  it("env 选择器默认关闭，显式 endpoint 才启用", async () => {
    expect(createCdpBrowserBackendFromEnv({})).toBeNull();
    const backend = createCdpBrowserBackendFromEnv({ LOOPSOAR_BROWSER_CDP_ENDPOINT: "ws://127.0.0.1:9222" });
    expect(backend).toBeInstanceOf(CdpBrowserBackend);
    await backend?.close();
  });
});
