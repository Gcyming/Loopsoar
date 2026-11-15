/**
 * 逐字真实键盘输入端到端验收（只给验收用）：
 *   本地页（含 #name 输入框）→ mock 模型依次要求 navigate / browser_type(#name) / snapshot
 *   → Electron 渲染层执行 eval 建会话并开浏览器控制 → 断言语义快照里出现输入值。
 *
 * 用法：node scripts/e2e-type-run.mjs
 * 产物：e2e-evidence/type-real-input.log、type-window.png、type-agent-pointer.png
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const PAGE_PORT = 19444;
const MOCK_PORT = 19501;
const DATA_DIR = path.join(ROOT, ".loopsoar-data-type-e2e");
const OUT_DIR = path.join(ROOT, "e2e-evidence");
const LOG = path.join(OUT_DIR, "type-real-input.log");
const SHOT = path.join(OUT_DIR, "type-window.png");
const TYPED = "Loopsoar 中文 123";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(line) {
  process.stdout.write(line + "\n");
}

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
    JSON.stringify({ target: "#name", text: TYPED }),
    JSON.stringify({}),
  ]);
  start("mock", [path.join(ROOT, "scripts/mock-openai-server.mjs"), String(MOCK_PORT)], {
    MOCK_TOOL_NAME: "browser_navigate,browser_type,browser_snapshot",
    MOCK_TOOL_ARGS_SEQ: toolSeq,
  });

  const pageOk = await waitForPort(PAGE_PORT);
  const mockOk = await waitForPort(MOCK_PORT);
  log(`准备就绪 page=${pageOk} mock=${mockOk}`);
  if (!pageOk || !mockOk) throw new Error("本地服务未就绪");

  const evalSource = readFileSync(path.join(ROOT, "scripts/e2e-type-eval.js"), "utf8");
  const app = start("app", [path.join(ROOT, "scripts/dev-gui.mjs")], {
    LOOPSOAR_DATA_DIR: DATA_DIR,
    LOOPSOAR_E2E_HOLD_MS: "4000",
    LOOPSOAR_E2E_SHOT: SHOT,
    LOOPSOAR_E2E_POINTER_SHOT: path.join(OUT_DIR, "type-agent-pointer.png"),
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

// 退出后核对会话文件：输入值是否真的出现在记录里
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
        "E2E_TYPE_VERIFY " +
          JSON.stringify({
            sessionId: best.sessionId,
            browserControl: best.browserControl === true,
            typedValue: texts.includes(TYPED),
            keydowns: Number((/keydown=(\d+)/.exec(texts) ?? [])[1] ?? 0),
            snapshotWithRefs: /快照 #\d+/.test(texts),
            captured: texts.slice(-600),
          }),
      );
    }
  }
} catch (err) {
  log(`E2E_TYPE_VERIFY 失败：${err instanceof Error ? err.message : String(err)}`);
}

log(`Electron 退出码=${exitCode}`);
log(`日志：${LOG}`);
if (existsSync(SHOT)) log(`截图：${SHOT}`);
