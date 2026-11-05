/**
 * 恢复标签「历史补记」（backfill）与窗口重排防抖：
 *   · 用户反馈"历史面板空"的根因是：会话恢复有意不记录访问 → 全局历史（browser-history.json）
 *     在新导航发生前没有任何条目；启动后用 backfill 把恢复标签补进去，但不伪造新访问。
 *   · 本 spec 覆盖：补记新增/顺序、去重不增计数、标题只补空、同批重复与非法 URL 跳过、
 *     幂等、上限、持久化、与 record 的交互、以及 BrowserHost 恢复 + 补记的端到端接线。
 *   · 附：50ms 防抖器（窗口 resize/maximize/fullscreen 共用）的合并与取消行为。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BrowserHistoryStore,
  MAX_GLOBAL_HISTORY,
} from "../../packages/shell/src/main/browserHistoryStore.ts";
import {
  BrowserHost,
  createDebouncedRunner,
  type BrowserVisit,
  type HostView,
} from "../../packages/shell/src/main/browserHost.ts";

let dir = "";
let historyFile = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-backfill-"));
  historyFile = path.join(dir, "browser-history.json");
});

afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 });
  } catch {
    // Windows 句柄释放稍慢，清理失败不影响断言
  }
});

/* ───────────────────────────── 补记语义 ───────────────────────────── */

describe("backfill：恢复标签补进全局历史（不计新访问）", () => {
  it("空历史：按恢复顺序补记，visitedAt=补记时刻、visitCount=1", () => {
    const store = new BrowserHistoryStore(historyFile);
    const before = Date.now();
    const stats = store.backfill([
      { url: "https://a.example/", title: "A 站" },
      { url: "https://b.example/", title: "B 站" },
      { url: "https://c.example/" },
    ]);
    const after = Date.now();

    expect(stats).toEqual({ added: 3, merged: 0, skipped: 0 });
    const list = store.list();
    // 恢复顺序即面板顺序（首个标签在最前）
    expect(list.map((e) => e.url)).toEqual(["https://a.example/", "https://b.example/", "https://c.example/"]);
    for (const entry of list) {
      expect(entry.visitCount).toBe(1);
      expect(entry.visitedAt).toBeGreaterThanOrEqual(before);
      expect(entry.visitedAt).toBeLessThanOrEqual(after);
    }
    expect(list[0].title).toBe("A 站");
    expect(list[2].title).toBeUndefined();
  });

  it("已存在的 URL：不增 visitCount、不改变排序，只按需补空标题", () => {
    const store = new BrowserHistoryStore(historyFile);
    store.record({ url: "https://visited.example/", visitedAt: 8_000_000 }); // 无标题
    store.record({ url: "https://visited.example/", visitedAt: 8_500_000 }); // 合并 → count=2，仍无标题
    store.record({ url: "https://recent.example/", title: "最近访问", visitedAt: 9_000_000 }); // 最近访问在最前
    const before = store.list();
    expect(before[0]).toMatchObject({ url: "https://recent.example/", visitCount: 1 });
    expect(before[1]).toMatchObject({ url: "https://visited.example/", visitCount: 2 });

    const stats = store.backfill([
      { url: "https://recent.example/", title: "恢复态标题（不应覆盖）" },
      { url: "https://visited.example/", title: "恢复态标题（补空）" },
      { url: "https://brand-new.example/", title: "新补" },
    ]);

    expect(stats).toEqual({ added: 1, merged: 2, skipped: 0 });
    const after = store.list();
    // 新补的排最前；已存在的保持原有相对顺序与访问次数
    expect(after.map((e) => e.url)).toEqual([
      "https://brand-new.example/",
      "https://recent.example/",
      "https://visited.example/",
    ]);
    expect(after[1]).toMatchObject({ title: "最近访问", visitCount: 1 });
    expect(after[2]).toMatchObject({ title: "恢复态标题（补空）", visitCount: 2 });
    expect(after[2].visitedAt).toBe(8_500_000); // 恢复不刷新时间
  });

  it("同批重复 / 非法 URL / 空地址 → 计入 skipped 且不写入", () => {
    const store = new BrowserHistoryStore(historyFile);
    const stats = store.backfill([
      { url: "https://dup.example/" },
      { url: "https://dup.example/", title: "重复" },
      { url: "file:///etc/passwd" },
      { url: "javascript:alert(1)" },
      { url: "" },
      { url: 42 },
    ]);
    expect(stats).toEqual({ added: 1, merged: 0, skipped: 5 });
    expect(store.list().map((e) => e.url)).toEqual(["https://dup.example/"]);
  });

  it("幂等：再次补记不新增、不增计数（重启多次也只留一条）", () => {
    const store = new BrowserHistoryStore(historyFile);
    const tabs = [{ url: "https://a.example/", title: "A" }, { url: "https://b.example/", title: "B" }];
    expect(store.backfill(tabs)).toEqual({ added: 2, merged: 0, skipped: 0 });
    expect(store.backfill(tabs)).toEqual({ added: 0, merged: 2, skipped: 0 });
    const list = store.list();
    expect(list).toHaveLength(2);
    expect(list.map((e) => e.visitCount)).toEqual([1, 1]);
  });

  it("补记后再真实访问：record 正常的 +1 语义不受影响", () => {
    const store = new BrowserHistoryStore(historyFile);
    store.backfill([{ url: "https://a.example/", title: "A" }]);
    store.record({ url: "https://a.example/", title: "A（新标题）" });
    const entry = store.list()[0];
    expect(entry.visitCount).toBe(2);
    expect(entry.title).toBe("A（新标题）");
  });

  it(`上限 ${MAX_GLOBAL_HISTORY}：补记超量时丢弃最旧的（新补的在前）`, () => {
    const store = new BrowserHistoryStore(historyFile);
    const visits = Array.from({ length: MAX_GLOBAL_HISTORY + 20 }, (_, i) => ({
      url: `https://restore${i}.example/`,
      title: `t${i}`,
    }));
    const stats = store.backfill(visits);
    expect(stats.added).toBe(MAX_GLOBAL_HISTORY + 20);
    const list = store.list();
    expect(list).toHaveLength(MAX_GLOBAL_HISTORY);
    expect(list[0].url).toBe("https://restore0.example/");
    expect(list[list.length - 1].url).toBe(`https://restore${MAX_GLOBAL_HISTORY - 1}.example/`);
  });

  it("持久化：补记后立刻落盘，重启（新实例）读回同一份", () => {
    const store = new BrowserHistoryStore(historyFile);
    store.backfill([{ url: "https://a.example/", title: "A" }]);
    expect(fs.existsSync(historyFile)).toBe(true);
    expect(fs.existsSync(`${historyFile}.tmp`)).toBe(false);
    const restored = new BrowserHistoryStore(historyFile);
    expect(restored.list()).toHaveLength(1);
    expect(restored.list()[0]).toMatchObject({ url: "https://a.example/", title: "A", visitCount: 1 });
  });

  it("空输入 / 非数组输入 → 空统计，不落盘", () => {
    const store = new BrowserHistoryStore(historyFile);
    expect(store.backfill([])).toEqual({ added: 0, merged: 0, skipped: 0 });
    expect(store.backfill(null as unknown as [])).toEqual({ added: 0, merged: 0, skipped: 0 });
    expect(fs.existsSync(historyFile)).toBe(false);
  });
});

/* ───────────────────────── 与 BrowserHost 恢复的接线 ───────────────────────── */

interface FakeView extends HostView {
  navigated: string[];
}

describe("端到端：会话恢复标签 → backfill（模拟 index.ts 启动流程）", () => {
  it("恢复不记录访问，但补记后历史面板不为空", async () => {
    const history = new BrowserHistoryStore(historyFile);
    const visits: BrowserVisit[] = [];
    const host = new BrowserHost({
      createView: (): HostView => {
        const view: FakeView = {
          navigated: [],
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
              return code.includes("document.title") ? "恢复标题" : 1;
            },
            on() {},
          },
        };
        return view;
      },
      attachView: () => {},
      detachView: () => {},
      getWindowSize: () => ({ width: 1100, height: 760 }),
      onVisited: (visit) => visits.push(visit),
    });

    // 启动恢复（index.ts：switchSession(initialSessionId, bootBrowserState)）
    const bootState = {
      tabs: [
        { url: "https://old-a.example/", title: "旧 A" },
        { url: "https://old-b.example/", title: "旧 B" },
      ],
      activeIndex: 0,
    };
    await host.switchSession("sess-1", bootState);
    expect(host.listTabs("sess-1")).toHaveLength(2);
    // 恢复本身不写历史（保持既有语义：不把旧页面算成新访问）
    expect(visits).toHaveLength(0);
    expect(history.size).toBe(0);

    // index.ts 在恢复后补记 bootBrowserState 的标签
    const stats = history.backfill(bootState.tabs);
    expect(stats).toEqual({ added: 2, merged: 0, skipped: 0 });
    expect(history.list().map((e) => e.url)).toEqual(["https://old-a.example/", "https://old-b.example/"]);
    expect(history.list().map((e) => e.visitCount)).toEqual([1, 1]);

    // 之后真实导航仍走 record（计数正常 +1）
    await host.navigate("https://old-a.example/", undefined, "sess-1");
    for (const visit of visits) history.record(visit);
    expect(history.list()[0]).toMatchObject({ url: "https://old-a.example/", visitCount: 2 });
  });
});

/* ───────────────────────────── 窗口重排防抖 ───────────────────────────── */

describe("createDebouncedRunner：窗口几何变化防抖（50ms）", () => {
  it("连发多个事件只执行一次（保留最后一次）", async () => {
    let runs = 0;
    const runner = createDebouncedRunner(() => {
      runs += 1;
    }, 50);
    runner.schedule();
    runner.schedule();
    runner.schedule();
    expect(runner.pending()).toBe(true);
    expect(runs).toBe(0); // 防抖期内不执行
    await new Promise((resolve) => setTimeout(resolve, 140));
    expect(runs).toBe(1);
    expect(runner.pending()).toBe(false);
  });

  it("cancel 后不再执行（窗口关闭时清理计时器）", async () => {
    let runs = 0;
    const runner = createDebouncedRunner(() => {
      runs += 1;
    }, 30);
    runner.schedule();
    runner.cancel();
    expect(runner.pending()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(runs).toBe(0);
  });

  it("间隔大于防抖窗口 → 每次都会执行", async () => {
    let runs = 0;
    const runner = createDebouncedRunner(() => {
      runs += 1;
    }, 20);
    runner.schedule();
    await new Promise((resolve) => setTimeout(resolve, 70));
    runner.schedule();
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(runs).toBe(2);
  });
});

describe("窗口自适应：防抖 + BrowserHost 重排（模拟 resize/maximize 连发）", () => {
  it("连续尺寸变化只重排一次，且用「最后一次」窗口尺寸（不会停在中间态）", async () => {
    let size = { width: 1360, height: 860 };
    let lastBounds: { x: number; y: number; width: number; height: number } | null = null;
    const host = new BrowserHost({
      createView: (): HostView => ({
        setBounds(bounds: { x: number; y: number; width: number; height: number }) {
          lastBounds = bounds;
        },
        setVisible() {},
        getBounds() {
          return lastBounds ?? { x: 0, y: 0, width: 0, height: 0 };
        },
        webContents: {
          async loadURL() {},
          getURL: () => "https://example.com/",
          async capturePage() {
            return { toPNG: () => Buffer.from("png") };
          },
          async executeJavaScript(code: string) {
            return code.includes("document.title") ? "示例" : 1;
          },
          on() {},
        },
      }),
      attachView: () => {},
      detachView: () => {},
      getWindowSize: () => size,
    });
    await host.navigate("https://example.com/");
    // 导航后的首次布局：1360x860 → 978x724
    expect(lastBounds).toEqual({ x: 8, y: 96, width: 982, height: 724 });

    let layouts = 0;
    const runner = createDebouncedRunner(() => {
      layouts += 1;
      host.syncBounds();
    }, 20);
    // 模拟拖拽 resize 连发 + maximize 中间态 + 定格（只应重排一次，取最后一次尺寸）
    size = { width: 1100, height: 760 };
    runner.schedule();
    size = { width: 1200, height: 800 };
    runner.schedule();
    size = { width: 1440, height: 900 };
    runner.schedule();
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(layouts).toBe(1);
    // 1440x900：宽 1440-360-2-16=1062；高 900-40-48-32-16=764
    expect(lastBounds).toEqual({ x: 8, y: 96, width: 1062, height: 764 });
    // debugBounds 必须同时给出「计算的 bounds」与「视图真实 getBounds」（E2E 靠它定位没生效的 setBounds）
    expect(host.debugBounds()).toMatchObject({
      window: { width: 1440, height: 900 },
      bounds: { x: 8, y: 96, width: 1062, height: 764 },
      actual: { x: 8, y: 96, width: 1062, height: 764 },
    });
  });
});
