/**
 * 本地 Mock OpenAI 兼容服务（仅用于 E2E 验收：验证「真 HTTP 流式对话」闭环）。
 * 用法：node scripts/mock-openai-server.mjs [port]
 * 不依赖任何外部网络；任何 model 名都接受。
 *
 * 环境变量：
 *   MOCK_FIRST_DELAY_MS  首字延迟（模拟慢上游）
 *   MOCK_TOOL_NAME       启用工具轮模拟：第一轮返回该工具的 tool_call，第二轮回显工具结果
 *   MOCK_TOOL_ARGS       工具调用参数 JSON 字符串（默认 "{}"）
 */
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 19500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REPLY_CHUNKS = [
  "你好！我是 Loopsoar（本地模拟模型）。",
  "\n\n这条回复来自**真实 HTTP SSE 流式通道**：\n\n",
  "- 支持 Markdown 渲染（标题/列表/引用/链接）\n",
  "- 代码块带复制按钮\n",
  "- 行内代码 `loopsoar`\n\n",
  "### 示例代码\n\n```ts\nconst loopsoar = createAgent({\n  mode: \"build\",\n});\nconsole.log(loopsoar.id);\n```\n\n",
  "> 引用：这是 slime 风格渲染的样例。\n\n",
  "更多见 [Loopsoar](https://example.com)。",
];

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

const server = createServer(async (req, res) => {
  if (!req.url || !req.url.endsWith("/chat/completions")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }
  // 读取请求体（用于工具轮模拟 / 请求统计）
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body = {};
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    body = {};
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const toolName = process.env.MOCK_TOOL_NAME;
  console.log(`MOCK_REQ roles=${messages.map((m) => m.role).join(",")} tool=${toolName ?? "-"}`);

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(": loopsoar mock stream\n\n");

  // 工具轮模拟：第一轮没有 tool 消息 → 发一个 tool_call；第二轮（已有工具结果）→ 回显结果
  if (toolName) {
    const hasToolResult = messages.some((msg) => msg.role === "tool");
    if (!hasToolResult) {
      const args = process.env.MOCK_TOOL_ARGS || "{}";
      sse(res, {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_mock_1", type: "function", function: { name: toolName, arguments: args } },
              ],
            },
          },
        ],
      });
      sse(res, { usage: { total_tokens: 64 } });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    const lastTool = [...messages].reverse().find((msg) => msg.role === "tool");
    const toolText = typeof lastTool?.content === "string" ? lastTool.content : "";
    const reply = `工具执行完成，我已拿到结果（回灌 ${toolText.length} 字符）：\n\n${toolText.slice(0, 240)}\n\n基于以上内容，我完成了查询。`;
    for (const part of reply.match(/[\s\S]{1,18}/g) ?? [reply]) {
      sse(res, { choices: [{ delta: { content: part } }] });
      await sleep(50);
    }
    sse(res, { usage: { total_tokens: 128 } });
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  // 模拟慢上游：首字延迟（用于验证「发送后立即有反应」）
  const firstDelay = Number(process.env.MOCK_FIRST_DELAY_MS ?? "0");
  if (firstDelay > 0) await sleep(firstDelay);
  for (const chunk of REPLY_CHUNKS) {
    sse(res, { choices: [{ delta: { content: chunk } }] });
    await sleep(140);
  }
  sse(res, { usage: { total_tokens: 420 } });
  res.write("data: [DONE]\n\n");
  res.end();
});

server.listen(port, "127.0.0.1", () => {
  console.log(`MOCK_OPENAI_READY http://127.0.0.1:${port}/v1`);
});
