/**
 * BookmarksStore + bookmarks 域：
 * 新增/去重/排序/删除/上限淘汰/损坏恢复/URL 规范化/非 http 拒绝/原子写/写失败不抛/跨实例持久化，
 * 以及 3 条 IPC 通道的返回结构（list/add/remove，经受信 IPC 包装器校验参数）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BookmarksStore,
  MAX_BOOKMARKS,
  normalizeBookmarkUrl,
} from "../../packages/shell/src/main/bookmarksStore.ts";
import { registerBookmarksDomain } from "../../packages/shell/src/main/domains/bookmarks.ts";
import { __resetHandlerRegistryForTests } from "../../packages/shell/src/main/trustedIpc.ts";

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-bookmarks-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

/** 递增时钟：让 createdAt 可预期（排序/淘汰断言不依赖系统毫秒）。 */
function clock(start = 1_700_000_000_000) {
  let current = start;
  return () => {
    current += 1_000;
    return current;
  };
}

function readFileJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

describe("BookmarksStore · 新增 / 规范化 / 去重", () => {
  it("新增书签：URL 规范化、title 缺省用 hostname、原子落盘", () => {
    const dir = tempDir();
    const store = new BookmarksStore(dir, { now: clock() });
    const result = store.add({ url: "  HTTPS://Example.COM:443/Path?q=1#frag  " });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.duplicate).toBe(false);
    expect(result.bookmark.url).toBe("https://example.com/Path?q=1#frag");
    expect(result.bookmark.title).toBe("example.com");
    expect(result.bookmark.id.startsWith("bm-")).toBe(true);
    expect(typeof result.bookmark.createdAt).toBe("number");

    // 原子写：文件是完整 JSON，且不残留 .tmp
    expect(store.filePath).toBe(path.join(dir, "bookmarks.json"));
    const persisted = readFileJson(store.filePath) as { version: number; items: Array<{ url: string }> };
    expect(persisted.version).toBe(1);
    expect(persisted.items).toHaveLength(1);
    expect(persisted.items[0].url).toBe("https://example.com/Path?q=1#frag");
    expect(fs.existsSync(`${store.filePath}.tmp`)).toBe(false);
  });

  it("自定义 title 会 trim 并截断到 300；空 title 回退 hostname", () => {
    const dir = tempDir();
    const store = new BookmarksStore(dir, { now: clock() });
    expect(store.add({ url: "https://a.example.com/x", title: "  我的标题  " })).toMatchObject({
      ok: true,
      bookmark: { title: "我的标题" },
    });
    const long = store.add({ url: "https://b.example.com", title: "x".repeat(400) });
    expect(long.ok).toBe(true);
    if (long.ok) expect(long.bookmark.title).toHaveLength(300);
    const blank = store.add({ url: "https://c.example.com", title: "   " });
    expect(blank.ok).toBe(true);
    if (blank.ok) expect(blank.bookmark.title).toBe("c.example.com");
  });

  it("同 URL 去重：规范化后相同（大小写/默认端口/尾斜杠/空白）返回已有项且不新增", () => {
    const dir = tempDir();
    const store = new BookmarksStore(dir, { now: clock() });
    const first = store.add({ url: "https://example.com" });
    expect(first.ok).toBe(true);
    const again = store.add({ url: "  https://example.com/  " });
    expect(again.ok).toBe(true);
    if (!first.ok || !again.ok) return;
    expect(again.duplicate).toBe(true);
    expect(again.bookmark.id).toBe(first.bookmark.id);
    expect(store.list()).toHaveLength(1);
  });

  it("非 http/https 与非法 URL 拒绝（可读错误）", () => {
    const dir = tempDir();
    const store = new BookmarksStore(dir, { now: clock() });
    const cases: Array<[string, RegExp]> = [
      ["javascript:alert(1)", /仅支持 http\/https/],
      ["file:///C:/secret.txt", /仅支持 http\/https/],
      ["ftp://example.com/a", /仅支持 http\/https/],
      ["data:text/html,hi", /仅支持 http\/https/],
      ["not a url", /不合法/],
      ["", /为空/],
      ["   ", /为空/],
    ];
    for (const [url, pattern] of cases) {
      const result = store.add({ url });
      expect(result.ok, url).toBe(false);
      if (!result.ok) expect(result.error).toMatch(pattern);
    }
    expect(store.list()).toHaveLength(0);
  });

  it("normalizeBookmarkUrl：导出纯函数可直接使用", () => {
    expect(normalizeBookmarkUrl("https://Example.com")).toEqual({ ok: true, url: "https://example.com/" });
    expect(normalizeBookmarkUrl("http://example.com:80/a").ok).toBe(true);
    expect(normalizeBookmarkUrl("mailto:a@b.com").ok).toBe(false);
  });
});

describe("BookmarksStore · 列表排序 / 删除 / 上限淘汰", () => {
  it("list 按 createdAt 倒序（最新在前）", () => {
    const dir = tempDir();
    const store = new BookmarksStore(dir, { now: clock() });
    store.add({ url: "https://a.example.com/1", title: "一" });
    store.add({ url: "https://a.example.com/2", title: "二" });
    store.add({ url: "https://a.example.com/3", title: "三" });
    expect(store.list().map((item) => item.title)).toEqual(["三", "二", "一"]);
  });

  it("remove：存在返回 true 并落盘；不存在/空 id 返回 false", () => {
    const dir = tempDir();
    const store = new BookmarksStore(dir, { now: clock() });
    const added = store.add({ url: "https://remove.example.com" });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(store.remove(added.bookmark.id)).toBe(true);
    expect(store.list()).toHaveLength(0);
    expect(store.remove(added.bookmark.id)).toBe(false);
    expect(store.remove("")).toBe(false);
    const persisted = readFileJson(store.filePath) as { items: unknown[] };
    expect(persisted.items).toHaveLength(0);
  });

  it("上限：超过 maxItems 淘汰最旧（默认上限常量 500）", () => {
    expect(MAX_BOOKMARKS).toBe(500);
    const dir = tempDir();
    const store = new BookmarksStore(dir, { now: clock(), maxItems: 3 });
    const now = clock();
    const limited = new BookmarksStore(tempDir(), { now, maxItems: 3 });
    const first = limited.add({ url: "https://keep.example.com/1", title: "1" });
    limited.add({ url: "https://keep.example.com/2", title: "2" });
    limited.add({ url: "https://keep.example.com/3", title: "3" });
    limited.add({ url: "https://keep.example.com/4", title: "4" });
    expect(limited.list().map((item) => item.title)).toEqual(["4", "3", "2"]);
    expect(first.ok).toBe(true);
    // 默认构造（500）在少量数据下不淘汰
    store.add({ url: "https://keep.example.com/1" });
    expect(store.list()).toHaveLength(1);
  });
});

describe("BookmarksStore · 持久化 / 损坏恢复 / 写失败", () => {
  it("跨实例持久化：重新构造读到同一批书签", () => {
    const dir = tempDir();
    const first = new BookmarksStore(dir, { now: clock() });
    first.add({ url: "https://persist.example.com/a", title: "A" });
    first.add({ url: "https://persist.example.com/b", title: "B" });
    const second = new BookmarksStore(dir);
    expect(second.list().map((item) => item.title)).toEqual(["B", "A"]);
  });

  it("损坏文件：以空库启动，原文件改名为 .corrupt-<ts> 保留现场", () => {
    const dir = tempDir();
    const file = path.join(dir, "bookmarks.json");
    fs.writeFileSync(file, "{ 这不是 json", "utf8");
    const store = new BookmarksStore(dir, { now: clock() });
    expect(store.list()).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
    const backups = fs.readdirSync(dir).filter((name) => name.startsWith("bookmarks.json.corrupt-"));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, backups[0]), "utf8")).toBe("{ 这不是 json");
    // 损坏恢复后仍可正常写入
    expect(store.add({ url: "https://after-corrupt.example.com" }).ok).toBe(true);
  });

  it("结构不合法（非对象 / items 非数组）同样隔离后空库", () => {
    for (const bad of ["[]", "null", JSON.stringify({ version: 1, items: "nope" })]) {
      const dir = tempDir();
      fs.writeFileSync(path.join(dir, "bookmarks.json"), bad, "utf8");
      const store = new BookmarksStore(dir);
      expect(store.list(), bad).toEqual([]);
      expect(fs.readdirSync(dir).some((name) => name.startsWith("bookmarks.json.corrupt-"))).toBe(true);
    }
  });

  it("部分字段不合法的条目丢弃，其余保留（不整体隔离）", () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, "bookmarks.json"),
      JSON.stringify({
        version: 1,
        items: [
          { id: "bm-1", url: "https://ok.example.com/", title: "正常", createdAt: 2 },
          { id: "bm-2", url: "javascript:alert(1)", title: "坏 URL", createdAt: 1 },
          { id: "bm-3", title: "缺 url", createdAt: 1 },
          null,
        ],
      }),
      "utf8",
    );
    const store = new BookmarksStore(dir);
    expect(store.list().map((item) => item.title)).toEqual(["正常"]);
    expect(fs.readdirSync(dir).some((name) => name.startsWith("bookmarks.json.corrupt-"))).toBe(false);
  });

  it("写失败不抛异常：dataDir 不可写时 add 仍返回 ok（内存状态有效）", () => {
    const dir = tempDir();
    const notADir = path.join(dir, "not-a-dir.txt");
    fs.writeFileSync(notADir, "x", "utf8");
    const store = new BookmarksStore(notADir, { now: clock() });
    expect(() => store.add({ url: "https://write-fail.example.com" })).not.toThrow();
    const result = store.add({ url: "https://write-fail.example.com/2" });
    expect(result.ok).toBe(true);
    expect(store.list()).toHaveLength(2);
  });
});

describe("bookmarks 域（受信 IPC）", () => {
  function assemble(store: BookmarksStore) {
    // trustedIpc 的 handler registry 是模块级单例（防生产重复注册）；测试里每个用例重新装配前先清空
    __resetHandlerRegistryForTests();
    const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
    registerBookmarksDomain(
      {
        ipc: {
          handle(channel: string, fn: (event: unknown, payload: unknown) => unknown) {
            handlers.set(channel, fn);
          },
        },
        audit: () => {},
      },
      store,
    );
    const event = { senderFrame: { url: "loopsoar://app/index.html" } };
    return async (channel: string, payload?: unknown): Promise<Record<string, unknown>> => {
      const handler = handlers.get(`loopsoar:${channel}`);
      if (!handler) throw new Error(`未注册通道 ${channel}`);
      return (await handler(event, payload)) as Record<string, unknown>;
    };
  }

  it("list 无参返回 {bookmarks}；add 返回 {ok,bookmark}；重复 add 带 duplicate", async () => {
    const store = new BookmarksStore(tempDir(), { now: clock() });
    const invoke = assemble(store);

    const empty = await invoke("bookmarks:list");
    expect(empty).toEqual({ bookmarks: [] });

    const added = await invoke("bookmarks:add", { url: " https://Domain.Example.com/a " });
    expect(added.ok).toBe(true);
    const bookmark = added.bookmark as { id: string; url: string; title: string };
    expect(bookmark.url).toBe("https://domain.example.com/a");
    expect(bookmark.title).toBe("domain.example.com");

    const duplicate = await invoke("bookmarks:add", { url: "https://domain.example.com/a" });
    expect(duplicate.ok).toBe(true);
    expect(duplicate.duplicate).toBe(true);
    expect((duplicate.bookmark as { id: string }).id).toBe(bookmark.id);

    const list = await invoke("bookmarks:list");
    expect(list.bookmarks).toHaveLength(1);
  });

  it("add 非 http 协议：ok=false + 可读 error（不抛异常）", async () => {
    const store = new BookmarksStore(tempDir());
    const invoke = assemble(store);
    const result = await invoke("bookmarks:add", { url: "javascript:alert(1)" });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/仅支持 http\/https/);
    expect(store.list()).toHaveLength(0);
  });

  it("remove 返回 {ok}；非法 payload 被受信 IPC 参数校验拒绝", async () => {
    const store = new BookmarksStore(tempDir(), { now: clock() });
    const invoke = assemble(store);
    const added = await invoke("bookmarks:add", { url: "https://rm.example.com" });
    const id = (added.bookmark as { id: string }).id;

    expect(await invoke("bookmarks:remove", { id })).toEqual({ ok: true });
    expect(await invoke("bookmarks:remove", { id })).toEqual({ ok: false });

    // 非法参数（url 缺失/非字符串）在 trustedIpc 的 zod 校验层被拒
    let threw = false;
    try {
      await invoke("bookmarks:add", { url: 123 });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
