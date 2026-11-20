/**
 * 本地 Mock MCP 服务器（stdio），用于 E2E 与单测验证。
 *
 * 模式（argv）：
 *   --header   使用 LSP 风格 Content-Length 帧（验证客户端帧格式探测/翻转）
 *   --notify   tools/list 后发送 notifications/tools/list_changed；第二次 tools/list 多返回 echo2
 * 用法：node scripts/mock-mcp-server.mjs [--header] [--notify]
 */
import { createInterface } from "node:readline";

const MODE_HEADER = process.argv.includes("--header");
const MODE_NOTIFY = process.argv.includes("--notify");
/** --probe：握手后主动请求 roots/list 与 sampling/createMessage，把结果作为通知回传（测客户端反向能力）。 */
const MODE_PROBE = process.argv.includes("--probe");
/** --roots-tool：tools/call 期间反向请求 roots/list，验证客户端是否按调用会话回答。 */
const MODE_ROOTS_TOOL = process.argv.includes("--roots-tool");

let listCalls = 0;
let pendingRootsToolId = null;

function toolsFor() {
  const base = [
    {
      name: "echo",
      description: "回显输入文本（演示 MCP 工具）",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
      annotations: { readOnlyHint: true },
    },
    { name: "now", description: "返回当前时间（ISO）", inputSchema: { type: "object", properties: {} } },
  ];
  if (MODE_NOTIFY && listCalls >= 2) {
    base.push({ name: "echo2", description: "list_changed 后新增的工具", inputSchema: { type: "object", properties: {} } });
  }
  if (MODE_ROOTS_TOOL) {
    base.push({
      name: "roots_probe",
      description: "调用期间反向请求 roots/list，返回客户端给出的工作区根",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    });
  }
  return base;
}

function writeMessage(message) {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  if (MODE_HEADER) {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  } else {
    process.stdout.write(`${body}\n`);
  }
}

function handle(message) {
  // 服务端反向请求的响应：把结果作为通知回传，测试从宿主 stderrRing 读取。
  if (MODE_ROOTS_TOOL && message.id === 950) {
    const toolId = pendingRootsToolId;
    pendingRootsToolId = null;
    const roots = Array.isArray(message.result?.roots) ? message.result.roots : [];
    writeMessage({ id: toolId, result: { content: [{ type: "text", text: JSON.stringify(roots) }] } });
    return;
  }
  if (MODE_PROBE && message.id === 900) {
    writeMessage({ method: "notifications/probe", params: { roots: message.result?.roots ?? null, error: message.error?.message ?? null } });
    return;
  }
  if (MODE_PROBE && message.id === 901) {
    writeMessage({
      method: "notifications/probe",
      params: {
        sampling: message.result?.content?.text ?? null,
        error: message.error?.message ?? null,
      },
    });
    return;
  }
  if (message.method === "notifications/initialized" && MODE_PROBE) {
    writeMessage({ id: 900, method: "roots/list", params: {} });
    writeMessage({
      id: 901,
      method: "sampling/createMessage",
      params: { messages: [{ role: "user", content: { type: "text", text: "probe sampling" } }], maxTokens: 32 },
    });
    return;
  }
  if (message.method === "initialize") {
    writeMessage({
      id: message.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: "loopsoar-mock-mcp", version: "0.1.0" },
      },
    });
    return;
  }
  if (message.method === "resources/list") {
    writeMessage({
      id: message.id,
      result: {
        resources: [
          { uri: "mock://doc/readme", name: "README", mimeType: "text/plain", description: "mock 资源" },
        ],
      },
    });
    return;
  }
  if (message.method === "resources/read") {
    writeMessage({
      id: message.id,
      result: {
        contents: [{ uri: message.params?.uri ?? "mock://doc/readme", mimeType: "text/plain", text: "mock resource body" }],
      },
    });
    return;
  }
  if (message.method === "prompts/list") {
    writeMessage({
      id: message.id,
      result: {
        prompts: [
          { name: "greet", description: "打招呼模板", arguments: [{ name: "who", required: true }] },
        ],
      },
    });
    return;
  }
  if (message.method === "prompts/get") {
    const who = String(message.params?.arguments?.who ?? "world");
    writeMessage({
      id: message.id,
      result: {
        description: "打招呼模板",
        messages: [{ role: "user", content: { type: "text", text: `hello ${who}` } }],
      },
    });
    return;
  }
  if (message.method === "tools/list") {
    listCalls += 1;
    writeMessage({ id: message.id, result: { tools: toolsFor() } });
    if (MODE_NOTIFY && listCalls === 1) {
      writeMessage({ method: "notifications/tools/list_changed", params: {} });
    }
    return;
  }
  if (message.method === "tools/call") {
    const name = message.params?.name;
    const args = message.params?.arguments ?? {};
    if (MODE_ROOTS_TOOL && name === "roots_probe") {
      pendingRootsToolId = message.id;
      writeMessage({ id: 950, method: "roots/list", params: {} });
      return;
    }
    if (name === "echo" || name === "echo2") {
      writeMessage({ id: message.id, result: { content: [{ type: "text", text: `echo: ${String(args.text ?? "")}` }] } });
      return;
    }
    if (name === "now") {
      writeMessage({ id: message.id, result: { content: [{ type: "text", text: new Date().toISOString() }] } });
      return;
    }
    writeMessage({ id: message.id, error: { code: -32601, message: `unknown tool: ${name}` } });
    return;
  }
  if (typeof message.id === "number") {
    writeMessage({ id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } });
  }
}

if (MODE_HEADER) {
  // 按 Content-Length 解析 stdin
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const sep = buffer.indexOf("\r\n\r\n");
      if (sep < 0) break;
      const header = buffer.slice(0, sep);
      const lenMatch = /Content-Length:\s*(\d+)/i.exec(header);
      if (!lenMatch) {
        buffer = buffer.slice(sep + 4);
        continue;
      }
      const len = Number(lenMatch[1]);
      const start = sep + 4;
      if (Buffer.byteLength(buffer.slice(start), "utf8") < len) break;
      const body = buffer.slice(start, start + len);
      buffer = buffer.slice(start + len);
      try {
        handle(JSON.parse(body));
      } catch {
        // 忽略坏帧
      }
    }
  });
} else {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    try {
      handle(JSON.parse(text));
    } catch {
      // 忽略坏行
    }
  });
}
