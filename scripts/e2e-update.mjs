/**
 * 自动更新端到端（§6.2）：对着本地 generic feed 验证「检查 → 发现新版本 → 下载完成」。
 * 不执行安装（未签名构建不允许真实安装；安装门禁见 updatePolicy.ts）。
 *
 * 用法：node scripts/e2e-update.mjs --port 9333
 */
const port = (() => {
  const i = process.argv.indexOf("--port");
  return i >= 0 ? Number(process.argv[i + 1]) : 9333;
})();
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
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "evaluate failed");
  return result.result?.value;
};
const waitFor = async (predicate, timeoutMs) => {
  const started = Date.now();
  let snapshot = await evaluate("window.loopsoarAPI.update.status()");
  while (!predicate(snapshot) && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    snapshot = await evaluate("window.loopsoarAPI.update.status()");
  }
  return snapshot;
};

const report = { initial: await evaluate("window.loopsoarAPI.update.status()") };
report.check = await evaluate("window.loopsoarAPI.update.check()");
report.afterCheck = await waitFor((s) => ["available", "not-available", "error"].includes(s.state), 30000);
if (report.afterCheck?.state === "available") {
  await evaluate("window.loopsoarAPI.update.download()");
  report.afterDownload = await waitFor((s) => ["downloaded", "error"].includes(s.state), 180000);
}
console.log(JSON.stringify(report, null, 2));
ws.close();
