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

// pnpm 在 Windows 上是 .cmd，需要 shell；node 直接调（脚本路径含空格时不能用 shell 拼接）
await run(isWin ? "pnpm.cmd" : "pnpm", ["--filter", "loopsoar-ui", "build"], { shell: isWin });
await run(process.execPath, [path.join(ROOT, "scripts/bundle-shell.mjs")]);

if (!existsSync(BUNDLE)) throw new Error(`主进程 bundle 不存在：${BUNDLE}`);

const electron = resolveElectron();
const args = isWin ? ["--no-sandbox", BUNDLE] : [BUNDLE];
console.log(`启动 Electron：${electron} ${args.join(" ")}`);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // 该变量会让 electron 退化成纯 Node

const child = spawn(electron, args, { cwd: ROOT, stdio: "inherit", env });
child.on("exit", (code) => {
  process.exit(code ?? 0);
});
