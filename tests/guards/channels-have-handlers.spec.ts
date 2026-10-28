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
import { AgentRegistry, BUILTIN_AGENT } from "../../packages/core/src/agent.ts";
import { registerWindowDomain } from "../../packages/shell/src/main/domains/window.ts";
import { registerMemoryDomain } from "../../packages/shell/src/main/domains/memory.ts";
import { registerExtensionsDomain } from "../../packages/shell/src/main/domains/extensions.ts";
import { registerSkillsDomain } from "../../packages/shell/src/main/domains/skills.ts";
import { registerMcpDomain } from "../../packages/shell/src/main/domains/mcp.ts";
import { MemoryStore } from "../../packages/core/src/memory/store.ts";
import { getHandlerRegistry, handleTrusted, type TrustedIpcDeps } from "../../packages/shell/src/main/trustedIpc.ts";
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

function assemble(): void {
  const deps = fakeDeps();
  registerRuntimeDomain(deps);
  registerWorkspaceDomain({
    ...deps,
    platform: {} as LoopsoarPlatform,
  });
  registerAgentsDomain({ ...deps, agents: fakeAgentRegistry() });
  registerChatDomain({ ...deps, chatService: fakeChatService(), push: () => {} });
  registerBrowserDomain(deps);
  registerSettingsDomain({
    ...deps,
    platform: {} as LoopsoarPlatform,
    dataDir: "C:/tmp/loopsoar-data-test",
    configDir: "C:/tmp/loopsoar-data-test/config",
    workspaceRoot: "C:/tmp/loopsoar-workspace-test",
    env: {},
    appVersion: "0.0.0-test",
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
