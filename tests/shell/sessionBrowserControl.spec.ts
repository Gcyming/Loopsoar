/**
 * 会话级「浏览器控制」持久化（第二阶段 · 功能1）。
 *
 * 断言三件事：
 *   1. 新会话默认关（缺省即关 = fail-closed，不依赖启动时写盘）；
 *   2. 开关同时落「会话文件 + 索引元信息」（UI 的列表/水合都读索引）；
 *   3. 非布尔脏值在读取/回写时被丢弃，不会让「开/关」出现第三种状态。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionStore } from "../../packages/shell/src/main/sessionStore.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "loopsoar-browser-control-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("SessionStore · browserControl", () => {
  it("新会话默认关闭（字段缺省，读出来不是 true）", () => {
    const store = new SessionStore(dir);
    const { sessionId } = store.newSession();
    expect(store.get(sessionId)?.browserControl).toBeUndefined();
    expect(store.list().find((item) => item.id === sessionId)?.browserControl).toBeUndefined();
  });

  it("开启 → 会话文件 + 索引都落盘，重启后仍为开启", () => {
    const store = new SessionStore(dir);
    const { sessionId } = store.newSession();
    expect(store.setBrowserControl(sessionId, true)).toBe(true);

    const onDisk = JSON.parse(readFileSync(path.join(dir, `${sessionId}.json`), "utf8")) as {
      browserControl?: unknown;
    };
    expect(onDisk.browserControl).toBe(true);

    // 新实例 = 进程重启：会话文件与索引各读各的，两处都必须一致
    const reloaded = new SessionStore(dir);
    expect(reloaded.get(sessionId)?.browserControl).toBe(true);
    expect(reloaded.list().find((item) => item.id === sessionId)?.browserControl).toBe(true);
  });

  it("关闭 → 覆盖为 false（再打开又是 true，可反复切换）", () => {
    const store = new SessionStore(dir);
    const { sessionId } = store.newSession();
    store.setBrowserControl(sessionId, true);
    store.setBrowserControl(sessionId, false);
    expect(new SessionStore(dir).get(sessionId)?.browserControl).toBe(false);
    store.setBrowserControl(sessionId, true);
    expect(new SessionStore(dir).get(sessionId)?.browserControl).toBe(true);
  });

  it("非法会话 ID / 不存在的会话 → false，且绝不新建文件", () => {
    const store = new SessionStore(dir);
    expect(store.setBrowserControl("../evil", true)).toBe(false);
    expect(store.setBrowserControl("sess-not-exist", true)).toBe(false);
    expect(existsSync(path.join(dir, "..", "evil.json"))).toBe(false);
    expect(store.get("sess-not-exist")).toBeNull();
  });

  it("会话文件里的非布尔脏值读取时丢弃", () => {
    const store = new SessionStore(dir);
    const { sessionId } = store.newSession();
    store.setBrowserControl(sessionId, true);
    const file = path.join(dir, `${sessionId}.json`);
    const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    data.browserControl = "yes";
    writeFileSync(file, JSON.stringify(data), "utf8");

    expect(new SessionStore(dir).get(sessionId)?.browserControl).toBeUndefined();
  });

  it("索引里的非布尔脏值读取时丢弃（UI 不会拿到 \"false\" 这种真值）", () => {
    const store = new SessionStore(dir);
    const { sessionId } = store.newSession();
    store.setBrowserControl(sessionId, true);
    const indexFile = path.join(dir, "index.json");
    const index = JSON.parse(readFileSync(indexFile, "utf8")) as {
      items: Array<Record<string, unknown>>;
    };
    index.items = index.items.map((item) => ({ ...item, browserControl: 1 }));
    writeFileSync(indexFile, JSON.stringify(index), "utf8");

    const meta = new SessionStore(dir).list().find((item) => item.id === sessionId);
    expect(meta?.browserControl).toBeUndefined();
  });

  it("save() 回写时不固化脏值（append 一轮对话后字段仍不存在）", () => {
    const store = new SessionStore(dir);
    const { sessionId } = store.newSession();
    const file = path.join(dir, `${sessionId}.json`);
    const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    data.browserControl = null;
    writeFileSync(file, JSON.stringify(data), "utf8");

    store.append(sessionId, "q", "a");

    const after = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect("browserControl" in after).toBe(false);
    expect(new SessionStore(dir).get(sessionId)?.browserControl).toBeUndefined();
  });

  it("save() 不会因为重建索引而丢掉已开启状态", () => {
    const store = new SessionStore(dir);
    const { sessionId } = store.newSession();
    store.setBrowserControl(sessionId, true);
    store.append(sessionId, "q", "a");
    expect(new SessionStore(dir).list().find((item) => item.id === sessionId)?.browserControl).toBe(true);
  });
});
