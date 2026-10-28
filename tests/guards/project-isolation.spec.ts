/**
 * 守卫：项目环境隔离（Loopsoar ≠ slime / pilot project）。
 * 为什么用代码守卫：隔离靠人记不住——端口、路径、跨仓 import 任何一项串了都会在并行开发时静默互相污染。
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SRC_DIRS = [
  "packages/core/src",
  "packages/services/src",
  "packages/shell/src",
  "packages/gateway/src",
  "packages/ui/src",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      walk(p, out);
    } else if (/\.(ts|tsx|mts|cts|cjs|mjs|js)$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

function allSourceFiles(): string[] {
  const files: string[] = [];
  for (const d of SRC_DIRS) {
    const abs = path.join(ROOT, d);
    try {
      walk(abs, files);
    } catch {
      // 目录不存在（包尚未创建）时跳过
    }
  }
  return files;
}

describe("守卫：项目隔离（不与被测/旧项目串扰）", () => {
  it("源码不得跨仓库 import（pilot / slime 模块）", () => {
    const offenders: string[] = [];
    for (const f of allSourceFiles()) {
      const src = readFileSync(f, "utf8");
      const re = /(?:from\s+|require\(\s*)["'][^"']*(?:pilot|slime)[^"']*["']/i;
      if (re.test(src)) offenders.push(path.relative(ROOT, f));
    }
    expect(offenders, `发现跨项目 import：\n${offenders.join("\n")}`).toEqual([]);
  });

  it("源码不得出现旧仓库绝对路径（D:\\pilot project）", () => {
    const offenders: string[] = [];
    for (const f of allSourceFiles()) {
      const src = readFileSync(f, "utf8");
      if (/pilot[\s_-]?project/i.test(src)) offenders.push(path.relative(ROOT, f));
    }
    expect(offenders, `发现旧仓库路径引用：\n${offenders.join("\n")}`).toEqual([]);
  });

  it("gateway 默认端口与 slime 隔离（19210，非 19000/19110）", () => {
    const appSrc = readFileSync(path.join(ROOT, "packages/gateway/src/app.ts"), "utf8");
    const mainSrc = readFileSync(path.join(ROOT, "packages/gateway/src/main.ts"), "utf8");
    expect(appSrc).toContain("19210");
    expect(mainSrc).toContain("19210");
    // 默认值不许回退到 slime 的端口（出现 19000/19110 只允许在注释里，不允许在代码字符串里）
    expect(appSrc).not.toMatch(/\?\?\s*Number\([^)]*\|\|\s*"19(000|110)"\)/);
    expect(mainSrc).not.toMatch(/:\s*19(000|110)\b/);
  });

  it("embed 默认端口与 slime 隔离（8991，非 8999）", () => {
    const nodeSrc = readFileSync(path.join(ROOT, "packages/core/src/platform/node.ts"), "utf8");
    expect(nodeSrc).toContain("127.0.0.1:8991");
    expect(nodeSrc).not.toContain("127.0.0.1:8999");
  });

  it("shell 把 userData 显式落到品牌目录（%APPDATA%\\loopsoar）", () => {
    const idx = readFileSync(path.join(ROOT, "packages/shell/src/main/index.ts"), "utf8");
    expect(idx).toContain('setPath("userData"');
    expect(idx).toContain("DATA_DIR_NAME");
    expect(idx).toContain("appData");
  });
});
