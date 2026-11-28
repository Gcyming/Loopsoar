/**
 * 守卫：manifest 每条通道必有 handler；registry 中通道必在 manifest（无死码，发布门 2 前置）。
 * 通过域注册函数 + 假 ipc 对象装配，不 import electron。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { IPC_CHANNELS } from "../../packages/contracts/gen/ipc.ts";
import { registerRuntimeDomain } from "../../packages/shell/src/main/domains/runtime.ts";
import { registerWorkspaceDomain } from "../../packages/shell/src/main/domains/workspace.ts";
import { registerAgentsDomain } from "../../packages/shell/src/main/domains/agents.ts";
import { registerChatDomain } from "../../packages/shell/src/main/domains/chat.ts";
import { registerBrowserDomain } from "../../packages/shell/src/main/domains/browserAdapter.ts";
import { registerSettingsDomain } from "../../packages/shell/src/main/domains/settings.ts";
import { registerUpdateDomain } from "../../packages/shell/src/main/domains/update.ts";
import { registerRuleLearningDomain } from "../../packages/shell/src/main/domains/ruleLearning.ts";
import { RuleCandidateStore } from "../../packages/shell/src/main/ruleCandidates.ts";
import { AgentRegistry, BUILTIN_AGENT } from "../../packages/core/src/agent.ts";
import { registerWindowDomain } from "../../packages/shell/src/main/domains/window.ts";
import { registerMemoryDomain } from "../../packages/shell/src/main/domains/memory.ts";
import { registerExtensionsDomain } from "../../packages/shell/src/main/domains/extensions.ts";
import { registerSkillsDomain } from "../../packages/shell/src/main/domains/skills.ts";
import { registerMcpDomain } from "../../packages/shell/src/main/domains/mcp.ts";
import { registerFsDomain } from "../../packages/shell/src/main/domains/fs.ts";
import { registerDocumentsDomain } from "../../packages/shell/src/main/domains/documents.ts";
import { registerTerminalDomain } from "../../packages/shell/src/main/domains/terminal.ts";
import type { TerminalSessionManager } from "../../packages/shell/src/main/terminalSession.ts";
import { registerAskDomain } from "../../packages/shell/src/main/domains/ask.ts";
import { registerLoopDomain } from "../../packages/shell/src/main/domains/loop.ts";
import { AskBus } from "../../packages/shell/src/main/askBus.ts";
import type { LoopRuntime } from "../../packages/shell/src/main/loopRuntime.ts";
import { registerBookmarksDomain } from "../../packages/shell/src/main/domains/bookmarks.ts";
import { BookmarksStore } from "../../packages/shell/src/main/bookmarksStore.ts";
import { ShortcutsStore } from "../../packages/shell/src/main/shortcutsStore.ts";
import { registerShortcutsDomain } from "../../packages/shell/src/main/domains/shortcuts.ts";
import { registerPageSaveDomain } from "../../packages/shell/src/main/domains/pageSave.ts";
import { registerToastDomain } from "../../packages/shell/src/main/domains/toast.ts";
import { registerCompactDomain } from "../../packages/shell/src/main/domains/compact.ts";
import { registerChromePopoverDomain } from "../../packages/shell/src/main/domains/chromePopover.ts";
import { registerAgentWindowDomain } from "../../packages/shell/src/main/domains/agentWindow.ts";
import { registerBrowserWindowDomain } from "../../packages/shell/src/main/browserWindow.ts";
import type { ChromePopoverManager } from "../../packages/shell/src/main/chromePopover.ts";
import { SessionStore } from "../../packages/shell/src/main/sessionStore.ts";
import { MemoryStore } from "../../packages/core/src/memory/store.ts";
import { getHandlerRegistry, handleTrusted, type TrustedIpcDeps } from "../../packages/shell/src/main/trustedIpc.ts";
import { createScheduledTaskRuntime } from "../../packages/shell/src/main/scheduledTaskRuntime.ts";
import os from "node:os";
import path from "node:path";
import type { LoopsoarPlatform } from "../../packages/core/src/platform/types.ts";

function fakeDeps(): TrustedIpcDeps {
  return {
    ipc: { handle: (_channel: string, _fn: unknown) => {} },
    audit: () => {},
  };
}

/** 假 ChatService：本守卫只验证「通道有 handler」，不触发流式逻辑。 */
function fakeChatService(): never {
  return {
    stream: async () => ({}),
    stop: () => false,
    resolvePermission: () => false,
  } as never;
}

function fakeAgentRegistry(): AgentRegistry {
  const reg = new AgentRegistry();
  reg.registerBuiltin(BUILTIN_AGENT);
  return reg;
}

/** 假终端管理器：本守卫只验证「通道有 handler」，不启动真实子进程。 */
function fakeTerminalManager(): TerminalSessionManager {
  return {
    profiles: async () => [],
    list: () => [],
    open: async () => {
      throw new Error("守卫测试不启动终端");
    },
    input: () => ({ ok: false }),
    run: async () => ({ ok: false }),
    interrupt: () => false,
    close: () => false,
    closeSession: () => 0,
    closeAll: () => {},
    history: () => null,
  } as unknown as TerminalSessionManager;
}

/** 假 Agent-Loop 运行时：只暴露域注册所需的 list/setActive。 */
function fakeLoopRuntime(): LoopRuntime {
  return {
    registry: {} as never,
    run: async () => ({ status: "done", reason: "guard", finalText: "", usage: { rounds: 0, toolCalls: 0, totalTokens: 0, wallClockMs: 0 } }),
    list: () => ({ loops: [], activeId: null, fallbacks: [] }),
    setActive: () => ({ ok: false, error: "守卫测试" }),
  } as unknown as LoopRuntime;
}

function assemble(): void {
  const deps = fakeDeps();
  registerRuntimeDomain(deps);
  registerWorkspaceDomain({
    ...deps,
    platform: {} as LoopsoarPlatform,
  });
  registerAgentsDomain({ ...deps, agents: fakeAgentRegistry() });
  registerChatDomain({ ...deps, chatService: fakeChatService(), push: () => {} });
  // 定时任务运行时会自行注册 schedule:* 四个受信通道；用临时目录避免污染真实数据。
  createScheduledTaskRuntime({
    dataDir: path.join(os.tmpdir(), "loopsoar-guard-schedules"),
    chatDeps: { ...deps, chatService: fakeChatService(), push: () => {} } as never,
    push: () => {},
  });
  registerBrowserDomain(deps);
  registerTerminalDomain(deps, fakeTerminalManager());
  registerAskDomain(deps, new AskBus({ push: () => {} }));
  registerLoopDomain(deps, fakeLoopRuntime());
  registerBookmarksDomain(deps, new BookmarksStore("C:/tmp/loopsoar-data-test/bookmarks"));
  registerShortcutsDomain(deps, new ShortcutsStore("C:/tmp/loopsoar-data-test/shortcuts"));
  registerPageSaveDomain({ ...deps, dataDir: "C:/tmp/loopsoar-data-test" });
  registerToastDomain({ ...deps, showToast: () => {} });
  registerCompactDomain({
    ...deps,
    sessions: new SessionStore("C:/tmp/loopsoar-data-test/sessions"),
    push: () => {},
  });
  const fakeChromePopover: ChromePopoverManager = {
    open: () => ({ ok: true }),
    close: () => {},
    handleAction: () => {},
    isOpen: () => false,
    dispose: () => {},
  };
  registerChromePopoverDomain(
    { ...deps, push: () => {}, getMainWebContentsId: () => 1 },
    fakeChromePopover,
  );
  registerAgentWindowDomain({ ...deps, push: () => {}, getMainWebContentsId: () => 1 }, {
    open: () => ({ ok: true }),
    close: () => {},
    isOpen: () => false,
    focus: () => false,
    minimize: () => false,
    reposition: () => false,
    webContentsId: () => null,
    onClosed: () => () => {},
    dispose: () => {},
  });
  registerBrowserWindowDomain({ ...deps, openWindow: () => ({ ok: true }) });
  registerSettingsDomain({
    ...deps,
    platform: {} as LoopsoarPlatform,
    dataDir: "C:/tmp/loopsoar-data-test",
    configDir: "C:/tmp/loopsoar-data-test/config",
    workspaceRoot: "C:/tmp/loopsoar-workspace-test",
    env: {},
    appVersion: "0.0.0-test",
  });
  registerUpdateDomain({
    ...deps,
    updater: {
      status: () => ({ state: "disabled" }),
      check: async () => ({ state: "disabled" }),
      download: async () => ({ state: "disabled" }),
      install: async () => ({ ok: false, error: "disabled" }),
      isInstalling: () => false,
      scheduleStartupCheck: () => undefined,
    },
  });
  registerRuleLearningDomain({
    ...deps,
    dataDir: "C:/tmp/loopsoar-data-test",
    store: new RuleCandidateStore("C:/tmp/loopsoar-data-test/rules/candidates.json"),
    workspaces: { list: () => [], activeId: () => null },
    push: () => {},
  });
  registerMemoryDomain({
    ...deps,
    memory: {
      list: () => [],
      stats: () => ({ total: 0, active: 0, archived: 0, links: 0, totalAccess: 0, byCategory: {} }),
      get: () => null,
      filePath: "C:/tmp/loopsoar-memory.json",
      add: async () => ({}),
      update: async () => null,
      remove: async () => true,
      clear: async () => {},
      captureFromTurn: async () => ({ added: 0, merged: 0, deduped: 0 }),
      recallPrompt: () => "",
    } as never,
    push: () => {},
  });
  registerExtensionsDomain({
    ...deps,
    extensions: {
      scan: () => ({ installed: 0, skipped: [] }),
      list: () => [],
      setEnabled: () => null,
      remove: () => false,
      dirPath: () => "C:/tmp/loopsoar-ext-test",
      promptSummary: () => "",
    } as never,
    push: () => {},
    openExtensionsDir: async () => true,
  });
  registerSkillsDomain({
    ...deps,
    skills: {
      scan: () => ({ installed: 0, skipped: [] }),
      list: () => [],
      setEnabled: () => null,
      dirPath: () => "C:/tmp/loopsoar-skills-test",
      promptFor: () => "",
    } as never,
    push: () => {},
    openSkillsDir: async () => true,
  });
  registerFsDomain(deps);
  registerDocumentsDomain({ ...deps, openDocument: async () => ({ ok: true }) });
  registerMcpDomain({
    ...deps,
    mcp: {
      list: () => [],
      add: (cfg: { name: string; command: string }) => ({ ...cfg, id: cfg.name, args: [], enabled: true, state: "idle", tools: [] }),
      remove: () => true,
      connect: async () => null,
      disconnect: () => true,
    } as never,
    push: () => {},
    mcpConfigPath: "C:/tmp/loopsoar-mcp.json",
  });
  registerWindowDomain({
    ...deps,
    windowControls: {
      minimize: () => {},
      toggleMaximize: () => {},
      close: () => {},
      isMaximized: () => false,
      isFocused: () => true,
    },
  });
}

describe("守卫：IPC 通道与 handler 双向一致（无死码）", () => {
  beforeEach(() => {
    // trustedIpc 的注册表是模块级单例；本文件只装配一次即可，但为隔离副作用，
    // 每次测试前清空（通过重新导入模块实现——vitest 模块缓存下直接使用已有单例，
    // 若重复装配会因重复注册抛错，因此只在一个 it 中完成双向断言）。
  });

  it("manifest 每条通道都有 handler；registry 无死码", () => {
    assemble();
    const registry = getHandlerRegistry();
    const manifestChannels = Object.keys(IPC_CHANNELS);
    const registryChannels = Array.from(registry.keys());

    for (const ch of manifestChannels) {
      expect(registry.has(ch), `manifest 通道 ${ch} 缺少 handler`).toBe(true);
    }
    for (const ch of registryChannels) {
      expect(manifestChannels.includes(ch), `registry 存在 manifest 外的死码通道 ${ch}`).toBe(true);
    }
  });

  it("未在契约内的通道注册会被拒绝（fail-closed）", () => {
    const deps = fakeDeps();
    expect(() => {
      handleTrusted(deps, "evil:channel", () => ({}));
    }).toThrow(/不在契约/);
  });
});
