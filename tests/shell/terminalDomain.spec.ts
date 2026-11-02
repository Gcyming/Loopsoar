/**
 * terminal 域装配：8 个受信通道的注册 / 参数校验 / 返回直通。
 *
 * 为什么单独测域层：终端面板与 Agent 工具都依赖这 8 个通道的「名字 + 返回结构」，
 * 契约 manifest 里新增通道后如果域层漏注册，守卫测试会红、UI 表现为「点了没反应」；
 * 这里用假 manager 验证转发与 fail-closed 参数校验，不启动任何真实终端进程。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetHandlerRegistryForTests,
  getHandlerRegistry,
  type TrustedIpcDeps,
} from "../../packages/shell/src/main/trustedIpc.ts";
import { registerTerminalDomain } from "../../packages/shell/src/main/domains/terminal.ts";
import type { TerminalSessionManager } from "../../packages/shell/src/main/terminalSession.ts";

const CHANNELS = [
  "terminal:profiles",
  "terminal:list",
  "terminal:open",
  "terminal:input",
  "terminal:run",
  "terminal:interrupt",
  "terminal:close",
  "terminal:history",
] as const;

const TRUSTED_EVENT = { senderFrame: { url: "loopsoar://app/index.html" } };

type WrappedHandler = (event: unknown, payload: unknown) => Promise<unknown> | unknown;

function fakeDeps(): TrustedIpcDeps {
  return {
    ipc: { handle: () => undefined },
    audit: () => undefined,
  };
}

function fakeManager() {
  const calls: string[] = [];
  const manager = {
    profiles: async () => [
      {
        key: "cmd" as const,
        label: "命令提示符",
        description: "Windows cmd.exe",
        available: true,
        version: "10.0",
        kind: "shell" as const,
      },
    ],
    list: () => [],
    open: async (input: { sessionId?: string; profile: string; cwd?: string }) => {
      calls.push(`open:${input.profile}`);
      return {
        terminalId: "term-test-0001",
        sessionId: input.sessionId ?? "",
        profile: input.profile,
        cwd: input.cwd ?? "C:\\workspace",
        state: "ready" as const,
        createdAt: 1,
        label: "命令提示符",
      };
    },
    input: (terminalId: string, data: string) => {
      calls.push(`input:${terminalId}:${data}`);
      return { ok: true };
    },
    run: async (terminalId: string, command: string) => {
      calls.push(`run:${terminalId}:${command}`);
      return { ok: true };
    },
    interrupt: (terminalId: string) => {
      calls.push(`interrupt:${terminalId}`);
      return true;
    },
    close: (terminalId: string) => {
      calls.push(`close:${terminalId}`);
      return true;
    },
    closeSession: () => 0,
    closeAll: () => undefined,
    history: (terminalId: string) => ({
      terminalId,
      profile: "cmd",
      state: "ready",
      data: "hello",
    }),
  } as unknown as TerminalSessionManager;
  return { manager, calls };
}

function assemble() {
  const { manager, calls } = fakeManager();
  registerTerminalDomain(fakeDeps(), manager);
  return { calls };
}

function handlerOf(channel: string): WrappedHandler {
  const entry = getHandlerRegistry().get(channel);
  if (!entry) throw new Error(`通道未注册：${channel}`);
  return entry.handler as unknown as WrappedHandler;
}

describe("terminal 域装配（受信 IPC）", () => {
  beforeEach(() => {
    __resetHandlerRegistryForTests();
  });

  it("注册全部 8 个 terminal 通道（无遗漏、无死码）", () => {
    assemble();
    const registry = getHandlerRegistry();
    for (const channel of CHANNELS) {
      expect(registry.has(channel), `缺少通道 ${channel}`).toBe(true);
    }
    const terminalChannels = Array.from(registry.keys()).filter((channel) => channel.startsWith("terminal:"));
    expect(terminalChannels.sort()).toEqual([...CHANNELS].sort());
  });

  it("返回结构直通 manager：profiles / list / open / input / interrupt / close / history", async () => {
    const { calls } = assemble();
    const profiles = (await handlerOf("terminal:profiles")(TRUSTED_EVENT, undefined)) as Array<{ key: string }>;
    expect(Array.isArray(profiles)).toBe(true);
    expect(profiles[0]!.key).toBe("cmd");

    // 无参通道（list）传 undefined 才合法
    expect(await handlerOf("terminal:list")(TRUSTED_EVENT, undefined)).toEqual([]);

    const opened = (await handlerOf("terminal:open")(TRUSTED_EVENT, {
      profile: "cmd",
      cwd: "C:\\workspace",
    })) as { terminalId: string; state: string };
    expect(opened.terminalId).toBe("term-test-0001");
    expect(opened.state).toBe("ready");
    expect(calls).toContain("open:cmd");

    expect(await handlerOf("terminal:input")(TRUSTED_EVENT, { terminalId: "term-test-0001", data: "dir\r\n" })).toEqual({
      ok: true,
    });
    expect(await handlerOf("terminal:run")(TRUSTED_EVENT, { terminalId: "term-test-0001", command: "dir" })).toEqual({
      ok: true,
    });
    expect(await handlerOf("terminal:interrupt")(TRUSTED_EVENT, { terminalId: "term-test-0001" })).toBe(true);
    expect(await handlerOf("terminal:close")(TRUSTED_EVENT, { terminalId: "term-test-0001" })).toBe(true);
    expect(await handlerOf("terminal:history")(TRUSTED_EVENT, { terminalId: "term-test-0001" })).toMatchObject({
      terminalId: "term-test-0001",
      profile: "cmd",
      data: "hello",
    });
  });

  it("参数校验 fail-closed：非法 profile / 非法 terminalId 被契约 schema 拒绝", async () => {
    assemble();
    await expect(handlerOf("terminal:open")(TRUSTED_EVENT, { profile: "bash" })).rejects.toThrow(/参数校验失败/);
    await expect(
      handlerOf("terminal:input")(TRUSTED_EVENT, { terminalId: "bad-id", data: "ls\r\n" }),
    ).rejects.toThrow(/参数校验失败/);
    // terminalId 必须匹配 term-[A-Za-z0-9_-]+
    await expect(handlerOf("terminal:close")(TRUSTED_EVENT, { terminalId: "term-ok_1" })).resolves.toBe(true);
  });

  it("帧来源不可信 → 拒绝（终端通道同样是受信通道）", async () => {
    assemble();
    await expect(
      handlerOf("terminal:profiles")({ senderFrame: { url: "https://evil.com/" } }, undefined),
    ).rejects.toThrow(/帧来源不可信/);
  });
});
