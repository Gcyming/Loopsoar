/**
 * Loopsoar GUI 开发启动器：
 *   1) 构建 UI 产物（vite）
 *   2) 打包主进程（esbuild bundle，workspace 源码 → 单文件）
 *   3) 启动 Electron（自动定位 electron 二进制）
 *
 * 为什么带 --no-sandbox：本机（Windows）Chromium 沙箱初始化会直接崩溃（exit 0x80000003），
 * 去掉进程沙箱后可正常启动；这是**开发机环境限制**，正式打包版本不启用该参数（安全门见规划 §6.4）。
 * 渲染进程仍保持 contextIsolation + nodeIntegration:false + 独立 partition。
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const isWin = process.platform === "win32";
const BUNDLE = path.join(ROOT, "packages/shell/dist/main.bundle.mjs");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} → exit ${code}`));
    });
  });
}

/** 定位 electron 可执行文件：直接扫描 pnpm store（cli.js 的 path.txt 指针在本机不完整）。 */
function resolveElectron() {
  const candidates = [];
  const storeDir = path.join(ROOT, "node_modules", ".pnpm");
  const exeName = isWin ? "electron.exe" : "electron";
  if (existsSync(storeDir)) {
    for (const entry of readdirSync(storeDir)) {
      if (!entry.startsWith("electron@")) continue;
      candidates.push(path.join(storeDir, entry, "node_modules/electron/dist", exeName));
    }
  }
  const pointer = path.join(ROOT, "node_modules", "electron", "path.txt");
  if (existsSync(pointer)) {
    const rel = readFileSync(pointer, "utf8").trim();
    candidates.push(path.join(ROOT, "node_modules", "electron", rel));
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("未找到 electron 二进制（先在仓库根执行 pnpm install，并确认 electron 下载完成）");
}

// 先编译 contracts 的 dist：UI 的 tsc 走包 exports（dist），不先更新会出现
// 「源码加了字段、UI 类型却说没有」的假失败（用户 2026-11-28 实测）。
// 直接调 tsc（不跑 clean-dist，避免 Windows 上旧进程占用导致 EPERM）。
await run(process.execPath, [path.join(ROOT, "node_modules/typescript/bin/tsc"), "-p", path.join(ROOT, "packages/contracts/tsconfig.json")]);
// pnpm 在 Windows 上是 .cmd，需要 shell；node 直接调（脚本路径含空格时不能用 shell 拼接）
await run(isWin ? "pnpm.cmd" : "pnpm", ["--filter", "loopsoar-ui", "build"], { shell: isWin });
await run(process.execPath, [path.join(ROOT, "scripts/bundle-shell.mjs")]);

if (!existsSync(BUNDLE)) throw new Error(`主进程 bundle 不存在：${BUNDLE}`);

const electron = resolveElectron();
// 追加启动参数：一行一个（支持含空格的 Chromium switch，如 --host-resolver-rules=MAP host ip）。
const extraArgs = (process.env.LOOPSOAR_ELECTRON_ARGS || "").split("\n").map((line) => line.trim()).filter(Boolean);
const args = isWin ? ["--no-sandbox", ...extraArgs, BUNDLE] : [...extraArgs, BUNDLE];
console.log(`启动 Electron：${electron} ${args.join(" ")}`);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // 该变量会让 electron 退化成纯 Node

const startedAt = Date.now();
const child = spawn(electron, args, { cwd: ROOT, stdio: "inherit", env });
child.on("exit", (code) => {
  // 单实例锁：旧窗口还在时，新进程会立刻退出并把焦点还给旧实例——
  // 用户看到的是旧构建，误以为新改动没生效。这里明确提示。
  if (Date.now() - startedAt < 3000) {
    console.error("\n[dev] Electron 启动后立即退出：可能已有 Loopsoar 实例在运行（单实例锁）。");
    console.error("[dev] 请先完全关闭旧窗口（任务管理器结束 electron.exe / Loopsoar），再重新运行 pnpm dev。\n");
  }
  process.exit(code ?? 0);
});
