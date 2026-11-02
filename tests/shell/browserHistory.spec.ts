/**
 * 全局浏览器历史（跨标签/跨会话共享 + 持久化）：
 *   · 存储层：追加、同 URL 去重合并、上限 500、原子写、损坏容错、重启恢复、http(s) 净化；
 *   · 宿主层：成功导航/网页内跳转/新标签首屏 → onVisited；失败导航与「恢复会话」不重复记录；
 *   · 端到端：BrowserHost + BrowserHistoryStore 像 index.ts 一样接线，重启后读回同一份历史。
 * 全部用假 View（无 electron），文件落 os.tmpdir 下的临时目录。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BrowserHistoryStore,
  MAX_GLOBAL_HISTORY,
} from "../../packages/shell/src/main/browserHistoryStore.ts";
import { BrowserHost, type BrowserVisit, type HostView } from "../../packages/shell/src/main/browserHost.ts";

let dir = "";
let historyFile = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-history-"));
  historyFile = path.join(dir, "browser-history.json");
});

afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 });
  } catch {
    // Windows 上句柄释放稍慢，清理失败不影响断言
  }
});

function readFileJson(): { version: number; entries: { url: string }[] } {
  return JSON.parse(fs.readFileSync(historyFile, "utf8")) as { version: number; entries: { url: string }[] };
}

/* ────────────────────────────── 存储层 ────────────────────────────── */

describe("BrowserHistoryStore：追加与排序", () => {
  it("按访问顺序最新在前，字段完整（url/title/visitedAt/visitCount）", () => {
    const store = new BrowserHistoryStore(historyFile);
    store.record({ url: "https://a.example/", title: "A 站" });
    store.record({ url: "https://b.example/", title: "B 站", visitedAt: 1_700_000_000_000 });

    const list = store.list();
    expect(list.map((e) => e.url)).toEqual(["https://b.example/", "https://a.example/"]);
    expect(list[0]).toMatchObject({ url: "https://b.example/", title: "B 站", visitCount: 1 });
    expect(list[0].visitedAt).toBe(1_700_000_000_000);
    expect(list[1].visitCount).toBe(1);
    expect(typeof list[1].visitedAt).toBe("number");
  });

  it("list() 返回副本：修改返回值不影响内部状态", () => {
    const store = new BrowserHistoryStore(historyFile);
    store.record({ url: "https://a.example/" });
    const copy = store.list();
    copy[0].url = "https://tampered.example/";
    expect(store.list()[0].url).toBe("https://a.example/");
  });

  it("只接受 http(s)：file/javascript/空串/非字符串一律不记录", () => {
    const store = new BrowserHistoryStore(historyFile);
    expect(store.record({ url: "file:///etc/passwd" })).toBeNull();
    expect(store.record({ url: "javascript:alert(1)" })).toBeNull();
    expect(store.record({ url: "   " })).toBeNull();
    expect(store.record({ url: 42 as unknown as string })).toBeNull();
    expect(store.size).toBe(0);
    expect(fs.existsSync(historyFile)).toBe(false); // 没有有效记录就不落盘
  });
});

describe("BrowserHistoryStore：同 URL 去重合并", () => {
  it("重复访问 → 合并为一条：移到最前、时间刷新、次数累加、标题更新", () => {
    const store = new BrowserHistoryStore(historyFile);
    store.record({ url: "https://a.example/", title: "旧标题", visitedAt: 1000 });
    store.record({ url: "https://b.example/" });
    const merged = store.record({ url: "https://a.example/", title: "新标题", visitedAt: 2000 });

    expect(merged).toMatchObject({ url: "https://a.example/", title: "新标题", visitCount: 2 });
    const list = store.list();
    expect(list.map((e) => e.url)).toEqual(["https://a.example/", "https://b.example/"]);
    expect(list[0].visitCount).toBe(2);
    expect(list[0].title).toBe("新标题");
  });

  it("重复访问未带标题时保留原标题", () => {
    const store = new BrowserHistoryStore(historyFile);
    store.record({ url: "https://a.example/", title: "保留我" });
    store.record({ url: "https://a.example/" });
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].title).toBe("保留我");
    expect(store.list()[0].visitCount).toBe(2);
  });

  it("updateTitle：只改标题，不改排序/次数；未知 URL 返回 false", () => {
    const store = new BrowserHistoryStore(historyFile);
    store.record({ url: "https://a.example/" });
    store.record({ url: "https://b.example/" });
    expect(store.updateTitle("https://a.example/", "迟到标题")).toBe(true);
    expect(store.updateTitle("https://missing.example/", "无人认领")).toBe(false);
    const list = store.list();
    expect(list.map((e) => e.url)).toEqual(["https://b.example/", "https://a.example/"]);
    expect(list[1]).toMatchObject({ title: "迟到标题", visitCount: 1 });
  });
});

describe("BrowserHistoryStore：上限", () => {
  it(`最多保留 ${MAX_GLOBAL_HISTORY} 条，超出丢弃最旧（内存与文件一致）`, () => {
    const store = new BrowserHistoryStore(historyFile);
    const total = MAX_GLOBAL_HISTORY + 5;
    for (let i = 1; i <= total; i += 1) {
      store.record({ url: `https://site${i}.example/`, visitedAt: 1_700_000_000_000 + i });
    }
    const list = store.list();
    expect(list).toHaveLength(MAX_GLOBAL_HISTORY);
    expect(list[0].url).toBe(`https://site${total}.example/`);
    expect(list[list.length - 1].url).toBe(`https://site${total - MAX_GLOBAL_HISTORY + 1}.example/`);
    expect(readFileJson().entries).toHaveLength(MAX_GLOBAL_HISTORY);
  });
});

describe("BrowserHistoryStore：持久化与重启恢复", () => {
  it("写入即落盘（原子写，不残留 .tmp），新实例读回同一份", () => {
    const first = new BrowserHistoryStore(historyFile);
    first.record({ url: "https://a.example/", title: "A", visitedAt: 1000 });
    first.record({ url: "https://b.example/", title: "B", visitedAt: 2000 });
    first.record({ url: "https://a.example/", visitedAt: 3000 }); // 合并：A 到最前、次数 2
    expect(fs.existsSync(historyFile)).toBe(true);
    expect(fs.existsSync(`${historyFile}.tmp`)).toBe(false);

    // 模拟重启：新实例从文件恢复
    const second = new BrowserHistoryStore(historyFile);
    const list = second.list();
    expect(list.map((e) => e.url)).toEqual(["https://a.example/", "https://b.example/"]);
    expect(list[0]).toMatchObject({ title: "A", visitCount: 2, visitedAt: 3000 });
    expect(list[1]).toMatchObject({ title: "B", visitCount: 1 });
    expect(readFileJson().version).toBe(1);
  });

  it("启动时按 visitedAt 倒序重排（文件顺序被手改也不影响面板顺序）", () => {
    fs.writeFileSync(
      historyFile,
      JSON.stringify({
        version: 1,
        entries: [
          { url: "https://older.example/", visitedAt: 1000, visitCount: 1 },
          { url: "https://newer.example/", visitedAt: 9000, visitCount: 3 },
        ],
      }),
      "utf8",
    );
    const store = new BrowserHistoryStore(historyFile);
    expect(store.list().map((e) => e.url)).toEqual(["https://newer.example/", "https://older.example/"]);
  });

  it("兼容裸数组文件（无 version 包装）", () => {
    fs.writeFileSync(historyFile, JSON.stringify([{ url: "https://bare.example/", visitedAt: 5 }]), "utf8");
    const store = new BrowserHistoryStore(historyFile);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]).toMatchObject({ url: "https://bare.example/", visitCount: 1 });
  });

  it("clear() 清空并落盘", () => {
    const store = new BrowserHistoryStore(historyFile);
    store.record({ url: "https://a.example/" });
    store.clear();
    expect(store.size).toBe(0);
    expect(readFileJson().entries).toEqual([]);
  });
});

describe("BrowserHistoryStore：损坏容错与净化", () => {
  it("坏 JSON → 以空历史启动，并把原文件改名 .corrupt-* 留证", () => {
    fs.writeFileSync(historyFile, "{ 这不是 JSON", "utf8");
    const store = new BrowserHistoryStore(historyFile);
    expect(store.size).toBe(0);
    expect(fs.readdirSync(dir).some((name) => name.includes(".corrupt-"))).toBe(true);
    // 容错后仍可正常写入
    expect(store.record({ url: "https://recovered.example/" })).not.toBeNull();
    expect(new BrowserHistoryStore(historyFile).list()[0].url).toBe("https://recovered.example/");
  });

  it("结构不合法（entries 不是数组）同样按损坏处理", () => {
    fs.writeFileSync(historyFile, JSON.stringify({ version: 1, entries: "nope" }), "utf8");
    expect(new BrowserHistoryStore(historyFile).size).toBe(0);
    expect(fs.readdirSync(dir).some((name) => name.includes(".corrupt-"))).toBe(true);
  });

  it("手工改过的条目逐条净化：非 http(s)/畸形字段被丢弃，重复 URL 只留一条", () => {
    fs.writeFileSync(
      historyFile,
      JSON.stringify({
        version: 1,
        entries: [
          { url: "https://ok.example/", title: "  OK   标题  ", visitedAt: 5000, visitCount: 2 },
          { url: "file:///etc/passwd" },
          { url: "javascript:alert(1)" },
          { url: 123 },
          { url: "https://ok.example/", title: "重复条目" },
          { url: "https://weird.example/", visitedAt: "not-a-number", visitCount: -9 },
        ],
      }),
      "utf8",
    );
    const list = new BrowserHistoryStore(historyFile).list();
    expect(list.map((e) => e.url)).toEqual(["https://ok.example/", "https://weird.example/"]);
    expect(list[0].title).toBe("OK 标题"); // 空白折叠
    expect(list[1]).toMatchObject({ visitCount: 1 });
  });
});

/* ────────────────────────────── 宿主层 ────────────────────────────── */

interface FakeView extends HostView {
  navigated: string[];
  handlers: Map<string, (...args: unknown[]) => void>;
}

function makeHost(): {
  host: BrowserHost;
  views: FakeView[];
  visits: BrowserVisit[];
  titles: [string, string][];
} {
  const views: FakeView[] = [];
  const visits: BrowserVisit[] = [];
  const titles: [string, string][] = [];
  const host = new BrowserHost({
    createView: (): HostView => {
      const view: FakeView = {
        navigated: [],
        handlers: new Map(),
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
          async executeJavaScript(code: string) {
            return code.includes("document.title") ? "示例标题" : 1;
          },
          on(event: string, cb: (...args: unknown[]) => void) {
            view.handlers.set(event, cb);
          },
        },
      };
      views.push(view);
      return view;
    },
    attachView: () => {},
    detachView: () => {},
    getWindowSize: () => ({ width: 1360, height: 860 }),
    onVisited: (visit) => visits.push(visit),
    onTitleChanged: (url, title) => titles.push([url, title]),
  });
  return { host, views, visits, titles };
}

describe("BrowserHost：全局历史回调（与标签后退栈互不影响）", () => {
  it("应用内 navigate 成功 → 记录一次访问（含标题，URL 已规范化）", async () => {
    const { host, visits } = makeHost();
    const result = await host.navigate("example.com");
    expect(result.ok).toBe(true);
    expect(visits).toHaveLength(1);
    expect(visits[0]).toMatchObject({ url: "https://example.com/", title: "示例标题", sessionId: "default", tabId: "tab-1" });
  });

  it("网页内点击链接（did-navigate）→ 追加一条全局历史", async () => {
    const { host, views, visits } = makeHost();
    await host.navigate("https://example.com/");
    views[0].handlers.get("did-navigate")?.({}, "https://example.com/next");
    expect(visits.map((v) => v.url)).toEqual(["https://example.com/", "https://example.com/next"]);
  });

  it("导航失败（javascript:）→ 不记录", async () => {
    const { host, visits } = makeHost();
    const result = await host.navigate("javascript:alert(1)");
    expect(result.ok).toBe(false);
    expect(visits).toHaveLength(0);
  });

  it("新标签带 URL → 记录首屏访问", async () => {
    const { host, visits } = makeHost();
    const created = await host.newTab("https://newtab.example/");
    expect(created.ok).toBe(true);
    expect(visits.map((v) => v.url)).toContain("https://newtab.example/");
  });

  it("页面标题迟到（page-title-updated）→ 通过 onTitleChanged 交给历史层补标题，不再算一次访问", async () => {
    const { host, views, visits, titles } = makeHost();
    await host.navigate("https://example.com/");
    views[0].handlers.get("page-title-updated")?.({}, "迟到标题 - 站点");
    expect(visits).toHaveLength(1);
    expect(titles).toContainEqual(["https://example.com/", "迟到标题 - 站点"]);
  });

  it("切换会话恢复标签（switchSession + restore）不重复写入历史", async () => {
    const { host, visits } = makeHost();
    await host.switchSession("s2", { tabs: [{ url: "https://restored.example/", title: "恢复页" }], activeIndex: 0 });
    expect(host.listTabs("s2")).toHaveLength(1);
    expect(visits).toHaveLength(0);
  });

  it("两个会话的访问进入同一份历史（跨会话共享）", async () => {
    const { host, visits } = makeHost();
    await host.navigate("https://session-a.example/", undefined, "s1");
    await host.navigate("https://session-b.example/", undefined, "s2");
    expect(visits.map((v) => v.sessionId)).toEqual(["s1", "s2"]);
  });
});

/* ────────────────────────────── 端到端 ────────────────────────────── */

describe("端到端：BrowserHost → 全局历史 → 落盘 → 重启恢复", () => {
  it("两个标签/两个会话的访问都在一条历史里，重启后仍在", async () => {
    const history = new BrowserHistoryStore(historyFile);
    const views: FakeView[] = [];
    const host = new BrowserHost({
      createView: (): HostView => {
        const view: FakeView = {
          navigated: [],
          handlers: new Map(),
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
            on(event: string, cb: (...args: unknown[]) => void) {
              view.handlers.set(event, cb);
            },
          },
        };
        views.push(view);
        return view;
      },
      attachView: () => {},
      detachView: () => {},
      getWindowSize: () => ({ width: 1360, height: 860 }),
      onVisited: (visit) => {
        history.record(visit);
      },
      onTitleChanged: (url, title) => {
        history.updateTitle(url, title);
      },
    });

    await host.navigate("https://a.example/", undefined, "s1");
    await host.newTab("https://b.example/", "s2");
    views[1].handlers.get("page-title-updated")?.({}, "B 页面标题");
    await host.navigate("https://a.example/", undefined, "s1"); // 重复访问 → 合并

    const list = history.list();
    expect(list.map((e) => e.url)).toEqual(["https://a.example/", "https://b.example/"]);
    expect(list[0].visitCount).toBe(2);
    expect(list[1].title).toBe("B 页面标题");

    // 模拟重启：新实例读回同一份
    const restored = new BrowserHistoryStore(historyFile).list();
    expect(restored.map((e) => e.url)).toEqual(["https://a.example/", "https://b.example/"]);
    expect(restored[0].visitCount).toBe(2);
  });
});
