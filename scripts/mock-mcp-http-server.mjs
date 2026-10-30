/**
 * 本地 Mock MCP Streamable HTTP 服务（测试/演示用）。
 *   POST /mcp  → JSON-RPC（initialize / tools/list / tools/call），返回 application/json
 *   首次响应带 mcp-session-id 头，验证客户端会话头透传。
 * 用法：node scripts/mock-mcp-http-server.mjs [port]
 */
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 0);

const TOOLS = [
  {
    name: "echo",
    description: "回显文本（HTTP mock）",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    annotations: { readOnlyHint: true },
  },
];

const server = createServer(async (req, res) => {
  if (!req.url || !req.url.endsWith("/mcp")) {
    res.writeHead(404).end("not found");
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let msg;
  try {
    msg = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
    return;
  }
  const headers = { "content-type": "application/json", "mcp-session-id": "sess-mock-1" };
  // 通知（无 id）：不回 JSON
  if (msg.id === undefined || msg.id === null) {
    res.writeHead(202, headers);
    res.end();
    return;
  }
  const reply = (result) => {
    res.writeHead(200, headers);
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
  };
  switch (msg.method) {
    case "initialize":
      reply({
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "mock-http", version: "0.0.0" },
      });
      return;
    case "tools/list":
      reply({ tools: TOOLS });
      return;
    case "tools/call":
      reply({ content: [{ type: "text", text: `echo: ${String(msg.params?.arguments?.text ?? "")}` }] });
      return;
    default:
      res.writeHead(200, headers);
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } }));
  }
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.log(`MOCK_MCP_HTTP_READY ${actualPort}`);
});
