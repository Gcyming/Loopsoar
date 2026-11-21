/**
 * 生成 THIRD_PARTY_NOTICES.md（发布阶段 §4.6）。
 *
 * 口径：
 *   · 只列随安装包分发的组件：Electron 运行时、打进主进程 bundle 的库、UI bundle 里的 React；
 *   · 开发依赖（vite/typescript/vitest/electron-builder…）不随包分发，不列入；
 *   · 可选原生模块（better-sqlite3 / sqlite-vec）不随包发布，单列说明；
 *   · 许可证正文直接从 node_modules 的 LICENSE 文件读取，避免手抄出错。
 *
 * 用法：node scripts/third-party-notices.mjs [--check]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "THIRD_PARTY_NOTICES.md");

const SHIPPED = [
  ["electron", "应用运行时（Chromium + Node.js）"],
  ["react", "渲染层 UI 框架"],
  ["react-dom", "渲染层 DOM 运行时"],
  ["scheduler", "React 调度器（react-dom 依赖）"],
  ["zod", "主进程/契约的运行时校验"],
  ["pdfjs-dist", "PDF 文本抽取（打进主进程 bundle）"],
];

const OPTIONAL = [
  ["better-sqlite3", "可选 SQLite 驱动（默认不启用，安装包不含）"],
  ["sqlite-vec", "可选向量索引扩展（默认不启用，安装包不含）"],
];

function findPackageDir(name) {
  const direct = path.join(ROOT, "packages/shell/node_modules", name);
  if (existsSync(path.join(direct, "package.json"))) return direct;
  const store = path.join(ROOT, "node_modules/.pnpm");
  if (!existsSync(store)) return null;
  const prefix = name + "@";
  const hits = readdirSync(store)
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => path.join(store, entry, "node_modules", name))
    .filter((dir) => existsSync(path.join(dir, "package.json")));
  return hits.find((dir) => readLicense(dir)) ?? hits[0] ?? null;
}

function readLicense(dir) {
  const entries = readdirSync(dir);
  const hit = entries.find((name) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(name));
  if (!hit) return null;
  try {
    return readFileSync(path.join(dir, hit), "utf8").trim();
  } catch {
    return null;
  }
}

function fence(text) {
  return "```text\n" + text + "\n```";
}

function section(entry, index) {
  const name = entry[0];
  const purpose = entry[1];
  const dir = findPackageDir(name);
  if (!dir) return "### " + index + ". " + name + "\n\n> 未在 node_modules 中找到（构建机缺少该包）。\n";
  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  const license = pkg.license ?? pkg.licenses ?? "UNKNOWN";
  const text = readLicense(dir);
  const lines = [];
  lines.push("### " + index + ". " + name + " " + pkg.version, "");
  lines.push("- 用途：" + purpose);
  lines.push("- 许可证：" + license);
  lines.push("- 项目主页：" + (pkg.homepage ?? pkg.repository?.url ?? "—"), "");
  if (text) {
    lines.push("<details>");
    lines.push("<summary>许可证正文</summary>", "");
    lines.push(fence(text), "");
    lines.push("</details>", "");
  } else {
    lines.push("> 该包未随附许可证文件。", "");
  }
  return lines.join("\n");
}

function build() {
  const lines = [];
  lines.push("# THIRD PARTY NOTICES", "");
  lines.push("本文件由 scripts/third-party-notices.mjs 生成，记录 Loopsoar 安装包内分发的第三方组件及其许可证。", "");
  lines.push("Loopsoar 自身按内测许可分发（见 LICENSE）。以下组件的版权归各自作者所有，使用条件以各许可证为准。", "");
  lines.push("## 随安装包分发的组件", "");
  SHIPPED.forEach((entry, i) => lines.push(section(entry, i + 1)));
  lines.push("## 可选组件（默认不随包分发）", "");
  lines.push("以下原生模块只在用户自行安装时才可能被加载；安装包不含它们，缺失时记忆检索自动使用内置 flat 后端。", "");
  OPTIONAL.forEach((entry, i) => lines.push(section(entry, SHIPPED.length + i + 1)));
  lines.push("## Electron 运行时附带的组件", "");
  lines.push("Electron 自身包含 Chromium、Node.js、V8 及其它开源组件，完整列表见安装目录下的 LICENSES.chromium.html（electron-builder 会随包复制）。", "");
  return lines.join("\n");
}

const content = build();
if (process.argv.includes("--check")) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (current !== content) {
    console.error("THIRD_PARTY_NOTICES.md 与生成器输出不一致：请运行 node scripts/third-party-notices.mjs");
    process.exit(1);
  }
  console.log("THIRD_PARTY_NOTICES.md 校验通过");
} else {
  writeFileSync(OUT, content, "utf8");
  console.log("已生成：" + OUT + "（" + (content.length / 1024).toFixed(1) + " KB）");
}
