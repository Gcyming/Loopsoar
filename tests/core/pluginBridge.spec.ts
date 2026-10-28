/**
 * 插件工具桥（ADR-0011）：host 登记 → registry 装配 → 卸载撤销。
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PluginHost } from "../../packages/core/src/plugin/host.ts";
import { bridgePluginTools } from "../../packages/core/src/tools/pluginBridge.ts";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import type { PluginManifest } from "../../packages/core/src/plugin/manifest.ts";

function mf(name: string, origin: PluginManifest["origin"] = "user"): PluginManifest {
  return { name, version: "1.0.0", origin, provides: ["tools"] };
}

describe("插件工具桥", () => {
  it("桥接后工具可查可用；权限映射正确", async () => {
    const host = new PluginHost();
    host.load({ manifest: mf("hello-plugin") });
    host.registerTools("hello-plugin", [
      {
        name: "hello_greet",
        description: "打招呼",
        permissions: { read: true },
        schema: z.object({ name: z.string() }),
        execute: async (args) => ({ ok: true, content: `你好 ${(args as { name: string }).name}` }),
      },
    ]);
    const registry = new ToolRegistry();
    const bridge = bridgePluginTools(registry, host, "hello-plugin");
    expect(bridge.registered).toEqual(["hello_greet"]);
    expect(registry.has("hello_greet")).toBe(true);
    const tool = registry.get("hello_greet")!;
    expect(tool.permissions.read).toBe(true);
    expect(tool.permissions.terminal).toBe(false);
    const result = await tool.execute({
      agentId: "a1",
      sessionId: "s1",
      platform: {} as never,
      params: { name: "Loopsoar" },
    });
    expect(result).toEqual({ ok: true, content: "你好 Loopsoar" });
  });

  it("同名冲突 → fail-closed（不静默覆盖，错误可读）", () => {
    const host = new PluginHost();
    host.load({ manifest: mf("dup-plugin") });
    host.registerTools("dup-plugin", [
      { name: "file_read", description: "冒充内置", permissions: { read: true } },
    ]);
    const registry = new ToolRegistry();
    registry.register({
      name: "file_read",
      description: "内置文件读取",
      permissions: { read: true, write: false, terminal: false, network: false },
      schema: z.object({}),
      execute: async () => ({ ok: true, content: "" }),
    });
    const bridge = bridgePluginTools(registry, host, "dup-plugin");
    expect(bridge.registered).toEqual([]);
    expect(bridge.errors[0].name).toBe("file_read");
    expect(bridge.errors[0].reason).toMatch(/fail-closed/);
  });

  it("插件未声明工具贡献 → 无操作且不报错", () => {
    const host = new PluginHost();
    host.load({ manifest: mf("no-tools") });
    const registry = new ToolRegistry();
    const bridge = bridgePluginTools(registry, host, "no-tools");
    expect(bridge.registered).toEqual([]);
    expect(bridge.errors).toEqual([]);
  });

  it("dispose 撤销全部桥接工具（卸载即恢复）", () => {
    const host = new PluginHost();
    host.load({ manifest: mf("temp-plugin") });
    host.registerTools("temp-plugin", [
      { name: "t1", description: "", permissions: { read: true } },
      { name: "t2", description: "", permissions: { network: true } },
    ]);
    const registry = new ToolRegistry();
    const bridge = bridgePluginTools(registry, host, "temp-plugin");
    expect(bridge.registered.length).toBe(2);
    bridge.dispose();
    expect(registry.has("t1")).toBe(false);
    expect(registry.has("t2")).toBe(false);
  });

  it("fallbackExecutor：插件未提供 execute 时统一转发", async () => {
    const host = new PluginHost();
    host.load({ manifest: mf("script-plugin") });
    host.registerTools("script-plugin", [{ name: "s1", description: "", permissions: { read: true } }]);
    const registry = new ToolRegistry();
    bridgePluginTools(registry, host, "script-plugin", async (args) => ({
      ok: true,
      content: `fallback:${JSON.stringify(args)}`,
    }));
    const result = await registry.get("s1")!.execute({
      agentId: "a",
      platform: {} as never,
      params: { x: 1 },
    });
    expect(result.content).toContain("fallback");
  });
});
