/**
 * 本地 Mock OpenAI 兼容服务（仅用于 E2E 验收：验证「真 HTTP 流式对话」闭环）。
 * 用法：node scripts/mock-openai-server.mjs [port]
 * 不依赖任何外部网络；任何 model 名都接受。
 */
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 19500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REPLY_CHUNKS = [
  "你好！", "我是 Loopsoar", "（本地模拟模型）", "这条回复来自",
  "真实 HTTP SSE 流式通道，", "不是占位文本。", "对话链路已验证通过。",
];

const server = createServer(async (req, res) => {
  if (!req.url || !req.url.endsWith("/chat/completions")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }
  // 消费请求体（模拟真实服务端行为）
  req.resume();
  await new Promise((r) => req.on("end", r));

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(": loopsoar mock stream\n\n");
  for (const chunk of REPLY_CHUNKS) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
    await sleep(140);
  }
  res.write(`data: ${JSON.stringify({ usage: { total_tokens: 420 } })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
});

server.listen(port, "127.0.0.1", () => {
  console.log(`MOCK_OPENAI_READY http://127.0.0.1:${port}/v1`);
});
