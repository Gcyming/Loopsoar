/**
 * E2E：记忆图谱（E-M0）截图——种一份演示记忆 + 会话，启动 GUI，自动打开「设置 · 记忆」并截图。
 * 用法：node scripts/e2e-memory-graph.mjs [2d|3d]
 * 产物：e2e-evidence/memory-graph.png（2d）、e2e-evidence/memory-graph-3d.png（3d）、memory-graph.log
 */
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const MODE = process.argv[2] === "3d" ? "3d" : "2d";
const ROOT = process.cwd();
const DATA = path.join(ROOT, ".loopsoar-data-graph-e2e");
const OUT = path.join(ROOT, "e2e-evidence");
const NOW = Date.now();
const DAY = 86_400_000;

rmSync(DATA, { recursive: true, force: true });
mkdirSync(path.join(DATA, "sessions"), { recursive: true });
mkdirSync(path.join(DATA, "memory"), { recursive: true });
mkdirSync(OUT, { recursive: true });

const sessions = [
  { id: "s-graph", title: "记忆图谱设计", updatedAt: NOW - 2 * 3600_000 },
  { id: "s-browser", title: "浏览器盲点修复", updatedAt: NOW - 2 * DAY },
  { id: "s-audit", title: "阶段三审计", updatedAt: NOW - 9 * DAY },
];
writeFileSync(
  path.join(DATA, "sessions", "index.json"),
  JSON.stringify({ currentId: "s-graph", items: sessions.map((s) => ({ ...s, preview: s.title, messageCount: 6 })) }, null, 2),
);
for (const s of sessions) {
  writeFileSync(path.join(DATA, "sessions", `${s.id}.json`), JSON.stringify({ sessionId: s.id, updatedAt: s.updatedAt, messages: [] }, null, 2));
}

function fact(id, content, sessionId, importance, ageDays, category, links = []) {
  const ts = NOW - ageDays * DAY;
  return {
    id, content, category, tags: [], importance,
    timestamp: ts, lastAccessed: ts, links, backlinks: [],
    repeated: 0, layer: "semantic", accessCount: 0, confidence: 0.8,
    source: "chat", status: "active", mergeTrail: [],
    provenance: { sessionId, trust: "user", capturedBy: "auto", workspaceId: "default" },
    workspaceId: "default",
  };
}

const facts = [
  fact("m1", "记忆原点代表 Loopsoar 本体，第一层只放会话", "s-graph", 9, 0.1, "convention", ["m2", "m3"]),
  fact("m2", "删除会话时压缩一次，成为游离层记忆", "s-graph", 8, 0.2, "convention", ["m3"]),
  fact("m3", "激活值用 ACT-R 幂律，半径由激活值决定", "s-graph", 8, 0.3, "fact"),
  fact("m4", "失真层只保留关键词与指针，提及才唤醒", "s-graph", 7, 1.2, "fact"),
  fact("m5", "敏感点击必须按元素文案二次确认", "s-browser", 9, 2.1, "lesson", ["m6"]),
  fact("m6", "弹窗会被原生 WebContentsView 盖住，需要 overlay", "s-browser", 8, 2.4, "lesson"),
  fact("m7", "Agent 标签默认禁止回环访问本地服务", "s-browser", 7, 3.2, "convention"),
  fact("m8", "死代码会造成误导面，应直接删除而非标注弃用", "s-audit", 6, 9, "lesson"),
  fact("m9", "旧版本遗留：没有会话归属的记忆会落到游离层", undefined, 5, 20, "fact"),
  fact("m10", "另一条旧记忆：端口 19444 是本地调试页", undefined, 4, 40, "project"),
];
writeFileSync(path.join(DATA, "memory", "memory.json"), JSON.stringify({ facts, archived: [] }, null, 2));

const evalJs = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ta = document.querySelector('textarea');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '/settings');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  await sleep(900);
  const nav = Array.from(document.querySelectorAll('.settings-nav-item'))
    .find((n) => (n.textContent || '').trim().startsWith('记忆'));
  nav?.click();
  await sleep(2200);
  let clicked3d = false;
  if (${JSON.stringify(MODE)} === "3d") {
    const btn = Array.from(document.querySelectorAll("button")).find((b) => (b.textContent || "").trim() === "3D");
    btn?.click();
    clicked3d = Boolean(btn);
    await sleep(1200);
  }
  const canvas = document.querySelector("canvas");
  return { navClicked: Boolean(nav), hasCanvas: Boolean(canvas), clicked3d, canvasSize: canvas ? [canvas.width, canvas.height] : null };
})()`;

const log = createWriteStream(path.join(OUT, MODE === "3d" ? "memory-graph-3d.log" : "memory-graph.log"), { flags: "w" });
const child = spawn(process.execPath, [path.join(ROOT, "scripts/dev-gui.mjs")], {
  cwd: ROOT,
  env: {
    ...process.env,
    LOOPSOAR_DATA_DIR: DATA,
    LOOPSOAR_E2E_SHOT: path.join(OUT, MODE === "3d" ? "memory-graph-3d.png" : "memory-graph.png"),
    LOOPSOAR_E2E_HOLD_MS: "2500",
    LOOPSOAR_E2E_EVAL: evalJs,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (b) => { const t = b.toString(); log.write(t); process.stdout.write(t); });
child.stderr.on("data", (b) => { const t = b.toString(); log.write(t); process.stderr.write(t); });
setTimeout(() => { try { child.kill(); } catch {} }, 120000);
child.on("exit", (code) => { console.log("MEMORY_GRAPH_E2E_EXIT", MODE, code); process.exit(0); });
