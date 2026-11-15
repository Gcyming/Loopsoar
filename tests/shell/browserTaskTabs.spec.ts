/**
 * Agent 任务化：第一次「动手」把用户当前页克隆进 Agent 工作区（原页不动），
 * 只读不克隆；agentBound 随持久化恢复。
 */
import { describe, expect, it } from "vitest";
import { BrowserHost, type HostView } from "../../packages/shell/src/main/browserHost.ts";

interface FakeView extends HostView {
  navigated: string[];
  closed: boolean;
}

function makeHost() {
  const created: FakeView[] = [];
  const host = new BrowserHost({
    initialSessionId: "sess-a",
    createView: (): HostView => {
      const view: FakeView = {
        navigated: [],
        closed: false,
        setBounds() {},
        setVisible() {},
        webContents: {
          async loadURL(url: string) {
            view.navigated.push(url);
          },
          getURL: () => view.navigated[view.navigated.length - 1] ?? "",
          async capturePage() {
            return { toPNG: () => Buffer.from("png") };
          },
          async executeJavaScript() {
            return 1;
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
    getWindowSize: () => ({ width: 1360, height: 860 }),
  });
  return { host, created };
}

describe("BrowserHost · Agent 工作区任务化", () => {
  it("首次动作克隆当前用户页：原页保留、克隆页 agentBound 且 URL 相同", async () => {
    const { host } = makeHost();
    await host.navigate("https://a.example/");
    expect(host.listTabs().length).toBe(1);

    const cloneId = await host.ensureAgentTab("sess-a");
    expect(cloneId).toBeTruthy();
    const tabs = host.listTabs("sess-a");
    expect(tabs.length).toBe(2);
    const original = tabs.find((tab) => tab.id !== cloneId)!;
    const clone = tabs.find((tab) => tab.id === cloneId)!;
    expect(original.agentBound).toBe(false);
    expect(original.url).toBe("https://a.example/");
    expect(clone.agentBound).toBe(true);
    expect(clone.url).toBe("https://a.example/");
    expect(clone.active).toBe(true);
  });

  it("重复调用复用同一个 Agent 标签；空会话也能创建空白工作区标签", async () => {
    const { host } = makeHost();
    await host.navigate("https://a.example/");
    const first = await host.ensureAgentTab("sess-a");
    const second = await host.ensureAgentTab("sess-a");
    expect(second).toBe(first);
    expect(host.listTabs().length).toBe(2);

    const empty = await host.ensureAgentTab("sess-empty");
    expect(empty).toBeTruthy();
    expect(host.listTabs("sess-empty").length).toBe(1);
    expect(host.listTabs("sess-empty")[0].agentBound).toBe(true);
  });

  it("agentBound 随会话快照持久化并在恢复后保留", async () => {
    const { host } = makeHost();
    await host.navigate("https://a.example/");
    await host.ensureAgentTab("sess-a");
    const state = host.snapshotSession("sess-a");
    expect(state.tabs.map((tab) => tab.agentBound === true)).toEqual([false, true]);

    const restored = makeHost();
    await restored.host.switchSession("sess-a", state);
    const tabs = restored.host.listTabs("sess-a");
    expect(tabs.length).toBe(2);
    expect(tabs.filter((tab) => tab.agentBound).length).toBe(1);
    expect(tabs.find((tab) => tab.agentBound)?.url).toBe("https://a.example/");
  });
});
