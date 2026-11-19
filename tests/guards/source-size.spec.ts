/**
 * P1-7 红线守卫：受版本控制的源码文件不得超过 1500 行。
 *
 * 背景：App.tsx / index.ts 曾分别长到 2118 / 1763 行，功能继续叠加后无法审阅。
 * 拆分完成后用测试锁住红线，防止下一个功能区悄悄长回去。
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const MAX_LINES = 1500;
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "e2e-evidence"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...sourceFiles(path.join(dir, entry.name)));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    out.push(path.join(dir, entry.name));
  }
  return out;
}

describe("源码文件行数红线", () => {
  it(`每个源码文件 <= ${MAX_LINES} 行`, () => {
    const roots = [path.join(ROOT, "packages"), path.join(ROOT, "scripts")];
    const offenders = roots
      .flatMap(sourceFiles)
      .map((file) => ({ file: path.relative(ROOT, file), lines: readFileSync(file, "utf8").split(/\r?\n/).length }))
      .filter((item) => item.lines > MAX_LINES)
      .sort((a, b) => b.lines - a.lines);

    expect(offenders, offenders.map((item) => `${item.file}: ${item.lines}`).join("\n")).toEqual([]);
  });
});
