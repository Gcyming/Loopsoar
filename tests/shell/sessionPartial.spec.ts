/**
 * 会话持久化「不丢尾巴」（m02515 截断根除）：
 *   · appendAssistantPartial 保存完整长正文（退出/异常中断时保住已生成内容）；
 *   · writeJson 原子写，不残留 .tmp，重载后内容逐字一致。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../packages/shell/src/main/sessionStore.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-partial-"));
}

describe("会话部分回复持久化", () => {
  it("appendAssistantPartial 保留完整长正文，重载后逐字一致", () => {
    const dir = tmpDir();
    try {
      const store = new SessionStore(dir);
      const { sessionId } = store.newSession();
      const long = `${"开头".repeat(10)}${"中间内容".repeat(6000)}${"结尾句子。"}`;
      expect(long.length).toBeGreaterThan(20_000);
      expect(store.appendAssistantPartial(sessionId, long)).toBe(true);
      const reloaded = new SessionStore(dir).get(sessionId);
      const assistant = reloaded?.messages.find((m) => m.role === "assistant");
      expect(assistant?.text).toBe(long);
      expect(assistant?.text.length).toBe(long.length);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("空文本不写入（避免产生空助手气泡）", () => {
    const dir = tmpDir();
    try {
      const store = new SessionStore(dir);
      const { sessionId } = store.newSession();
      expect(store.appendAssistantPartial(sessionId, "   \n ")).toBe(false);
      expect(store.get(sessionId)?.messages ?? []).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("原子写不残留 .tmp 文件", () => {
    const dir = tmpDir();
    try {
      const store = new SessionStore(dir);
      const { sessionId } = store.newSession();
      store.append(sessionId, "问题", "回答");
      const leftovers = fs.readdirSync(path.join(dir)).filter((f) => f.endsWith(".tmp"));
      expect(leftovers).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
