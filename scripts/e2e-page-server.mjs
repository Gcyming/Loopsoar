/**
 * E2E 用本地测试页（只被验收脚本使用，不进产品构建）：
 * node scripts/e2e-page-server.mjs [port]
 */
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 19443);

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Loopsoar E2E 本地页</title>
<style>
  body{margin:0;font-family:system-ui,'Microsoft YaHei';background:#0f172a;color:#e2e8f0;display:grid;place-items:center;height:100vh}
  .card{text-align:center}
  h1{font-size:28px;margin:0 0 8px}
  p{color:#7dd3fc;margin:0 0 18px}
  button{padding:10px 18px;border-radius:10px;border:none;background:#0ea5e9;color:#06121f;font-weight:700;font-size:14px;cursor:pointer}
  #out{margin-top:14px;color:#fbbf24;font-size:13px}
</style></head>
<body><div class="card">
  <h1>Loopsoar 浏览器视图 ✔</h1>
  <p>这一页由 WebContentsView 真实加载（E2E）</p>
  <button onclick="document.getElementById('out').textContent='按钮已点击'">点我</button>
  <div id="out">等待交互</div>
</div></body></html>`;

createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}).listen(port, "127.0.0.1", () => {
  console.log(`E2E page server: http://127.0.0.1:${port}/`);
});
