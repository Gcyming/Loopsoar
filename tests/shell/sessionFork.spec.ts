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

  it("后续 append/save 不会抹掉 task/forkedFrom/分支标题", () => {
    const store = new SessionStore(tmpDir());
    const source = store.newSession();
    store.save({ ...source, messages: [msg("user", "u1"), msg("assistant", "a1")] });
    const forked = store.fork(source.sessionId, 1, "分支 · 测试");
    expect(forked).not.toBeNull();
    store.setTask(forked!.sessionId, true);
    store.append(forked!.sessionId, "u2", "a2");
    const meta = store.list().find((item) => item.id === forked!.sessionId);
    expect(meta?.task).toBe(true);
    expect(meta?.forkedFrom?.sessionId).toBe(source.sessionId);
    expect(meta?.title).toBe("分支 · 测试");
  });

  it("任务标记独立于页面：setTask 落库到会话与索引，清掉即恢复普通会话", () => {
    const store = new SessionStore(tmpDir());
    const session = store.newSession();
    expect(store.setTask(session.sessionId, true)).toBe(true);
    expect(store.isTask(session.sessionId)).toBe(true);
    expect(store.list().find((item) => item.id === session.sessionId)?.task).toBe(true);
    expect(store.setTask(session.sessionId, false)).toBe(true);
    expect(store.isTask(session.sessionId)).toBe(false);
    expect(store.list().find((item) => item.id === session.sessionId)?.task).toBeUndefined();
  });

  it("旧索引丢失 task/forkedFrom 时，启动按会话文件修复", () => {
    const dir = tmpDir();
    const store = new SessionStore(dir);
    const source = store.newSession();
    store.save({ ...source, messages: [msg("user", "u1")] });
    const forked = store.fork(source.sessionId, 1, "分支 · 旧数据");
    store.setTask(forked!.sessionId, true);
    // 模拟旧版本 save() 把索引字段抹掉
    const indexPath = path.join(dir, "index.json");
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    for (const item of index.items) {
      delete item.task;
      delete item.forkedFrom;
    }
    fs.writeFileSync(indexPath, JSON.stringify(index), "utf8");
    const reopened = new SessionStore(dir);
    const meta = reopened.list().find((item) => item.id === forked!.sessionId);
    expect(meta?.task).toBe(true);
    expect(meta?.forkedFrom?.sessionId).toBe(source.sessionId);
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
