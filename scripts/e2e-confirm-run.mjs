/**
 * 敏感确认端到端验收驱动（只给验收用，不进产品构建）：
 *   1) 起本地测试页（scripts/e2e-page-server.mjs，页面含「立即支付」按钮）
 *   2) 起 mock OpenAI 服务，按序列返回 browser_navigate / browser_snapshot / browser_click(text=立即支付)
 *   3) 独立数据目录启动 Electron；E2E_EVAL 在渲染层建会话、开浏览器控制、发指令，
 *      等「敏感确认弹窗」出现后用界面按钮真实点「确认执行」
 *   4) 主进程 LOOPSOAR_E2E_CONFIRM_SHOT 钩子等弹窗出现后截主窗口（不靠固定延时）
 *
 * 用法：node scripts/e2e-confirm-run.mjs
 * 产物：e2e-evidence/confirm-sensitive.log、confirm-sensitive.png、confirm-window-early.png
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const PAGE_PORT = 19444;
const MOCK_PORT = 19501;
const DATA_DIR = path.join(ROOT, ".loopsoar-data-confirm-e2e");
const OUT_DIR = path.join(ROOT, "e2e-evidence");
const LOG = path.join(OUT_DIR, "confirm-sensitive.log");
const SHOT = path.join(OUT_DIR, "confirm-sensitive.png");
const EARLY_SHOT = path.join(OUT_DIR, "confirm-window-early.png");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (line) => process.stdout.write(line + "\n");

async function waitForPort(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/`);
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

const logStream = createWriteStream(LOG, { flags: "w" });
const children = [];
function start(name, args, env = {}) {
  const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env } });
  children.push(child);
  child.stdout.on("data", (buf) => {
    const text = buf.toString();
    logStream.write(text);
    process.stdout.write(`[${name}] ${text}`);
  });
  child.stderr.on("data", (buf) => {
    const text = buf.toString();
    logStream.write(`[stderr] ${text}`);
    process.stderr.write(`[${name}!] ${text}`);
  });
  return child;
}

let exitCode = 1;
try {
  start("page", [path.join(ROOT, "scripts/e2e-page-server.mjs"), String(PAGE_PORT)]);
  const toolSeq = JSON.stringify([
    JSON.stringify({ url: `http://127.0.0.1:${PAGE_PORT}/` }),
    JSON.stringify({}),
    JSON.stringify({ target: "#act-1" }),
  ]);
  start("mock", [path.join(ROOT, "scripts/mock-openai-server.mjs"), String(MOCK_PORT)], {
    MOCK_TOOL_NAME: "browser_navigate,browser_snapshot,browser_click",
    MOCK_TOOL_ARGS_SEQ: toolSeq,
  });

  const pageOk = await waitForPort(PAGE_PORT);
  const mockOk = await waitForPort(MOCK_PORT);
  log(`准备就绪 page=${pageOk} mock=${mockOk}`);
  if (!pageOk || !mockOk) throw new Error("本地服务未就绪");

  const evalSource = readFileSync(path.join(ROOT, "scripts/e2e-confirm-eval.js"), "utf8");
  const app = start("app", [path.join(ROOT, "scripts/dev-gui.mjs")], {
    LOOPSOAR_DATA_DIR: DATA_DIR,
    // E2E 走本地页服务（127.0.0.1）：放开「Agent 标签访问回环」的默认限制（生产不设）。
    LOOPSOAR_ALLOW_LOOPBACK: "1",
    LOOPSOAR_DEBUG_BROWSER: "1",
    LOOPSOAR_E2E_HOLD_MS: "2500",
    LOOPSOAR_E2E_SHOT: EARLY_SHOT,
    // 弹窗出现的瞬间由主进程轮询 DOM 后抓帧（固定延时拍不到）
    LOOPSOAR_E2E_CONFIRM_SHOT: SHOT,
    LOOPSOAR_E2E_CONFIRM_WAIT_MS: "60000",
    LOOPSOAR_E2E_EVAL: evalSource,
  });

  exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      log("超时：强制结束 Electron");
      app.kill("SIGKILL");
      resolve(2);
    }, 240000);
    app.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? 0);
    });
  });
} catch (err) {
  log(`启动失败：${err instanceof Error ? err.message : String(err)}`);
} finally {
  for (const child of children) {
    if (!child.killed) {
      try {
        child.kill("SIGKILL");
      } catch {
        // 已退出
      }
    }
  }
  logStream.end();
}

const logText = existsSync(LOG) ? readFileSync(LOG, "utf8") : "";
const evalLine = logText.split("\n").find((line) => line.includes("E2E_EVAL")) ?? "";
const shotSaved = logText.includes("CONFIRM_SHOT_SAVED");
log(`\n=== 结果 ===`);
log(`退出码: ${exitCode}`);
log(`确认截图: ${shotSaved ? SHOT : "未生成"}`);
log(`E2E_EVAL: ${evalLine.slice(0, 1200)}`);
process.exit(shotSaved ? exitCode : 1);
