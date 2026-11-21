/**
 * 安装包截图（发布证据）：通过 CDP 抓取 loopsoar:// 页面。
 * 用法：node scripts/screenshot-cdp.mjs --port 9333 --out docs/releases/screenshots/packaged-final.png
 */
import { writeFileSync } from "node:fs";

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const port = Number(argOf("--port", 9333));
const out = argOf("--out", "packaged.png");

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === "page" && String(t.url).startsWith("loopsoar://"));
if (!page) {
  console.error("未找到 loopsoar:// 页面");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const send = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(String(event.data));
  const slot = pending.get(msg.id);
  if (!slot) return;
  pending.delete(msg.id);
  if (msg.error) slot.reject(new Error(msg.error.message));
  else slot.resolve(msg.result);
});
await send("Page.enable");
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(out, Buffer.from(shot.data, "base64"));
console.log("已保存：", out);
ws.close();
