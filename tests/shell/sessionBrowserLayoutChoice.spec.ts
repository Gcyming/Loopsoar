/**
 * 会话级「打开网页时的窗口布局」记忆（第二阶段 Slice E · 功能②）。
 *
 * 断言四件事：
 *   1. 写入 → 落会话文件，重启（新实例）仍能读到；
 *   2. setBrowserLayoutChoice(null) 清除（回到「下次仍会问」）；
 *   3. 非法值读取/写入一律丢弃（宁可再问一次，也不要第三态）；
 *   4. 不进 SessionMeta（列表卡片不需要这个字段），且 save() 回写不固化脏值。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionStore } from "../../packages/shell/src/main/sessionStore.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "loopsoar-browser-layout-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("SessionStore · browserLayoutChoice", () => {
  it("新会话默认没有记忆（未选择 → 下次仍会问）", () => {
    const store = new SessionStore(dir);
    const { sessionId } = store.newSession();
    expect(store.get(sessionId)?.browserLayoutChoice).toBeUndefined();
  });

  it("写入 → 会话文件落盘，重启后仍读到（切走再切回也不再问）", () => {
    const store = new SessionStore(dir);
    const { sessionId } = store.newSession();
    expect(store.setBrowserLayoutChoice(sessionId, "agentWindow")).toBe(true);

    const onDisk = JSON.parse(readFileSync(path.join(dir, `${sessionId}.json`), "utf8")) as {
      browserLayoutChoice?: unknown;
    };
    expect(onDisk.browserLayoutChoice).toBe("agentWindow");
    expect(new SessionStore(dir).get(sessionId)?.browserLayoutChoice).toBe("agentWindow");

    // 两种取值都可反复切换
    store.setBrowserLayoutChoice(sessionId, "docked");
    expect(new SessionStore(dir).get(sessionId)?.browserLayoutChoice).toBe("docked");
  });

  it("setBrowserLayoutChoice(null) → 清除记忆（下次仍会问）", () => {
    const store = new SessionStore(dir);
    const { sessionId } = store.newSession();
    store.setBrowserLayoutChoice(sessionId, "docked");
    expect(store.setBrowserLayoutChoice(sessionId, null)).toBe(true);

    expect(new SessionStore(dir).get(sessionId)?.browserLayoutChoice).toBeUndefined();
    const onDisk = JSON.parse(readFileSync(path.join(dir, `${sessionId}.json`), "utf8")) as Record<string, unknown>;
    expect("browserLayoutChoice" in onDisk).toBe(false);
  });

  it("非法值（运行期塞进来的脏值）按清除处理，不落盘", () => {
    const store = new SessionStore(dir);
    const { sessionId } = store.newSession();
    store.setBrowserLayoutChoice(sessionId, "Docked" as never);
    expect(new SessionStore(dir).get(sessionId)?.browserLayoutChoice).toBeUndefined();
  });

  it("手工改坏的会话文件：读取时丢弃脏值", () => {
    const store = new SessionStore(dir);
    const { sessionId } = store.newSession();
    store.setBrowserLayoutChoice(sessionId, "docked");
    const file = path.join(dir, `${sessionId}.json`);
    const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    data.browserLayoutChoice = 1;
    writeFileSync(file, JSON.stringify(data), "utf8");

    expect(new SessionStore(dir).get(sessionId)?.browserLayoutChoice).toBeUndefined();
  });

  it("save() 回写时不固化脏值（append 一轮后字段消失）", () => {
    const store = new SessionStore(dir);
    const { sessionId } = store.newSession();
    const file = path.join(dir, `${sessionId}.json`);
    const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    data.browserLayoutChoice = "float";
    writeFileSync(file, JSON.stringify(data), "utf8");

    store.append(sessionId, "q", "a");
    const after = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect("browserLayoutChoice" in after).toBe(false);
  });

  it("不清扫已有记忆：save() 之后仍然保留", () => {
    const store = new SessionStore(dir);
    const { sessionId } = store.newSession();
    store.setBrowserLayoutChoice(sessionId, "agentWindow");
    store.append(sessionId, "q", "a");
    expect(new SessionStore(dir).get(sessionId)?.browserLayoutChoice).toBe("agentWindow");
  });

  it("不进 SessionMeta（列表只需要标题/预览，布局记忆只给工具链路读）", () => {
    const store = new SessionStore(dir);
    const { sessionId } = store.newSession();
    store.setBrowserLayoutChoice(sessionId, "docked");
    const meta = store.list().find((item) => item.id === sessionId) as unknown as Record<string, unknown>;
    expect(meta.browserLayoutChoice).toBeUndefined();
  });

  it("非法会话 ID / 不存在的会话 → false，且绝不新建文件", () => {
    const store = new SessionStore(dir);
    expect(store.setBrowserLayoutChoice("../evil", "docked")).toBe(false);
    expect(store.setBrowserLayoutChoice("sess-not-exist", "docked")).toBe(false);
    expect(existsSync(path.join(dir, "..", "evil.json"))).toBe(false);
    expect(store.get("sess-not-exist")).toBeNull();
  });
});
