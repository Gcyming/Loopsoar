/** MCP 宿主集成：真实 spawn scripts/mock-mcp-server.mjs → 握手 → 工具注册 → 调用。 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { McpHost } from "../../packages/shell/src/main/mcpHost.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const server = path.join(root, "scripts", "mock-mcp-server.mjs");

describe("MCP 宿主（stdio）", () => {
  it("连接 → 注册 mcp__ 工具 → 调用返回真实结果 → 断开移除工具", async () => {
    const registry = new ToolRegistry();
    const host = new McpHost(path.join(root, ".tmp-mcp-test", "mcp.json"), registry, () => {});
    try {
      host.add({ name: "mock", command: process.execPath, args: [server] });
      const info = await host.connect("mock");
      expect(info?.state).toBe("ready");
      expect(registry.list().some((t) => t.name === "mcp__mock__echo")).toBe(true);

      const tool = registry.get("mcp__mock__echo")!;
      const result = await tool.execute({ agentId: "test", params: { text: "hi" }, platform: {} });
      expect(result.ok).toBe(true);
      expect(result.content).toContain("echo: hi");

      host.disconnect("mock");
      expect(registry.list().some((t) => t.name.startsWith("mcp__mock__"))).toBe(false);
    } finally {
      host.shutdown();
    }
  }, 20000);
});
