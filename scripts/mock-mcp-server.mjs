/**
 * 本地 Mock MCP 服务器（stdio JSON-RPC），用于 E2E 与单测验证：
 *   initialize → notifications/initialized → tools/list → tools/call
 * 用法：node scripts/mock-mcp-server.mjs
 */
import { createInterface } from "node:readline";

const TOOLS = [
  {
    name: "echo",
    description: "回显输入文本（演示 MCP 工具）",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  },
  {
    name: "now",
    description: "返回当前时间（ISO）",
    inputSchema: { type: "object", properties: {} },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  if (msg.method === "initialize") {
    send({
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "loopsoar-mock-mcp", version: "0.1.0" },
      },
    });
    return;
  }
  if (msg.method === "tools/list") {
    send({ id: msg.id, result: { tools: TOOLS } });
    return;
  }
  if (msg.method === "tools/call") {
    const name = msg.params?.name;
    const args = msg.params?.arguments ?? {};
    if (name === "echo") {
      send({ id: msg.id, result: { content: [{ type: "text", text: `echo: ${String(args.text ?? "")}` }] } });
      return;
    }
    if (name === "now") {
      send({ id: msg.id, result: { content: [{ type: "text", text: new Date().toISOString() }] } });
      return;
    }
    send({ id: msg.id, error: { code: -32601, message: `unknown tool: ${name}` } });
    return;
  }
  // notifications 无 id，忽略
});
process.stdout.write(""); // 保持管道
