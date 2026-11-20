/**
 * 并发不变量（架构稳固性维度缺口 3/3）。
 *
 * 为什么单测不够：本项目的并发不是「多线程」而是「多入口同时改同一份内存状态」——
 * 浏览器工具（Agent）与 UI 同时切标签、多个会话并行跑回合、拖窗口时连续 setInset、
 * 多个标签同时落盘。这类竞争不会在顺序测试里暴露，只会在真实使用中表现为
 * 「令牌串页 / 后写的覆盖先写的 / 临时文件残留」。
 *
 * 本文件钉住四条不变量：
 *   ① 快照令牌有界（长期浏览不能无界增长），且迁移/丢弃是原子的；
 *   ② 跨标签/跨会话引用必须被识别（不能把 A 页的 #e3 点到 B 页）；
 *   ③ 合并写不丢更新（多键写入后每个键都在）；
 *   ④ 同一 URL 的高频访问合并计数，而不是产生重复条目。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTabRegistry, type RawBrowserElement } from "../../packages/shell/src/browserAdapter/refs.ts";
import { SnapshotBindings, bindRefToTab } from "../../packages/shell/src/main/browserTools/context.ts";
import { BrowserStateStore } from "../../packages/shell/src/main/browserStateStore.ts";
import { BrowserHistoryStore } from "../../packages/shell/src/main/browserHistoryStore.ts";

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-race-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const ELEMENTS: RawBrowserElement[] = [
  { tag: "button", role: "button", name: "提交", selector: "#submit", selectorWhy: "id" },
];

describe("并发：快照令牌有界且迁移原子", () => {
  it("绑定数超过上限时裁剪，不会无界增长", () => {
    const bindings = new SnapshotBindings();
    for (let i = 0; i < 600; i += 1) {
      bindings.bind("s1", `tab-${i}`, `token-${i}`);
    }
    const size = bindings.size();
    expect(size.tokens).toBeLessThanOrEqual(512);
    // 最新的那条一定还在（LRU 淘汰的是最旧的，不能把刚写的删掉）
    expect(bindings.token("s1", "tab-599")).toBe("token-599");
    expect(bindings.token("s1", "tab-0")).toBeUndefined();
  });

  it("迁移同时搬走令牌与「最近标签」，不留半更新状态", () => {
    const bindings = new SnapshotBindings();
    bindings.bind("s1", "user-tab", "tok-a");

    bindings.migrate("s1", "user-tab", "agent-tab");

    expect(bindings.token("s1", "agent-tab")).toBe("tok-a");
    expect(bindings.token("s1", "user-tab")).toBeUndefined();
    expect(bindings.lastTab("s1")).toBe("agent-tab");
  });

  it("迁移后「最近标签」跟随克隆页（否则下次分不清跨标签还是同标签）", () => {
    const bindings = new SnapshotBindings();
    bindings.bind("s1", "user-tab", "tok-a");

    bindings.migrate("s1", "user-tab", "agent-tab");

    expect(bindings.lastTab("s1")).toBe("agent-tab");
  });

  it("从未快照的会话迁移是 no-op（没有来历可搬，不能凭空造绑定）", () => {
    const bindings = new SnapshotBindings();
    bindings.migrate("s1", "user-tab", "agent-tab");
    expect(bindings.lastTab("s1")).toBeUndefined();
    expect(bindings.token("s1", "agent-tab")).toBeUndefined();
  });

  it("关闭标签后令牌与指针一起丢弃（重开同 id 不复活旧 ref）", () => {
    const bindings = new SnapshotBindings();
    bindings.bind("s1", "tab-1", "tok-a");
    bindings.forget("s1", "tab-1");
    expect(bindings.token("s1", "tab-1")).toBeUndefined();
    expect(bindings.lastTab("s1")).toBeUndefined();
  });
});

describe("并发：跨会话/跨标签引用必须被识别", () => {
  it("会话隔离：A 的快照令牌不会让 B 的 ref 解析成功", () => {
    const bindings = new SnapshotBindings();
    const { token } = createTabRegistry();
    bindings.bind("A", "tab-A", token);

    expect(bindings.registry("B", "tab-A")).toBeNull();
    expect(bindings.registry("A", "tab-A")).not.toBeNull();
  });

  it("跨标签：给出可行动的 STALE_REF（说明是哪两个标签）", () => {
    const bindings = new SnapshotBindings();
    const { token } = createTabRegistry();
    bindings.bind("s1", "tab-1", token);

    const verdict = bindRefToTab(bindings, "s1", "tab-2", "#e1");

    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain("STALE_REF");
    expect(verdict.message).toContain("tab-1");
    expect(verdict.message).toContain("tab-2");
  });

  it("CSS / text= 不依赖注册表，不参与跨标签校验", () => {
    const bindings = new SnapshotBindings();
    bindings.bind("s1", "tab-1", "tok-1");
    expect(bindRefToTab(bindings, "s1", "tab-2", "#submit").ok).toBe(true);
    expect(bindRefToTab(bindings, "s1", "tab-2", "text=提交").ok).toBe(true);
  });
});

describe("并发：合并写不丢更新", () => {
  it("同一 tick 内写 50 个会话，flush 后每个都在", () => {
    const dir = tempDir();
    const file = path.join(dir, "browser-state.json");
    const store = new BrowserStateStore(file, { debounceMs: 0 });

    for (let i = 0; i < 50; i += 1) {
      store.set(`s${i}`, { tabs: [{ url: `https://example.com/${i}` }], activeIndex: 0 });
    }
    store.flush();

    const reloaded = new BrowserStateStore(file, { debounceMs: 0 });
    for (let i = 0; i < 50; i += 1) {
      expect(reloaded.get(`s${i}`)?.tabs[0]?.url).toBe(`https://example.com/${i}`);
    }
  });

  it("删除与写入交错：删掉的不会因为旧缓存复活", () => {
    const dir = tempDir();
    const file = path.join(dir, "browser-state.json");
    const store = new BrowserStateStore(file, { debounceMs: 0 });

    store.set("s1", { tabs: [{ url: "https://example.com/" }], activeIndex: 0 });
    store.set("s2", { tabs: [{ url: "https://example.org/" }], activeIndex: 0 });
    store.flush();
    store.delete("s1");
    store.flush();

    const reloaded = new BrowserStateStore(file, { debounceMs: 0 });
    expect(reloaded.get("s1")).toBeNull();
    expect(reloaded.get("s2")).not.toBeNull();
  });

  it("空标签列表等于删除键（不留空壳）", () => {
    const dir = tempDir();
    const file = path.join(dir, "browser-state.json");
    const store = new BrowserStateStore(file, { debounceMs: 0 });
    store.set("s1", { tabs: [{ url: "https://example.com/" }], activeIndex: 0 });
    store.set("s1", { tabs: [], activeIndex: 0 });
    store.flush();

    expect(new BrowserStateStore(file, { debounceMs: 0 }).get("s1")).toBeNull();
    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("并发：历史高频访问合并", () => {
  it("同一 URL 连续 100 次只产生一条，计数与时间都更新", () => {
    const dir = tempDir();
    const store = new BrowserHistoryStore(path.join(dir, "browser-history.json"));

    for (let i = 0; i < 100; i += 1) {
      store.record({ url: "https://example.com/a", visitedAt: 1000 + i });
    }

    const list = store.list();
    expect(list.length).toBe(1);
    expect(list[0]?.visitCount).toBe(100);
    expect(list[0]?.visitedAt).toBe(1099);
  });

  it("超过上限时保留最新、丢弃最旧（有界）", () => {
    const dir = tempDir();
    const store = new BrowserHistoryStore(path.join(dir, "browser-history.json"));
    for (let i = 0; i < 520; i += 1) {
      store.record({ url: `https://example.com/${i}`, visitedAt: 1000 + i });
    }
    expect(store.size).toBe(500);
    // 最新的仍在最前，最旧的被丢弃
    expect(store.list()[0]?.url).toBe("https://example.com/519");
    expect(store.list().some((entry) => entry.url === "https://example.com/0")).toBe(false);
  });
});
