/**
 * 守卫：分层依赖（contracts ← core ← services ← shell ← ui）。
 *
 * 为什么用源码静态扫描：TypeScript 只能约束类型不约束「谁 import 谁」，
 * 一旦有人图省事让 UI 直接 import shell，或 core 反向依赖壳层，
 * 分层会在编译期静默通过、在运行期/打包期才爆（Electron 依赖泄漏进渲染层）。
 * 该守卫是发布门 2/4 的架构前置：不允许反向依赖与跨层相对路径。
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const PKG_DIR = path.join(ROOT, "packages");

interface SourceFile {
  pkg: string;
  rel: string;
  abs: string;
  text: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|cjs)$/.test(entry)) out.push(full);
  }
  return out;
}

function loadSources(): SourceFile[] {
  const files: SourceFile[] = [];
  for (const pkg of readdirSync(PKG_DIR)) {
    const srcDir = path.join(PKG_DIR, pkg, "src");
    try {
      if (!statSync(srcDir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const abs of walk(srcDir)) {
      files.push({
        pkg,
        rel: path.relative(path.join(PKG_DIR, pkg), abs).replace(/\\/g, "/"),
        abs,
        text: readFileSync(abs, "utf8"),
      });
    }
  }
  return files;
}

/** 提取 import/require/动态 import() 的模块说明符（静态足够；不用 AST 以免引入依赖）。 */
function specifiers(text: string): string[] {
  const out: string[] = [];
  const patterns = [
    /from\s+["']([^"']+)["']/g,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
    /require\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) out.push(m[1]);
  }
  return out;
}

const ALLOWED_RUNTIME_DEPS: Record<string, readonly string[]> = {
  contracts: [],
  core: ["loopsoar-contracts"],
  services: ["loopsoar-contracts", "loopsoar-core"],
  shell: ["loopsoar-contracts", "loopsoar-core", "loopsoar-services"],
  // UI 只允许契约层（布局/协议常量）与自身相对模块；禁止直接依赖 core/services/shell。
  ui: ["loopsoar-contracts"],
};

describe("守卫：分层依赖（contracts ← core ← services ← shell ← ui）", () => {
  const sources = loadSources();

  it("每个包只允许依赖其上游包（禁止反向/跨层依赖）", () => {
    const violations: string[] = [];
    for (const file of sources) {
      const allowed = ALLOWED_RUNTIME_DEPS[file.pkg];
      if (!allowed) continue;
      for (const spec of specifiers(file.text)) {
        const workspaceDep = /^loopsoar-[a-z-]+/.exec(spec)?.[0];
        if (!workspaceDep) continue;
        if (workspaceDep === `loopsoar-${file.pkg}`) continue;
        if (!allowed.includes(workspaceDep)) {
          violations.push(`${file.pkg}/${file.rel} → ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("包内相对 import 不得越出本包 src（禁止用 ../ 穿越到别的包）", () => {
    const violations: string[] = [];
    for (const file of sources) {
      if (!file.rel.startsWith("src/")) continue;
      for (const spec of specifiers(file.text)) {
        if (!spec.startsWith(".")) continue;
        const resolved = path.resolve(path.dirname(file.abs), spec);
        const pkgSrc = path.join(PKG_DIR, file.pkg, "src");
        const norm = resolved.replace(/\\/g, "/");
        const base = pkgSrc.replace(/\\/g, "/");
        if (!norm.startsWith(base + "/") && norm !== base) {
          violations.push(`${file.pkg}/${file.rel} → ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("只有 shell 的 main/index.ts / main/electronBrowser.ts / preload 桥允许 import electron", () => {
    const offenders: string[] = [];
    for (const file of sources) {
      if (!/from\s+["']electron["']|require\s*\(\s*["']electron["']/.test(file.text)) continue;
      const allowed =
        file.pkg === "shell" &&
        (file.rel === "src/main/index.ts" ||
          file.rel === "src/main/electronBrowser.ts" ||
          // 浮层管理器：为「工具栏浮层浮在原生网页之上」而创建 Electron 子窗口（惰性 require）
          file.rel === "src/main/chromePopover.ts" ||
          // Agent 会话栏「真·窗口化」：创建独立顶层 BrowserWindow（惰性 require，可注入假窗口测试）
          file.rel === "src/main/agentWindow.ts" ||
          // preload 本身运行在 Electron 预加载环境，只允许用它做 contextBridge 白名单暴露
          file.rel === "src/preload/index.cjs" ||
          // 浏览器页 preload：商店安装按钮拦截（不暴露 contextBridge，只发一个受限 IPC）
          file.rel === "src/preload/browser.cjs");
      if (!allowed) offenders.push(`${file.pkg}/${file.rel}`);
    }
    expect(offenders).toEqual([]);
  });

  it("core/services 必须零 electron 依赖（platform 适配层才碰系统能力）", () => {
    const offenders = sources
      .filter((f) => (f.pkg === "core" || f.pkg === "services") && /from\s+["']electron["']/.test(f.text))
      .map((f) => `${f.pkg}/${f.rel}`);
    expect(offenders).toEqual([]);
  });
});
