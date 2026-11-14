/**
 * chat:setBrowserControl 域接线（第二阶段 · 功能1）。
 * 只装配 chat 域 + 真实 SessionStore（临时目录），不 import electron。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { __resetHandlerRegistryForTests } from "../../packages/shell/src/main/trustedIpc.ts";
import { registerChatDomain, type ChatDeps } from "../../packages/shell/src/main/domains/chat.ts";
import { SessionStore } from "../../packages/shell/src/main/sessionStore.ts";

let dir: string;

function makeEnv(): {
  sessions: SessionStore;
  handlers: Map<string, (e: unknown, p: unknown) => Promise<unknown>>;
} {
  const sessions = new SessionStore(dir);
  const handlers = new Map<string, (e: unknown, p: unknown) => Promise<unknown>>();
  const deps = {
    ipc: {
      handle: (channel: string, fn: unknown) => {
        handlers.set(channel.replace(/^loopsoar:/, ""), fn as never);
      },
    },
    audit: () => {},
    // 本用例只碰会话通道；其余 chat 通道注册时不会执行到这里（惰性调用）
    chatService: {} as never,
    push: () => {},
    sessions,
  } as ChatDeps;
  registerChatDomain(deps);
  return { sessions, handlers };
}

const TRUSTED = { senderFrame: { url: "loopsoar://app/index.html" } };

async function invoke(
  handlers: Map<string, (e: unknown, p: unknown) => Promise<unknown>>,
  channel: string,
  payload?: unknown,
): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`未注册 handler：${channel}`);
  return handler(TRUSTED, payload);
}

beforeEach(() => {
  __resetHandlerRegistryForTests();
  dir = mkdtempSync(path.join(tmpdir(), "loopsoar-browser-control-domain-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("chat:setBrowserControl", () => {
  it("开启 → { ok: true }，会话与索引都更新（下一轮 stream 的工具面据此生效）", async () => {
    const { sessions, handlers } = makeEnv();
    const { sessionId } = sessions.newSession();

    const result = await invoke(handlers, "chat:setBrowserControl", { sessionId, enabled: true });

    expect(result).toEqual({ ok: true });
    expect(sessions.get(sessionId)?.browserControl).toBe(true);
    expect(sessions.list().find((item) => item.id === sessionId)?.browserControl).toBe(true);
  });

  it("关闭 → { ok: true }，字段落为 false", async () => {
    const { sessions, handlers } = makeEnv();
    const { sessionId } = sessions.newSession();
    await invoke(handlers, "chat:setBrowserControl", { sessionId, enabled: true });

    const result = await invoke(handlers, "chat:setBrowserControl", { sessionId, enabled: false });

    expect(result).toEqual({ ok: true });
    expect(sessions.get(sessionId)?.browserControl).toBe(false);
  });

  it("会话不存在 → { ok: false }（fail-closed，不新建会话文件）", async () => {
    const { sessions, handlers } = makeEnv();

    const result = await invoke(handlers, "chat:setBrowserControl", {
      sessionId: "sess-missing",
      enabled: true,
    });

    expect(result).toEqual({ ok: false });
    expect(sessions.get("sess-missing")).toBeNull();
  });

  it("参数非法（enabled 不是布尔 / sessionId 含路径分隔符）→ 拒绝，不落库", async () => {
    const { sessions, handlers } = makeEnv();
    const { sessionId } = sessions.newSession();

    await expect(invoke(handlers, "chat:setBrowserControl", { sessionId, enabled: "yes" })).rejects.toThrow();
    await expect(
      invoke(handlers, "chat:setBrowserControl", { sessionId: "../evil", enabled: true }),
    ).rejects.toThrow();
    expect(sessions.get(sessionId)?.browserControl).toBeUndefined();
  });
});
