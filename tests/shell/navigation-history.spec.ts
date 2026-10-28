/**
 * 多标签导航历史：后退/前进/刷新 + 历史列表（假 View，无 electron）。
 */
import { describe, expect, it } from "vitest";
import { BrowserHost, type HostView } from "../../packages/shell/src/main/browserHost.ts";

function makeHost() {
  const created: HostView[] = [];
  const host = new BrowserHost({
    createView: () => {
      const view = {
        bounds: null,
        setBounds() {},
        setVisible() {},
        webContents: {
          async loadURL() {},
          getURL: () => "",
          async capturePage() {
            return { toPNG: () => Buffer.from("") };
          },
          async executeJavaScript(code: string) {
            return code.includes("title") ? "T" : 1;
          },
          on() {},
        },
      };
      created.push(view as unknown as HostView);
      return view as unknown as HostView;
    },
    attachView: () => {},
    detachView: () => {},
    getWindowSize: () => ({ width: 1360, height: 860 }),
  });
  return { host, created };
}

describe("浏览器导航历史", () => {
  it("顺序导航后 canBack/canForward 正确，后退前进可往返", async () => {
    const { host } = makeHost();
    await host.navigate("https://a.example");
    await host.navigate("https://b.example");
    await host.navigate("https://c.example");
    let tab = host.listTabs()[0];
    expect(tab.canBack).toBe(true);
    expect(tab.canForward).toBe(false);

    const back = await host.goBack();
    expect(back.ok).toBe(true);
    expect(back.url).toBe("https://b.example/");
    tab = host.listTabs()[0];
    expect(tab.canForward).toBe(true);

    const forward = await host.goForward();
    expect(forward.ok).toBe(true);
    expect(forward.url).toBe("https://c.example/");
  });

  it("history() 返回完整栈并标记当前位置", async () => {
    const { host } = makeHost();
    await host.navigate("https://a.example");
    await host.navigate("https://b.example");
    await host.goBack();
    const entries = host.history();
    expect(entries.map((e) => e.url)).toEqual(["https://a.example/", "https://b.example/"]);
    expect(entries.find((e) => e.current)?.url).toBe("https://a.example/");
  });

  it("新导航截断前进分支", async () => {
    const { host } = makeHost();
    await host.navigate("https://a.example");
    await host.navigate("https://b.example");
    await host.goBack();
    await host.navigate("https://d.example");
    expect(host.history().map((e) => e.url)).toEqual(["https://a.example/", "https://d.example/"]);
    expect(host.listTabs()[0].canForward).toBe(false);
  });

  it("没有历史时后退/前进返回失败", async () => {
    const { host } = makeHost();
    await host.navigate("https://a.example");
    expect((await host.goBack()).ok).toBe(false);
    expect((await host.goForward()).ok).toBe(false);
  });
});
