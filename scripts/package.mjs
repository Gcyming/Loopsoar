/**
 * Windows 内测包构建（发布阶段 §4.1）：
 *   1) 构建 UI（vite）与主进程 bundle（esbuild）
 *   2) 组装最小运行目录 release/app（不拷源码/测试/node_modules）
 *   3) electron-builder 出 NSIS 安装包 + zip
 *   4) 生成 SHA256SUMS.txt 与发布说明副本
 *
 * 为什么自己组装 appDir：monorepo 的 node_modules 体积巨大，且运行时只需要
 * main.bundle.mjs（已含 workspace 与 pdfjs）+ preload + ui/dist + 两个 worker。
 * 让 electron-builder 直接打包仓库会把源码、测试、pnpm store 一起塞进安装包。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const APP_DIR = path.join(ROOT, "release/app");
/** 最终交付目录（默认仓库内 release/dist；升级演练/预发布可用 LOOPSOAR_OUT_DIR 覆盖）。 */
const OUT_DIR = process.env.LOOPSOAR_OUT_DIR
  ? path.resolve(process.env.LOOPSOAR_OUT_DIR)
  : path.join(ROOT, "release/dist");
/**
 * 构建中间目录放在系统临时目录：
 *   · 安装器构建期会「运行一次安装器」来生成卸载程序；工作区目录若带继承性 DENY ACL
 *     （受限沙箱/安全软件会给仓库目录加 deny ACE），NSIS 会报
 *     "Error writing temporary file" 直接失败；
 *   · 也避免长路径 + 中文/空格目录在 NSIS/7z 里的边界问题。
 */
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const BUILD_DIR = path.join(os.tmpdir(), `loopsoar-build-${pkg.version}`);

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} → exit ${code}`))));
  });
}

async function buildArtifacts() {
  const uiPackage = path.join(ROOT, "packages/ui/package.json");
  if (existsSync(uiPackage)) {
    // 用 vitest/tsc 同一套 node；shell 脚本不依赖 pnpm shim。
    await run(process.execPath, [path.join(ROOT, "node_modules/vite/bin/vite.js"), "build"], {
      cwd: path.join(ROOT, "packages/ui"),
    });
  }
  await run(process.execPath, [path.join(ROOT, "scripts/bundle-shell.mjs")]);
}

function copyInto(from, to) {
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}

/** 用 require.resolve 定位依赖，避免把 pnpm store 的哈希目录名写死（升级即失效）。 */
function resolvePackageDir(name) {
  // 依赖声明在 packages/shell（pdfjs / 原生模块），从那里解析；根 package.json 只有 devDependencies。
  const require = createRequire(path.join(ROOT, "packages/shell/package.json"));
  try {
    return path.dirname(require.resolve(`${name}/package.json`));
  } catch {
    // 有些包（如 sqlite-vec）的 exports 不暴露 package.json：从入口文件向上找包根。
  }
  let dir = path.dirname(require.resolve(name));
  while (dir !== path.dirname(dir)) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`无法定位包目录：${name}`);
}

/**
 * 可选原生模块（记忆的 sqlite-vec 后端）：
 *   · better-sqlite3 v13 使用 N-API 预编译（prebuilds/win32-x64.node），跨 Node/Electron ABI 直接可用，
 *     不需要按 Electron ABI 重编译；
 *   · sqlite-vec 是 SQLite 扩展 DLL（vec0.dll），不是 Node addon，同样没有 ABI 问题。
 * 两者都放进 node_modules，并根据 electron-builder.yml 的 extraResources 配置
 * 复制到 resources/native/node_modules（SQLite 读不了 asar 虚拟路径）。
 */
function stageNativeModules() {
  const nativeRoot = path.join(APP_DIR, "node_modules");
  const bs3 = resolvePackageDir("better-sqlite3");
  copyInto(path.join(bs3, "package.json"), path.join(nativeRoot, "better-sqlite3/package.json"));
  copyInto(path.join(bs3, "lib"), path.join(nativeRoot, "better-sqlite3/lib"));
  copyInto(
    path.join(bs3, "prebuilds", process.platform === "win32" ? "win32-x64.node" : "linux-x64.node"),
    path.join(nativeRoot, "better-sqlite3/prebuilds", process.platform === "win32" ? "win32-x64.node" : "linux-x64.node"),
  );
  const vecDir = resolvePackageDir("sqlite-vec");
  for (const file of ["package.json", "index.cjs", "index.mjs"]) {
    copyInto(path.join(vecDir, file), path.join(nativeRoot, "sqlite-vec", file));
  }
  // 平台包在 pnpm 里是 sqlite-vec 的同级依赖：.pnpm/sqlite-vec@x/node_modules/sqlite-vec-windows-x64
  const platformDir = path.join(path.dirname(vecDir), `sqlite-vec-${process.platform === "win32" ? "windows" : "linux"}-x64`);
  for (const file of ["package.json", process.platform === "win32" ? "vec0.dll" : "vec0.so"]) {
    copyInto(path.join(platformDir, file), path.join(nativeRoot, `sqlite-vec-${process.platform === "win32" ? "windows" : "linux"}-x64`, file));
  }
  console.log("原生模块已暂存：better-sqlite3 / sqlite-vec");
}

function stageApp() {
  rmSync(APP_DIR, { recursive: true, force: true });
  rmSync(path.join(ROOT, "release/extra"), { recursive: true, force: true });
  mkdirSync(path.join(APP_DIR, "dist"), { recursive: true });
  // 主进程 bundle + worker
  copyInto(path.join(ROOT, "packages/shell/dist/main.bundle.mjs"), path.join(APP_DIR, "dist/main.bundle.mjs"));
  for (const worker of ["extensionWorker.mjs", "scriptLoopWorker.mjs"]) {
    copyInto(path.join(ROOT, "packages/shell/dist", worker), path.join(APP_DIR, "dist", worker));
  }
  // preload（协议注入 + 浏览器面板）
  copyInto(path.join(ROOT, "packages/shell/src/preload/index.cjs"), path.join(APP_DIR, "src/preload/index.cjs"));
  copyInto(path.join(ROOT, "packages/shell/src/preload/browser.cjs"), path.join(APP_DIR, "src/preload/browser.cjs"));
  // 渲染层产物：放 dist/ui，与 uiProtocol 的「bundle 同目录」契约一致
  copyInto(path.join(ROOT, "packages/ui/dist"), path.join(APP_DIR, "dist/ui"));
  stageNativeModules();
  // pdf.js fake worker：主进程 bundle 内联了 pdf.mjs，worker 必须作为独立文件存在
  const pdfjsDir = resolvePackageDir("pdfjs-dist");
  copyInto(path.join(pdfjsDir, "legacy/build/pdf.worker.mjs"), path.join(APP_DIR, "dist/pdf.worker.mjs"));
  // 标准字体：走 extraResources（asar 外的真实文件，pdf.js 按 file URL 读取）
  mkdirSync(path.join(ROOT, "release/extra/pdfjs"), { recursive: true });
  cpSync(path.join(pdfjsDir, "standard_fonts"), path.join(ROOT, "release/extra/pdfjs/standard_fonts"), { recursive: true });
  // 最小 package.json：electron-builder 与 Electron 都从这里读入口
  writeFileSync(
    path.join(APP_DIR, "package.json"),
    `${JSON.stringify(
      {
        name: "loopsoar",
        productName: "Loopsoar",
        version: pkg.version,
        description: "Loopsoar — 浏览器优先的 Agent harness（内测构建）",
        main: "dist/main.bundle.mjs",
        type: "module",
        author: "Loopsoar",
        license: "SEE LICENSE IN LICENSE",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

/** 定位本机已解压的 Electron 发行目录（pnpm 会按 peer 拆出多个副本，只有带 electron.exe 的那个可用）。 */
function resolveElectronDist() {
  const isWin = process.platform === "win32";
  const exe = isWin ? "electron.exe" : "electron";
  const candidates = [process.env.ELECTRON_DIST, path.join(ROOT, "node_modules/electron/dist")].filter(Boolean);
  const store = path.join(ROOT, "node_modules/.pnpm");
  if (existsSync(store)) {
    for (const entry of readdirSync(store)) {
      if (!entry.startsWith("electron@")) continue;
      candidates.push(path.join(store, entry, "node_modules/electron/dist"));
    }
  }
  for (const dir of candidates) {
    if (dir && existsSync(path.join(dir, exe))) return dir;
  }
  throw new Error("未找到本机 Electron 发行目录（先 pnpm install 并确认 electron 下载完成）");
}

async function packageWin() {
  const builder = path.join(ROOT, "node_modules/electron-builder/cli.js");
  const electronDist = resolveElectronDist();
  console.log(`Electron 发行目录：${electronDist}`);
  const env = {
    ...process.env,
    // 本机到 GitHub 会被重置：二进制统一走 npmmirror（electron / nsis / winCodeSign）。
    ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? "https://npmmirror.com/mirrors/electron/",
    ELECTRON_BUILDER_BINARIES_MIRROR:
      process.env.ELECTRON_BUILDER_BINARIES_MIRROR ?? "https://npmmirror.com/mirrors/electron-builder-binaries/",
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
  };
  await run(
    process.execPath,
    [
      builder,
      "--win",
      "nsis",
      "zip",
      "--x64",
      "--config",
      path.join(ROOT, "electron-builder.yml"),
      `--config.directories.output=${BUILD_DIR}`,
      `--config.electronDist=${electronDist}`,
    ],
    { cwd: ROOT, env },
  );
}

/** 把构建目录里的交付件搬到 release/dist（只保留安装包、zip 与校验文件）。 */
/**
 * NSIS 许可页对中文很挑剔：UTF-8 无 BOM 会被按 ANSI 读取，安装器里全是乱码。
 * NSIS 3 的 Unicode 安装器识别 UTF-16LE BOM，这里统一转成 UTF-16LE + BOM 再交给 builder。
 */
function writeNsisAssets() {
  const source = readFileSync(path.join(ROOT, "LICENSE"), "utf8").replace(/\r?\n/g, "\r\n");
  // buildResources 是 release/build（见 electron-builder.yml），license/include 相对它解析。
  const buildDir = path.join(ROOT, "release", "build");
  mkdirSync(buildDir, { recursive: true });
  writeFileSync(path.join(buildDir, "license.txt"), Buffer.from("\uFEFF" + source, "utf16le"));
  // 自定义安装选项页（桌面快捷方式/开机自启/卸载删数据）随包编译。
  copyFileSync(path.join(ROOT, "packaging", "installer.nsh"), path.join(buildDir, "installer.nsh"));
  copyFileSync(path.join(ROOT, "packages", "shell", "resources", "icon.ico"), path.join(buildDir, "icon.ico"));
  console.log("NSIS 资源：license.txt（UTF-16LE）/ installer.nsh / icon.ico");
}

function collectArtifacts() {
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  if (!existsSync(BUILD_DIR)) return;
  for (const name of readdirSync(BUILD_DIR)) {
    if (!/\.(exe|zip|blockmap|yml)$/i.test(name)) continue;
    if (/^Uninstall/i.test(name)) continue;
    copyFileSync(path.join(BUILD_DIR, name), path.join(OUT_DIR, name));
  }
}

function sha256(file) {
  const hash = createHash("sha256");
  hash.update(readFileSync(file));
  return hash.digest("hex");
}

function writeSums() {
  if (!existsSync(OUT_DIR)) return;
  const files = readdirSync(OUT_DIR).filter(
    (name) => /\.(exe|zip)$/i.test(name) && !name.endsWith(".blockmap") && !/^Uninstall/i.test(name),
  );
  const lines = files.sort().map((name) => {
    const full = path.join(OUT_DIR, name);
    return `${sha256(full)}  ${name}`;
  });
  writeFileSync(path.join(OUT_DIR, "SHA256SUMS.txt"), `${lines.join("\n")}\n`, "utf8");
  console.log(`SHA256SUMS.txt：${files.length} 个产物`);
  for (const line of lines) console.log(line);
}

function copyReleaseNotes() {
  const notes = path.join(ROOT, `docs/releases/RELEASE-NOTES-${pkg.version}.md`);
  const target = path.join(OUT_DIR, `RELEASE-NOTES-${pkg.version}.md`);
  if (!existsSync(notes)) {
    console.warn(`未找到发布说明：${notes}`);
    return;
  }
  copyFileSync(notes, target);
  console.log(`发布说明：${notes}`);
  // 发布说明副本追加本次构建校验值：源码里不写死哈希，避免每次构建都要手改文档。
  const sumsFile = path.join(OUT_DIR, "SHA256SUMS.txt");
  if (existsSync(sumsFile)) {
    appendFileSync(
      target,
      `\n## 本次构建校验值（SHA-256）\n\n\`\`\`text\n${readFileSync(sumsFile, "utf8").trim()}\n\`\`\`\n`,
    );
  }
}

console.log(`Loopsoar ${pkg.version} → Windows x64 内测包`);
await buildArtifacts();
await run(process.execPath, [path.join(ROOT, "scripts/build-job-guard.mjs")]);
stageApp();
console.log(`运行目录就绪：${APP_DIR}`);
if (process.argv.includes("--stage-only")) {
  console.log("仅组装运行目录（--stage-only），跳过 electron-builder");
  process.exit(0);
}
writeNsisAssets();
await packageWin();
collectArtifacts();
writeSums();
copyReleaseNotes();
console.log(`完成：${OUT_DIR}`);
