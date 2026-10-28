/**
 * 守卫：core 与 services 源码零 electron 依赖（ADR-0004 / 架构铁律 2）。
 * 只检查 electron 字符串导入；node: 内建模块是允许的（经 platform 适配层）。
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      walkTsFiles(p, out);
    } else if (entry.endsWith(".ts") || entry.endsWith(".mts")) {
      out.push(p);
    }
  }
  return out;
}

function scanForElectron(dir: string): string[] {
  const hits: string[] = [];
  for (const f of walkTsFiles(dir)) {
    const src = readFileSync(f, "utf8");
    if (/from\s+["']electron["']/.test(src) || /require\(\s*["']electron["']\s*\)/.test(src)) {
      hits.push(f);
    }
  }
  return hits;
}

describe("守卫：core/services 零 electron 依赖", () => {
  it("core 源码不得 import electron", () => {
    const hits = scanForElectron(path.resolve(process.cwd(), "packages/core/src"));
    expect(hits, `发现 electron 依赖：\n${hits.join("\n")}`).toEqual([]);
  });

  it("services 源码不得 import electron", () => {
    const hits = scanForElectron(path.resolve(process.cwd(), "packages/services/src"));
    expect(hits, `发现 electron 依赖：\n${hits.join("\n")}`).toEqual([]);
  });
});
