/**
 * 本地 Mock Anthropic Messages 服务（SSE），验证 Anthropic 端点适配：
 *   POST /v1/messages → message_start / content_block_start / content_block_delta / message_stop
 * 用法：node scripts/mock-anthropic-server.mjs [port]
 */
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 19510);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = createServer(async (req, res) => {
  if (!req.url || !req.url.endsWith("/messages")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
    return;
  }
  req.resume();
  await new Promise((r) => req.on("end", r));

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  send("message_start", { type: "message_start", message: { id: "msg_mock", role: "assistant", content: [] } });
  send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  for (const text of ["你好！", "我是 Anthropic", "兼容端点（mock）。"]) {
    send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
    await sleep(120);
  }
  send("content_block_stop", { type: "content_block_stop", index: 0 });
  send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 18 } });
  send("message_stop", { type: "message_stop" });
  res.end();
});

server.listen(port, "127.0.0.1", () => {
  console.log(`MOCK_ANTHROPIC_READY http://127.0.0.1:${port}/v1`);
});
