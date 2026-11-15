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
    // 切会话显示全局用户标签；进入任务工作区才展开该会话的页面
    expect(created[0].visible).toBe(false);
    expect(created[1].visible).toBe(false);
    host.showTask("sess-a");
    expect(created[0].visible).toBe(true);
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

  it("后台会话的动作只落在自己的 WebContents，前台页面完全不受影响", async () => {
    const { host, created } = makeHost("sess-a");
    await host.navigate("https://a.example/");
    const viewA = created[0];
    await host.switchSession("sess-b");
    await host.navigate("https://b.example/");
    const viewB = created[1];
    let callsA = 0;
    let callsB = 0;
    (viewA.webContents as { executeJavaScript: (code: string) => Promise<unknown> }).executeJavaScript = async () => {
      callsA += 1;
      return 1;
    };
    (viewB.webContents as { executeJavaScript: (code: string) => Promise<unknown> }).executeJavaScript = async () => {
      callsB += 1;
      return 2;
    };
    // A 的 Agent 在自己会话里执行脚本：只打到 A 的 WebContents
    expect(await host.executeScript("document.title", "sess-a")).toBe(1);
    expect(callsA).toBe(1);
    expect(callsB).toBe(0);
    // 可见会话仍是 B，B 的页面没有任何变化
    expect(host.currentSessionId()).toBe("sess-b");
    expect(host.listTabs().map((t) => t.url)).toEqual(["https://b.example/"]);
    // B 的 Agent 动作只打到 B
    expect(await host.executeScript("document.title", "sess-b")).toBe(2);
    expect(callsA).toBe(1);
    expect(callsB).toBe(1);
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

/**
 * Slice H：Agent 工作区（标签归属）与会话接管锁。
 * 浏览器只验证「宿主记了什么、注入了什么」，页面内的拦截行为由 userLockScript.spec + E2E 覆盖。
 */
function trackScripts(view: FakeView): string[] {
  const scripts: string[] = [];
  const wc = view.webContents as unknown as { executeJavaScript: (code: string) => Promise<unknown> };
  const original = wc.executeJavaScript;
  wc.executeJavaScript = (code: string) => {
    scripts.push(code);
    return original.call(wc, code);
  };
  return scripts;
}

describe("BrowserHost Agent 工作区（Slice H）", () => {
  it("用户自己打开的标签即使会话被锁也保持可操作（只有 Agent 绑定页被盖住）", async () => {
    const { host, created } = makeHost("sess-a");
    await host.navigate("https://a.example/");
    const userView = trackScripts(created[0]);
    await host.lockForSession("sess-a", true, "x");
    expect(userView.some((code) => code.includes("data-loopsoar-lock"))).toBe(false);
  });

  it("agent origin 的导航/新建把目标标签标成 agentBound，user origin 不标", async () => {
    const { host } = makeHost("sess-a");
    await host.navigate("https://u.example/");
    expect(host.listTabs()[0].agentBound).toBe(false);

    await host.navigate("https://a.example/", undefined, "sess-a", "agent");
    expect(host.listTabs().find((tab) => tab.url === "https://a.example/")?.agentBound).toBe(true);

    // 同一标签之后被用户导航：绑定不撤销，否则页面会从折叠组里掉出去
    await host.navigate("https://a2.example/", undefined, "sess-a", "user");
    expect(host.listTabs().find((tab) => tab.url === "https://a2.example/")?.agentBound).toBe(true);

    const created = await host.newTab("https://b.example/", "sess-a", "agent");
    expect(host.listTabs().find((tab) => tab.id === created.tabId)?.agentBound).toBe(true);
  });

  it("lockForSession 只给 Agent 绑定标签注入锁脚本，解锁注入清理脚本", async () => {
    const { host, created } = makeHost("sess-a");
    await host.navigate("https://one.example/", undefined, "sess-a", "agent");
    await host.newTab("https://two.example/", "sess-a", "agent");
    expect(created.length).toBe(2);
    const scripts = created.map(trackScripts);

    await host.lockForSession("sess-a", true, "x");
    for (const list of scripts) {
      expect(list.some((code) => code.includes("data-loopsoar-lock"))).toBe(true);
    }

    for (const list of scripts) list.length = 0;
    await host.lockForSession("sess-a", false);
    for (const list of scripts) {
      expect(list.some((code) => code.includes("removeChild"))).toBe(true);
      // 解锁只清理：不能再建浮层
      expect(list.some((code) => code.includes("attachShadow"))).toBe(false);
    }
  });

  it("解锁状态下新建的标签不会被注入锁", async () => {
    const { host, created } = makeHost("sess-a");
    await host.navigate("https://one.example/", undefined, "sess-a", "agent");
    await host.lockForSession("sess-a", true, "x");
    await host.lockForSession("sess-a", false);

    const blank = await host.newTab();
    const fresh = trackScripts(created[created.length - 1]);
    await host.navigate("https://three.example/", blank.tabId, "sess-a");
    expect(fresh.some((code) => code.includes("data-loopsoar-lock"))).toBe(false);
  });

  it("会话锁定期间导航完成的标签自动补注入（不依赖显式再锁定）", async () => {
    const { host, created } = makeHost("sess-a");
    await host.navigate("https://one.example/", undefined, "sess-a", "agent");
    await host.lockForSession("sess-a", true, "x");

    const blank = await host.newTab(undefined, "sess-a", "agent");
    const fresh = trackScripts(created[created.length - 1]);
    await host.navigate("https://two.example/", blank.tabId, "sess-a", "agent");
    expect(fresh.some((code) => code.includes("data-loopsoar-lock"))).toBe(true);
  });

  it("锁只作用于指定会话，不串到其它会话的网页", async () => {
    const { host, created } = makeHost("sess-a");
    await host.navigate("https://a.example/", undefined, "sess-a", "agent");
    const scriptsA = trackScripts(created[0]);
    await host.switchSession("sess-b");
    await host.navigate("https://b.example/");
    const scriptsB = trackScripts(created[1]);

    await host.lockForSession("sess-a", true, "x");
    expect(scriptsA.some((code) => code.includes("data-loopsoar-lock"))).toBe(true);
    expect(scriptsB.some((code) => code.includes("data-loopsoar-lock"))).toBe(false);
  });

  it("没有标签的会话调用 lockForSession 不抛错（锁状态仍然记住）", async () => {
    const { host } = makeHost("sess-a");
    await expect(host.lockForSession("sess-empty", true, "x")).resolves.toBeUndefined();
    // 之后该会话新建的标签仍然按锁定状态补注入
    const blank = await host.newTab("https://late.example/", "sess-empty", "agent");
    expect(blank.ok).toBe(true);
    expect(host.listTabs("sess-empty")[0].agentBound).toBe(true);
  });
});

