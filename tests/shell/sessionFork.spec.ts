/**
 * 会话分支：复制到指定消息为止的前缀，原会话完全不动；元信息标记来源。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore, type PersistedMessage } from "../../packages/shell/src/main/sessionStore.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-fork-"));
}

function msg(role: "user" | "assistant", text: string): PersistedMessage {
  return { role, text, ts: 1 } as PersistedMessage;
}

describe("SessionStore.fork", () => {
  it("复制前缀到新会话并保留来源；源会话不受影响", () => {
    const store = new SessionStore(tmpDir());
    const source = store.newSession("ws-1");
    store.save({
      ...source,
      messages: [msg("user", "u1"), msg("assistant", "a1"), msg("user", "u2"), msg("assistant", "a2")],
      browserControl: true,
    });

    const forked = store.fork(source.sessionId, 2, "分支测试");
    expect(forked).not.toBeNull();
    expect(forked!.sessionId).not.toBe(source.sessionId);
    expect(forked!.messages.map((m) => m.text)).toEqual(["u1", "a1"]);
    expect(forked!.forkedFrom).toEqual({ sessionId: source.sessionId, keepCount: 2, at: expect.any(Number) });
    expect(forked!.workspaceId).toBe("ws-1");
    expect(forked!.browserControl).toBe(true);
    // 原会话四条消息一条不少
    expect(store.get(source.sessionId)?.messages.map((m) => m.text)).toEqual(["u1", "a1", "u2", "a2"]);

    const meta = store.list().find((item) => item.id === forked!.sessionId);
    expect(meta?.title).toBe("分支测试");
    expect(meta?.forkedFrom?.sessionId).toBe(source.sessionId);
    expect(store.currentId()).toBe(forked!.sessionId);
  });

  it("keepCount 越界会夹紧；源会话不存在返回 null（不新建）", () => {
    const store = new SessionStore(tmpDir());
    const source = store.newSession();
    store.save({ ...source, messages: [msg("user", "only")] });
    const clamped = store.fork(source.sessionId, 999);
    expect(clamped?.messages.length).toBe(1);
    expect(clamped?.forkedFrom?.keepCount).toBe(1);
    expect(store.fork("../../evil", 1)).toBeNull();
    expect(store.fork("sess-missing", 1)).toBeNull();
  });
});
