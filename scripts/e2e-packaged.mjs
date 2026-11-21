/**
 * 安装版 E2E（发布阶段 §4.7）：通过 Chrome DevTools Protocol 在真实安装包里调用 preload API，
 * 验证「设置读到、诊断包/数据备份可导出、自动更新状态正确、终端可打开并执行命令」。
 *
 * 前置：应用以 --remote-debugging-port=<port> 启动（ELECTRON_RUN_AS_NODE 必须清空）。
 * 用法：node scripts/e2e-packaged.mjs --port 9333 --out D:\loopsoar-e2e-out
 */
const port = (() => {
  const i = process.argv.indexOf("--port");
  return i >= 0 ? Number(process.argv[i + 1]) : 9333;
})();
const outDir = (() => {
  const i = process.argv.indexOf("--out");
  return i >= 0 ? process.argv[i + 1] : "D:\\loopsoar-e2e-out";
})();

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === "page" && String(t.url).startsWith("loopsoar://")) ?? list.find((t) => t.type === "page");
if (!page) {
  console.error("没有找到页面目标：", JSON.stringify(list.map((t) => ({ type: t.type, url: t.url }))));
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
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "evaluate failed");
  }
  return result.result?.value;
};

const report = {};
report.page = { url: page.url, title: page.title };
report.about = await evaluate("window.loopsoarAPI.settings.about()");
report.update = await evaluate("window.loopsoarAPI.update.status()");
report.diagnostics = await evaluate("window.loopsoarAPI.settings.diagnostics()");
report.exportDiagnostics = await evaluate(`window.loopsoarAPI.settings.exportDiagnostics({ targetDir: ${JSON.stringify(outDir)} })`);
report.exportBackup = await evaluate(`window.loopsoarAPI.settings.exportBackup({ targetDir: ${JSON.stringify(outDir)} })`);

// 终端：打开 → 执行一条长驻命令（供「强杀主进程后子进程被 Job Object 回收」测试使用）
try {
  const terminal = await evaluate('window.loopsoarAPI.terminal.open({ profile: "cmd" })');
  const terminalId = terminal?.id ?? terminal?.terminalId;
  report.terminal = { id: terminalId ?? null };
  if (terminalId) {
    report.terminal.run = await evaluate(
      `window.loopsoarAPI.terminal.run({ terminalId: ${JSON.stringify(terminalId)}, command: 'node -e "setInterval(()=>{},1000)"' })`,
    );
  }
} catch (err) {
  report.terminal = { error: err instanceof Error ? err.message : String(err) };
}

console.log(JSON.stringify(report, null, 2));
ws.close();
