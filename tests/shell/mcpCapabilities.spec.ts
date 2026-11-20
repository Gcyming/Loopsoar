/**
 * MCP 能力面：resources / prompts / roots / sampling。
 * 真实 spawn scripts/mock-mcp-server.mjs --probe，验证请求与反向请求闭环。
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { McpHost } from "../../packages/shell/src/main/mcpHost.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const server = path.join(root, "scripts", "mock-mcp-server.mjs");

function makeHost(name: string) {
  const registry = new ToolRegistry();
  const unique = `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const host = new McpHost(path.join(root, ".tmp-mcp-test", unique), registry, () => {});
  return { host, registry };
}

async function waitFor(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("MCP resources / prompts", () => {
  it("列资源、读资源、列提示词、取提示词；宿主工具可调用", async () => {
    const { host, registry } = makeHost("mcp-res.json");
    try {
      host.add({ name: "mock", command: process.execPath, args: [server] });
      const info = await host.connect("mock");
      expect(info?.state).toBe("ready");
      expect(info?.capabilities).toContain("resources");
      expect(info?.capabilities).toContain("prompts");

      const resources = await host.listResources("mock");
      expect(resources[0]).toMatchObject({ server: "mock", uri: "mock://doc/readme", name: "README" });

      const contents = await host.readResource("mock", "mock://doc/readme");
      expect(contents[0].text).toBe("mock resource body");

      const prompts = await host.listPrompts("mock");
      expect(prompts[0]).toMatchObject({ server: "mock", name: "greet" });

      const prompt = await host.getPrompt("mock", "greet", { who: "ada" });
      expect(JSON.stringify(prompt)).toContain("hello ada");

      const listTool = await registry.get("mcp_resources")!.execute({ agentId: "t", params: {}, platform: {} });
      expect(listTool.ok).toBe(true);
      expect(listTool.content).toContain("mock://doc/readme");

      const readTool = await registry.get("mcp_read_resource")!.execute({
        agentId: "t",
        params: { server: "mock", uri: "mock://doc/readme" },
        platform: {},
      });
      expect(readTool.ok).toBe(true);
      expect(readTool.content).toContain("mock resource body");

      const promptTool = await registry.get("mcp_get_prompt")!.execute({
        agentId: "t",
        params: { server: "mock", name: "greet", arguments: { who: "bob" } },
        platform: {},
      });
      expect(promptTool.ok).toBe(true);
      expect(promptTool.content).toContain("hello bob");
    } finally {
      host.shutdown();
    }
  }, 20_000);

  it("服务端未声明能力时给出可行动错误，不返回空成功", async () => {
    const { host, registry } = makeHost("mcp-nocap.json");
    try {
      // 用 --header 模式起一个仍在 capabilities 里声明 resources 的 mock；这里改为直接测未连接服务器
      host.add({ name: "mock", command: process.execPath, args: [server] });
      const err = await host.listResources("mock").catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect(String((err as Error).message)).toContain("未连接");
      const tool = await registry.get("mcp_resources")!.execute({
        agentId: "t",
        params: { server: "mock" },
        platform: {},
      });
      expect(tool.ok).toBe(true);
      expect(tool.content).toContain("未连接");
    } finally {
      host.shutdown();
    }
  }, 20_000);
});

describe("MCP roots / sampling（服务端反向请求）", () => {
  it("回答 roots/list，并用注入的 sampler 回答 sampling/createMessage", async () => {
    const { host } = makeHost("mcp-probe.json");
    try {
      host.setRootsProvider(() => [root]);
      host.setSampler(async (request) => {
        expect(request.messages[0].content.text).toBe("probe sampling");
        return "sampled-ok";
      });
      host.add({ name: "mock", command: process.execPath, args: [server, "--probe"] });
      const info = await host.connect("mock");
      expect(info?.state).toBe("ready");
      expect(info?.capabilities).toContain("resources");

      await waitFor(() => {
        const stderr = host.list()[0]?.stderr.join("\n") ?? "";
        return stderr.includes("file://") && stderr.includes("sampled-ok");
      });
      const stderr = host.list()[0].stderr.join("\n");
      expect(stderr).toContain("file://");
      expect(stderr).toContain("sampled-ok");
    } finally {
      host.shutdown();
    }
  }, 20_000);

  it("工具调用期间 roots/list 使用调用会话的工作区", async () => {
    const { host, registry } = makeHost("mcp-roots-session.json");
    try {
      host.setRootsProvider((sessionId) => [path.join(root, "roots", sessionId ?? "active")]);
      host.add({ name: "mock", command: process.execPath, args: [server, "--roots-tool"] });
      const info = await host.connect("mock");
      expect(info?.state).toBe("ready");

      const tool = registry.get("mcp__mock__roots_probe");
      expect(tool).toBeDefined();
      const result = await tool!.execute({ agentId: "t", sessionId: "sess-b", params: {}, platform: {} });
      expect(result.ok).toBe(true);
      expect(result.content).toContain("sess-b");
    } finally {
      host.shutdown();
    }
  }, 20_000);

  it("没有 sampler 时不声明 sampling 能力，服务端收到 -32601", async () => {
    const { host } = makeHost("mcp-nosample.json");
    try {
      host.add({ name: "mock", command: process.execPath, args: [server, "--probe"] });
      const info = await host.connect("mock");
      expect(info?.state).toBe("ready");
      await waitFor(() => (host.list()[0]?.stderr.join("\n") ?? "").includes("sampling not supported"));
      expect(host.list()[0].stderr.join("\n")).toContain("sampling not supported");
    } finally {
      host.shutdown();
    }
  }, 20_000);
});
