/**
 * MCP 宿主集成：真实 spawn scripts/mock-mcp-server.mjs。
 * 覆盖生命周期：握手 → 注册 → 调用 → 清理，以及失败隔离 / 帧格式翻转 / list_changed 刷新。
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { McpHost } from "../../packages/shell/src/main/mcpHost.ts";
import { spawn } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const server = path.join(root, "scripts", "mock-mcp-server.mjs");

function makeHost(name: string) {
  const registry = new ToolRegistry();
  const host = new McpHost(path.join(root, ".tmp-mcp-test", name), registry, () => {});
  return { host, registry };
}

describe("MCP 宿主（stdio 生命周期）", () => {
  it("连接 → 注册 mcp__ 工具 → 调用返回真实结果 → 断开移除工具", async () => {
    const { host, registry } = makeHost("mcp1.json");
    try {
      host.add({ name: "mock", command: process.execPath, args: [server] });
      const info = await host.connect("mock");
      expect(info?.state).toBe("ready");
      expect(info?.capabilities).toContain("tools");
      expect(registry.list().some((t) => t.name === "mcp__mock__echo")).toBe(true);

      const tool = registry.get("mcp__mock__echo")!;
      const result = await tool.execute({ agentId: "test", params: { text: "hi" }, platform: {} });
      expect(result.ok).toBe(true);
      expect(result.content).toContain("echo: hi");
      // 声明 readOnlyHint 的工具按 read 权限注册（其余按 network）
      expect(tool.permissions).toEqual({ read: true });

      host.disconnect("mock");
      expect(registry.list().some((t) => t.name.startsWith("mcp__mock__"))).toBe(false);
      expect(host.list()[0].state).toBe("idle");
    } finally {
      host.shutdown();
    }
  }, 20000);

  it("启动失败互相隔离：坏命令只影响该服务器", async () => {
    const { host, registry } = makeHost("mcp2.json");
    try {
      host.add({ name: "good", command: process.execPath, args: [server] });
      host.add({ name: "bad", command: path.join(root, "no-such-binary-xyz"), args: [] });
      const bad = await host.connect("bad");
      expect(bad?.state).toBe("error");
      expect(bad?.error).toBeTruthy();
      const good = await host.connect("good");
      expect(good?.state).toBe("ready");
      expect(registry.list().some((t) => t.name === "mcp__good__echo")).toBe(true);
    } finally {
      host.shutdown();
    }
  }, 25000);

  it("帧格式翻转：仅支持 Content-Length 的服务器也能握手成功", async () => {
    const { host, registry } = makeHost("mcp3.json");
    try {
      host.add({ name: "hdrsrv", command: process.execPath, args: [server, "--header"] });
      const info = await host.connect("hdrsrv");
      expect(info?.state).toBe("ready");
      expect(registry.list().some((t) => t.name === "mcp__hdrsrv__echo")).toBe(true);
    } finally {
      host.shutdown();
    }
  }, 30000);

  it("tools/list_changed 通知 → 自动刷新并注册新工具", async () => {
    const { host, registry } = makeHost("mcp4.json");
    try {
      host.add({ name: "notify", command: process.execPath, args: [server, "--notify"] });
      await host.connect("notify");
      await new Promise((r) => setTimeout(r, 800));
      expect(registry.list().some((t) => t.name === "mcp__notify__echo")).toBe(true);
      expect(registry.list().some((t) => t.name === "mcp__notify__echo2")).toBe(true);
    } finally {
      host.shutdown();
    }
  }, 25000);
});

describe("MCP 宿主（Streamable HTTP 传输）", () => {
  it("HTTP：initialize → tools/list → tools/call → 断开清理", async () => {
    const httpServer = path.join(root, "scripts", "mock-mcp-http-server.mjs");
    const child = spawn(process.execPath, [httpServer], { stdio: ["ignore", "pipe", "inherit"] });
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("mock http server 启动超时")), 8000);
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        const match = /MOCK_MCP_HTTP_READY (\d+)/.exec(chunk);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
      child.on("error", reject);
    });
    const { host, registry } = makeHost("mcp-http.json");
    try {
      host.add({ name: "web", transport: "http", url: `http://127.0.0.1:${port}/mcp` });
      const info = await host.connect("web");
      expect(info?.state).toBe("ready");
      expect(info?.transport).toBe("http");
      expect(info?.capabilities).toContain("tools");
      expect(registry.list().some((t) => t.name === "mcp__web__echo")).toBe(true);
      const tool = registry.get("mcp__web__echo")!;
      const result = await tool.execute({ agentId: "test", params: { text: "over-http" }, platform: {} });
      expect(result.ok).toBe(true);
      expect(result.content).toContain("echo: over-http");
      host.disconnect("web");
      expect(registry.list().some((t) => t.name.startsWith("mcp__web__"))).toBe(false);
    } finally {
      host.shutdown();
      child.kill();
    }
  }, 25000);

  it("HTTP：端点不可达 → 该服务器 error，不影响其它服务器", async () => {
    const { host } = makeHost("mcp-http-bad.json");
    try {
      host.add({ name: "dead", transport: "http", url: "http://127.0.0.1:1/mcp" });
      const info = await host.connect("dead");
      expect(info?.state).toBe("error");
      expect(info?.error).toBeTruthy();
    } finally {
      host.shutdown();
    }
  }, 15000);
});
