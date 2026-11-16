/**
 * 第二阶段端到端验收驱动（只给验收用，不进产品构建）：
 *   1) 起本地测试页（scripts/e2e-page-server.mjs）
 *   2) 起 mock OpenAI 服务，按序列返回 browser_navigate / browser_snapshot / browser_click / browser_snapshot
 *   3) 用独立数据目录启动 Electron（scripts/dev-gui.mjs），由 E2E_EVAL 在渲染层完成
 *      「配供应商 → 建会话 → 开浏览器控制 → 发指令 → 自动答布局询问 → 收集证据」
 *   4) 落 log / 截图，打印判定
 *
 * 用法：node scripts/e2e-p2-run.mjs
 * 产物：e2e-evidence/p2-agent-browser.log、e2e-evidence/p2-agent-browser-window.png
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const PAGE_PORT = 19443;
const MOCK_PORT = 19500;
const DATA_DIR = path.join(ROOT, ".loopsoar-data-p2-e2e");
const OUT_DIR = path.join(ROOT, "e2e-evidence");
const LOG = path.join(OUT_DIR, "p2-agent-browser.log");
const SHOT = path.join(OUT_DIR, "p2-agent-browser-window.png");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(line) {
  process.stdout.write(line + "\n");
}

async function waitForPort(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // 只要 HTTP 有响应就算就绪：mock 服务对 / 返回 404 属正常（它只处理 /chat/completions），
      // 用 res.ok 判就绪会把 mock 永远判成「没起来」。
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
    JSON.stringify({ target: "text=点我" }),
    JSON.stringify({}),
  ]);
  start("mock", [path.join(ROOT, "scripts/mock-openai-server.mjs"), String(MOCK_PORT)], {
    MOCK_TOOL_NAME: "browser_navigate,browser_snapshot,browser_click,browser_snapshot",
    MOCK_TOOL_ARGS_SEQ: toolSeq,
  });

  const pageOk = await waitForPort(PAGE_PORT);
  const mockOk = await waitForPort(MOCK_PORT);
  log(`准备就绪 page=${pageOk} mock=${mockOk}`);
  if (!pageOk || !mockOk) throw new Error("本地服务未就绪");

  const evalSource = readFileSync(path.join(ROOT, "scripts/e2e-p2-eval.js"), "utf8");
  const app = start("app", [path.join(ROOT, "scripts/dev-gui.mjs")], {
    LOOPSOAR_DATA_DIR: DATA_DIR,
    // E2E 走本地页服务（127.0.0.1）：放开「Agent 标签访问回环」的默认限制（生产不设）。
    LOOPSOAR_ALLOW_LOOPBACK: "1",
    LOOPSOAR_E2E_HOLD_MS: "4000",
    LOOPSOAR_E2E_SHOT: SHOT,
    // 取证：只截指针覆盖窗口自身（不含桌面）+ 光标保持可见
    LOOPSOAR_E2E_POINTER_SHOT: path.join(OUT_DIR, "p2-agent-pointer.png"),
    LOOPSOAR_POINTER_IDLE_MS: "60000",
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
  log(`失败：${err instanceof Error ? err.message : String(err)}`);
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

// 退出后核对壳层落盘真值：会话文件里的 browserControl / 工具结果
  try {
    const sessionsDir = path.join(DATA_DIR, "sessions");
    if (existsSync(sessionsDir)) {
      const files = readdirSync(sessionsDir).filter((f) => f.endsWith(".json") && f !== "index.json");
      let best = null;
      for (const file of files) {
        const raw = JSON.parse(readFileSync(path.join(sessionsDir, file), "utf8"));
        if (!best || (raw.messages?.length ?? 0) > (best.messages?.length ?? 0)) best = raw;
      }
      if (best) {
        const texts = (best.messages ?? []).map((m) => String(m.text ?? "")).join("\n");
        log(
          "E2E_SESSION_VERIFY " +
            JSON.stringify({
              sessionId: best.sessionId,
              browserControl: best.browserControl === true,
              messages: best.messages?.length ?? 0,
              navigated: texts.includes("127.0.0.1:19443") || texts.includes("Loopsoar E2E 本地页"),
              snapshotWithRefs: /快照 #\d+/.test(texts) && texts.includes("#e"),
              clickedMarker: texts.includes("按钮已点击"),
            }),
        );
      }
    }
  } catch (err) {
    log(`E2E_SESSION_VERIFY 失败：${err instanceof Error ? err.message : String(err)}`);
  }

log(`Electron 退出码=${exitCode}`);
log(`日志：${LOG}`);
if (existsSync(SHOT)) log(`截图：${SHOT}`);
