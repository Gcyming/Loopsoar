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
import { getHandlerRegistry, handleTrusted, type TrustedIpcDeps } from "../../packages/shell/src/main/trustedIpc.ts";
import type { LoopsoarPlatform } from "../../packages/core/src/platform/types.ts";

function fakeDeps(): TrustedIpcDeps {
  return {
    ipc: { handle: (_channel: string, _fn: unknown) => {} },
    audit: () => {},
  };
}

function assemble(): void {
  const deps = fakeDeps();
  registerRuntimeDomain(deps);
  registerWorkspaceDomain({
    ...deps,
    platform: {} as LoopsoarPlatform,
  });
  registerAgentsDomain(deps);
  registerChatDomain({ ...deps, push: () => {} });
  registerBrowserDomain(deps);
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
