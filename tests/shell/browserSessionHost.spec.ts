/**
 * 会话级浏览器标签：每个会话独立标签组 / Agent 工具按 sessionId 操作自己的页面 /
 * 切换会话只切换可见组 / 持久化快照与恢复 / 删除会话销毁标签。
 */
import { describe, expect, it } from "vitest";
import { BrowserHost, type HostView } from "../../packages/shell/src/main/browserHost.ts";

interface FakeView extends HostView {
  navigated: string[];
  visible: boolean;
}

function makeHost(initialSessionId = "sess-a") {
  const created: FakeView[] = [];
  const host = new BrowserHost({
    initialSessionId,
    createView: (): HostView => {
      const view: FakeView = {
        navigated: [],
        visible: true,
        setBounds() {},
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
            return 3;
          },
          on() {},
        },
      };
      created.push(view);
      return view;
    },
    attachView: () => {},
    detachView: () => {},
    getWindowSize: () => ({ width: 1360, height: 860 }),
  });
  return { host, created };
}

describe("BrowserHost 会话级标签", () => {
  it("切会话 = 换一组标签，旧会话页面保留且不可见", async () => {
    const { host, created } = makeHost("sess-a");
    await host.navigate("https://a.example/");
    expect(host.currentSessionId()).toBe("sess-a");
    expect(host.listTabs().length).toBe(1);

    await host.switchSession("sess-b");
    expect(host.listTabs()).toEqual([]);
    const b = await host.navigate("https://b.example/");
    expect(b.ok).toBe(true);
    expect(host.listTabs().map((t) => t.url)).toEqual(["https://b.example/"]);

    await host.switchSession("sess-a");
    expect(host.listTabs().map((t) => t.url)).toEqual(["https://a.example/"]);
    expect(host.listTabs()[0].active).toBe(true);
    // 只有 A 会话语义上的视图可见；B 的视图被隐藏
    expect(created[0].visible).toBe(true);
    expect(created[1].visible).toBe(false);
  });

  it("Agent 工具按 sessionId 只操作自己会话的页面（不串到当前可见会话）", async () => {
    const { host } = makeHost("sess-a");
    await host.navigate("https://a.example/");
    await host.switchSession("sess-b");
    await host.navigate("https://b.example/");

    // 后台会话 A 的 Agent 导航：当前可见仍是 B
    const outcome = await host.navigate("https://a2.example/", undefined, "sess-a");
    expect(outcome.ok).toBe(true);
    expect(host.currentSessionId()).toBe("sess-b");
    expect(host.listTabs().map((t) => t.url)).toEqual(["https://b.example/"]);
    expect(host.listTabs("sess-a").map((t) => t.url)).toEqual(["https://a2.example/"]);

    expect(await host.executeScript("1+1", "sess-b")).toBe(3);
  });

  it("持久化快照只保存已打开页面，恢复后 URL/活动标签正确", async () => {
    const { host, created } = makeHost("sess-a");
    await host.navigate("https://one.example/");
    await host.newTab("https://two.example/");
    const state = host.snapshotSession();
    expect(state.tabs.map((t) => t.url)).toEqual(["https://one.example/", "https://two.example/"]);
    expect(state.activeIndex).toBe(1);

    const restored = makeHost("sess-empty");
    await restored.host.switchSession("sess-a", state);
    expect(restored.host.currentSessionId()).toBe("sess-a");
    expect(restored.host.listTabs().map((t) => t.url)).toEqual([
      "https://one.example/",
      "https://two.example/",
    ]);
    expect(restored.host.listTabs()[1].active).toBe(true);
    expect(restored.created[1].navigated[0]).toBe("https://two.example/");
    expect(created.length).toBeGreaterThan(0);
  });

  it("删除会话销毁它自己的标签，不影响其它会话", async () => {
    const { host } = makeHost("sess-a");
    await host.navigate("https://a.example/");
    await host.switchSession("sess-b");
    await host.navigate("https://b.example/");
    await host.deleteSession("sess-a");
    expect(host.listTabs("sess-b").map((t) => t.url)).toEqual(["https://b.example/"]);
    await host.switchSession("sess-a");
    expect(host.listTabs()).toEqual([]);
  });
});
