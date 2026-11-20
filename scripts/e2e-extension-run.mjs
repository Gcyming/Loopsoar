/**
 * 扩展富 UI 端到端验收：真实 Electron + loopsoar-ext:// + 沙箱 iframe + worker 回包。
 *
 * 用法：node scripts/e2e-extension-run.mjs
 * 产物：e2e-evidence/p2-extension-panel.png
 * 判定：设置页打开 Rich Panel → iframe ready/resize → viewMessage 回包 ok。
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, ".tmp", "e2e-extension");
const SHOT = path.join(ROOT, "e2e-evidence", "p2-extension-panel.png");
const EVAL = path.join(ROOT, "scripts", "e2e-extension-eval.js");

if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true, force: true });
mkdirSync(path.join(DATA_DIR, "extensions"), { recursive: true });
cpSync(path.join(ROOT, "examples", "extensions", "rich-panel-demo"), path.join(DATA_DIR, "extensions", "rich-panel-demo"), {
  recursive: true,
});
writeFileSync(
  path.join(DATA_DIR, "extensions.json"),
  JSON.stringify({ version: 2, enabled: { "rich-panel-demo": true }, installedAt: { "rich-panel-demo": Date.now() }, versions: {} }),
  "utf8",
);

const app = spawn(process.execPath, [path.join(ROOT, "scripts", "dev-gui.mjs")], {
  cwd: ROOT,
  env: {
    ...process.env,
    LOOPSOAR_DATA_DIR: DATA_DIR,
    LOOPSOAR_E2E_OPEN: "settings&section=extensions",
    LOOPSOAR_E2E_SHOT: SHOT,
    LOOPSOAR_E2E_HOLD_MS: "800",
    LOOPSOAR_E2E_EVAL_FILE: EVAL,
  },
});

let result = null;
let tail = "";
app.stdout.on("data", (buffer) => {
  const text = buffer.toString();
  tail = (tail + text).slice(-4000);
  process.stdout.write(text);
  const match = text.match(/E2E_EVAL (\{.*\})/);
  if (match) {
    try {
      result = JSON.parse(match[1]);
    } catch {
      // 日志跨块：等退出后按 tail 再解析一次
    }
  }
});
app.stderr.on("data", (buffer) => process.stderr.write(buffer));

const timer = setTimeout(() => {
  console.error("超时：强制结束 Electron");
  app.kill("SIGKILL");
}, 120000);

app.on("exit", (code) => {
  clearTimeout(timer);
  if (!result) {
    const match = tail.match(/E2E_EVAL (\{.*\})/);
    if (match) {
      try {
        result = JSON.parse(match[1]);
      } catch {
        // 保持 null
      }
    }
  }
  const ok = Boolean(result?.ok && result?.viewMessage?.ok && code === 0);
  console.log("E2E_EXTENSION_VERDICT", JSON.stringify({ ok, code, result }));
  process.exit(ok ? 0 : 1);
});
