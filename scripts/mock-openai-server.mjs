/**
 * 本地 Mock OpenAI 兼容服务（仅用于 E2E 验收：验证「真 HTTP 流式对话」闭环）。
 * 用法：node scripts/mock-openai-server.mjs [port]
 * 不依赖任何外部网络；任何 model 名都接受。
 *
 * 环境变量：
 *   MOCK_FIRST_DELAY_MS  首字延迟（模拟慢上游）
 *   MOCK_TOOL_NAME       工具名（逗号分隔可连续调用）；第一轮返回该工具的 tool_call，收到结果后继续下一轮
 *   MOCK_TOOL_ARGS       工具调用参数 JSON（默认 "{}"）
 *   MOCK_PLAN=1          在工具序列后追加一次 todo_write（用于演示时间线的任务规划卡）
 *   MOCK_REASONING=1     每轮先吐 reasoning（用于演示思考时间线）
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
  "| 特性 | 支持 |\n|---|---|\n| 流式输出 | ✓ |\n| 工具调用 | ✓ |\n| Markdown 表格 | ✓ |\n\n",
  "更多见 [Loopsoar](https://example.com)。",
];

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeDone(res) {
  res.write("data: [DONE]\n\n");
  res.end();
}

const server = createServer(async (req, res) => {
  if (!req.url || !req.url.endsWith("/chat/completions")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }
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

  // 工具轮模拟：按 MOCK_TOOL_NAME 的顺序逐个调用；MOCK_PLAN=1 追加 todo_write；MOCK_REASONING=1 先吐思考
  if (toolName) {
    const calls = toolName.split(",").map((x) => x.trim()).filter(Boolean);
    if (process.env.MOCK_PLAN === "1") calls.push("todo_write");
    const toolResultCount = messages.filter((msg) => msg.role === "tool").length;
    if (process.env.MOCK_REASONING === "1") {
      const thoughts = toolResultCount === 0
        ? ["用户想了解当前页面的内容。", "我应该先读取页面快照，再根据结果总结。", "如果页面没有打开，就先导航到目标地址。"]
        : ["工具结果已经回来了。", "先核对页面标题与正文，再整理成简洁结论。", "如果需要分步骤推进，可以用 todo_write 记录规划。"];
      for (const thought of thoughts) {
        sse(res, { choices: [{ delta: { reasoning_content: thought } }] });
        await sleep(70);
      }
    }
    if (toolResultCount < calls.length) {
      const name = calls[toolResultCount];
      const args = name === "todo_write"
        ? JSON.stringify({
            items: [
              { content: "读取当前页面快照", status: "completed" },
              { content: "核对页面标题与正文", status: "in_progress" },
              { content: "输出结构化结论", status: "pending" },
            ],
          })
        : (process.env.MOCK_TOOL_ARGS || "{}");
      sse(res, {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: `call_mock_${toolResultCount + 1}`, type: "function", function: { name, arguments: args } },
              ],
            },
          },
        ],
      });
      sse(res, { usage: { total_tokens: 64 } });
      writeDone(res);
      return;
    }
    const lastTool = [...messages].reverse().find((msg) => msg.role === "tool");
    const toolText = typeof lastTool?.content === "string" ? lastTool.content : "";
    const reply = [
      `工具执行完成，我已拿到结果（回灌 ${toolText.length} 字符）：\n\n`,
      `${toolText.slice(0, 240)}\n\n`,
      "### 结论\n\n- 页面信息已读取并核对\n- 规划已更新（可在上方任务规划卡查看）\n\n基于以上内容，我完成了查询。",
    ].join("");
    for (const part of reply.match(/[\s\S]{1,16}/g) ?? [reply]) {
      sse(res, { choices: [{ delta: { content: part } }] });
      await sleep(45);
    }
    sse(res, { usage: { total_tokens: 128 } });
    writeDone(res);
    return;
  }

  const firstDelay = Number(process.env.MOCK_FIRST_DELAY_MS ?? "0");
  if (firstDelay > 0) await sleep(firstDelay);
  for (const chunk of REPLY_CHUNKS) {
    sse(res, { choices: [{ delta: { content: chunk } }] });
    await sleep(140);
  }
  sse(res, { usage: { total_tokens: 420 } });
  writeDone(res);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`MOCK_OPENAI_READY http://127.0.0.1:${port}/v1`);
});
