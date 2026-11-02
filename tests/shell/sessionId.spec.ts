/**
 * 会话 ID 净化：合法/非法边界 + "." / ".." / 路径分隔符穿越；以及 SessionStore 落盘路径必须经过净化。
 * 安全目标：IPC 传入的 sessionId 绝不能把会话文件写到数据目录之外。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  requireSessionId,
  sanitizeSessionId,
} from "../../packages/shell/src/main/sessionId.ts";
import { SessionStore } from "../../packages/shell/src/main/sessionStore.ts";

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-sid-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe("sanitizeSessionId", () => {
  it("合法：字母数字开头 + [A-Za-z0-9._-]，最长 120", () => {
    for (const id of ["a", "A1", "sess-abc123", "sess-1.a_b-c", "0", "a".repeat(120)]) {
      expect(sanitizeSessionId(id), id).toBe(id);
    }
  });

  it("拒绝空/null/undefined/超长", () => {
    expect(sanitizeSessionId("")).toBeNull();
    expect(sanitizeSessionId(null)).toBeNull();
    expect(sanitizeSessionId(undefined)).toBeNull();
    expect(sanitizeSessionId("a".repeat(121))).toBeNull();
  });

  it("拒绝 . / ..（目录穿越最小形态）", () => {
    expect(sanitizeSessionId(".")).toBeNull();
    expect(sanitizeSessionId("..")).toBeNull();
    expect(sanitizeSessionId("...")).toBeNull();
  });

  it("拒绝 path 分隔符与穿越片段（. 本身在非首位是合法字符，只有扁平 id 才安全）", () => {
    for (const id of [
      "../evil",
      "..\\evil",
      "a/b",
      "a\\b",
      "/abs",
      "C:\\windows",
      "sess/../x",
      "..sess",
    ]) {
      expect(sanitizeSessionId(id), id).toBeNull();
    }
    // 契约允许内部出现 "."（不构成路径穿越），仅首字符不能是符号
    expect(sanitizeSessionId("sess..1")).toBe("sess..1");
  });

  it("拒绝空白、中文、控制字符、以符号开头", () => {
    for (const id of [" a", "a ", "a b", "会话", "a\nb", "a\u0000b", "-abc", "_abc", ".abc", "*"]) {
      expect(sanitizeSessionId(id), id).toBeNull();
    }
  });

  it("requireSessionId：合法原样返回，非法抛可读错误", () => {
    expect(requireSessionId("sess-ok")).toBe("sess-ok");
    expect(() => requireSessionId("..")).toThrow(/非法会话 ID/);
    expect(() => requireSessionId("../x")).toThrow(/非法会话 ID/);
    expect(() => requireSessionId(null)).toThrow(/非法会话 ID/);
  });
});

describe("SessionStore：所有落盘路径先净化（非法 ID 不落盘）", () => {
  it("合法会话读写正常，loadMessages 按会话返回消息", () => {
    const dir = tempDir();
    const store = new SessionStore(dir);
    const { sessionId } = store.newSession();
    store.append(sessionId, "问题", "回答");
    expect(store.loadMessages(sessionId)?.map((m) => m.text)).toEqual(["问题", "回答"]);
    expect(store.loadMessages("sess-不存在")).toBeNull();
  });

  it("非法 ID 的读路径一律 null/false，写路径抛可读错误（不落盘）", () => {
    const dir = tempDir();
    const store = new SessionStore(dir);
    expect(store.get("../evil")).toBeNull();
    expect(store.getWorktree("../evil")).toBeNull();
    expect(store.getBrowserState("../../evil")).toBeNull();
    expect(store.remove("../evil")).toBe(false);
    expect(store.attachTimeline("../evil", [])).toBe(false);
    expect(store.truncate("../evil", 0)).toBeNull();
    expect(store.saveBrowserState("../evil", { tabs: [] } as never)).toBe(false);
    expect(store.setWorkspaceId("../evil", null)).toBe(false);
    expect(store.setWorktree("../evil", null)).toBe(false);
    expect(store.switchTo("../evil")).toBe(false);
    expect(() => store.save({ sessionId: "../evil", updatedAt: 1, messages: [] })).toThrow(/非法会话 ID/);
    // 关键断言：数据目录之外没有生成任何文件（净化必须在拼路径之前生效）
    expect(fs.existsSync(path.join(path.dirname(dir), "evil.json"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "..", "evil.json"))).toBe(false);
  });

  it("attachTimeline / truncate 显式非法 ID 不回退到当前会话（避免写错会话）", () => {
    const dir = tempDir();
    const store = new SessionStore(dir);
    const { sessionId } = store.newSession();
    store.append(sessionId, "q", "a");
    expect(store.attachTimeline("..", [{ kind: "think", text: "x" }])).toBe(false);
    expect(store.get(sessionId)?.messages.at(-1)?.timeline).toBeUndefined();
    expect(store.truncate("..", 0)).toBeNull();
    expect(store.get(sessionId)?.messages.length).toBe(2);
  });

  it("旧版 last.json 的非法 sessionId 不会用于拼路径（迁移时换新 ID）", () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, "last.json"),
      JSON.stringify({
        sessionId: "../../evil",
        updatedAt: 1,
        messages: [{ role: "user", text: "旧会话", ts: 1 }],
      }),
      "utf8",
    );
    const store = new SessionStore(dir);
    expect(store.list()).toHaveLength(1);
    const id = store.list()[0].id;
    expect(sanitizeSessionId(id)).toBe(id);
    // "../../evil" 若被直接拼接会落在祖父目录；迁移后必须不产生该文件
    expect(fs.existsSync(path.join(dir, "..", "..", "evil.json"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "..", "evil.json"))).toBe(false);
  });
});
