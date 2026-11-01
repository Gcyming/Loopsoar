/**
 * 会话持久化：每条助手消息记录生成本轮的供应商/模型（历史悬停显示真实模型，不跟当前选择）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../packages/shell/src/main/sessionStore.ts";

describe("会话消息模型快照", () => {
  it("append 携带模型元信息，重新加载仍保留", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-session-"));
    try {
      const store = new SessionStore(dir);
      const { sessionId } = store.newSession();
      store.append(sessionId, "问题", "回答", { provider: "opencode-go", model: "glm-5.3" });
      const reloaded = new SessionStore(dir).get(sessionId);
      const assistant = reloaded?.messages.find((message) => message.role === "assistant");
      expect(assistant).toMatchObject({ role: "assistant", provider: "opencode-go", model: "glm-5.3" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("没有模型元信息时不写入空字段（兼容旧会话）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-session-"));
    try {
      const store = new SessionStore(dir);
      const { sessionId } = store.newSession();
      store.append(sessionId, "q", "a");
      const assistant = store.get(sessionId)?.messages.find((message) => message.role === "assistant");
      expect(assistant).toMatchObject({ role: "assistant", text: "a" });
      expect(assistant?.model).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
