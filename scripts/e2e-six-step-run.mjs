/**
 * 六步链路真机验收驱动（只给验收用，不进产品构建）：
 *   1) 起本地测试页（scripts/e2e-page-server.mjs）——证明「工具执行不依赖浏览器」也能跑通主链路
 *   2) 起 mock OpenAI 服务：先返回 terminal_run（需确认），收到结果后返回 memory_add（需确认），最后回到文本
 *   3) 独立数据目录启动 Electron，E2E_EVAL 在渲染层建会话、配 mock 供应商、发指令、真实点「允许一次」
 *   4) 第二轮再发一条消息，验证同一会话的召回注入（mock 的 MOCK_PROBE 命中日志）
 *   5) 退出后核对：E2E_EVAL 结论 + 记忆文件落盘 + 探针命中 + 截图
 *
 * 用法：node scripts/e2e-six-step-run.mjs
 * 产物：e2e-evidence/six-step-chain.log、six-step-chain.png
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const PAGE_PORT = 19445;
const MOCK_PORT = 19502;
const DATA_DIR = path.join(ROOT, ".loopsoar-data-six-step-e2e");
const OUT_DIR = path.join(ROOT, "e2e-evidence");
const STARTED = Date.now();
const LOG = path.join(OUT_DIR, "six-step-chain.log");
const SHOT = path.join(OUT_DIR, "six-step-chain.png");
const MEMORY_DIR = path.join(DATA_DIR, "memory");
const PROBE = "SIXSTEP-MEMO-19452";

/** 记忆落盘可能是 memory.json，也可能是 vault（md + 索引）：递归找 PROBE 文本。 */
function dirContains(dir, needle) {
  if (!existsSync(dir)) return false;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (dirContains(full, needle)) return true;
    } else if (entry.isFile()) {
      try {
        if (statSync(full).size <= 5_000_000 && readFileSync(full, "utf8").includes(needle)) return true;
      } catch {
        // 二进制/不可读文件跳过
      }
    }
  }
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (line) => process.stdout.write(line + "\n");

async function waitForPort(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // mock 对 / 返回 404 属正常：有 HTTP 响应即视为就绪。
      await fetch("http://127.0.0.1:" + port + "/");
      return true;
    } catch {
      // 还没起来
    }
    await sleep(300);
  }
  return false;
}

mkdirSync(OUT_DIR, { recursive: true });
if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true, force: true });
rmSync(SHOT, { force: true });

const logStream = createWriteStream(LOG, { flags: "w" });
const children = [];
function start(name, args, env = {}) {
  const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env } });
  children.push(child);
  child.stdout.on("data", (buf) => {
    const text = buf.toString();
    logStream.write(text);
    process.stdout.write("[" + name + "] " + text);
  });
  child.stderr.on("data", (buf) => {
    const text = buf.toString();
    logStream.write("[stderr] " + text);
    process.stderr.write("[" + name + "!] " + text);
  });
  return child;
}

let exitCode = 1;
try {
  start("page", [path.join(ROOT, "scripts/e2e-page-server.mjs"), String(PAGE_PORT)]);
  const toolArgs = JSON.stringify([
    JSON.stringify({ command: "echo six-step-ok" }),
    JSON.stringify({
      content: "六步验收标记 SIXSTEP-MEMO-19452：终端工具已执行并回灌结果。",
      category: "fact",
      tags: ["六步", "验收"],
    }),
  ]);
  start("mock", [path.join(ROOT, "scripts/mock-openai-server.mjs"), String(MOCK_PORT)], {
    MOCK_TOOL_NAME: "terminal_run,memory_add",
    MOCK_TOOL_ARGS_SEQ: toolArgs,
    MOCK_PROBE: PROBE,
    MOCK_TOOL_FIRST_USER_ONLY: "1",
  });

  const pageOk = await waitForPort(PAGE_PORT);
  const mockOk = await waitForPort(MOCK_PORT);
  log("准备就绪 page=" + pageOk + " mock=" + mockOk);
  if (!pageOk || !mockOk) throw new Error("本地服务未就绪");

  const evalSource = readFileSync(path.join(ROOT, "scripts/e2e-six-step-eval.js"), "utf8");
  const app = start("app", [path.join(ROOT, "scripts/dev-gui.mjs")], {
    LOOPSOAR_DATA_DIR: DATA_DIR,
    LOOPSOAR_E2E_HOLD_MS: "2500",
    LOOPSOAR_E2E_SHOT: SHOT,
    LOOPSOAR_E2E_EVAL: evalSource,
  });

  exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      log("超时：强制结束 Electron");
      app.kill("SIGKILL");
      resolve(2);
    }, 300000);
    app.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? 0);
    });
  });
} catch (err) {
  log("启动失败：" + (err instanceof Error ? err.message : String(err)));
} finally {
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      // 已退出
    }
  }
  logStream.end();
}

const logText = existsSync(LOG) ? readFileSync(LOG, "utf8") : "";
const evalLine = logText.split("\n").find((line) => line.includes("E2E_EVAL ")) ?? "";
let evalOut = null;
if (evalLine) {
  try {
    evalOut = JSON.parse(evalLine.slice(evalLine.indexOf("E2E_EVAL ") + "E2E_EVAL ".length));
  } catch {
    evalOut = null;
  }
}
const probeHit = /MOCK_PROBE_HIT=1/.test(logText);
const memoryOnDisk = dirContains(MEMORY_DIR, PROBE);
const shotFresh = existsSync(SHOT) && statSync(SHOT).mtimeMs >= STARTED && statSync(SHOT).size > 1000;

const checks = {
  evalOk: Boolean(evalOut && evalOut.ok),
  permissionDialog: Boolean(evalOut && evalOut.evidence && evalOut.evidence.permissionAnsweredByClick),
  toolExecuted: Boolean(evalOut && evalOut.evidence && evalOut.evidence.toolExecuted),
  memorySaved: Boolean(evalOut && evalOut.evidence && evalOut.evidence.memorySaved),
  memoryOnDisk,
  memoryInjectedNextTurn: probeHit,
  secondTurnDone: Boolean(evalOut && evalOut.evidence && evalOut.evidence.secondTurnDone),
  screenshot: shotFresh,
  exitCode: exitCode === 0,
};
const ok = Object.values(checks).every(Boolean);

log("");
log("=== 六步链路验收 ===");
log(JSON.stringify(checks, null, 0));
if (evalOut) {
  log("evidence=" + JSON.stringify(evalOut.evidence, null, 0));
  if (evalOut.error) log("evalError=" + String(evalOut.error));
}
log("log=" + LOG);
log(ok ? "ok:true（六步链路 + 记忆跨轮注入）" : "ok:false（见上面失败项）");
process.exit(ok ? 0 : 1);