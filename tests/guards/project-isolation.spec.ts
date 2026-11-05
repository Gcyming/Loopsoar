/**
 * 守卫：项目环境隔离（Loopsoar ≠ slime / pilot project）。
 * 为什么用代码守卫：隔离靠人记不住——端口、路径、跨仓 import 任何一项串了都会在并行开发时静默互相污染。
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SRC_DIRS = [
  "packages/core/src",
  "packages/services/src",
  "packages/shell/src",
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

  it("gateway 子系统已按用户决定删除（不留半接线）", () => {
    expect(existsSync(path.join(ROOT, "packages/gateway"))).toBe(false);
    expect(existsSync(path.join(ROOT, "packages/shell/src/main/gatewayRuntime.ts"))).toBe(false);
    expect(existsSync(path.join(ROOT, "packages/shell/src/main/domains/gateway.ts"))).toBe(false);
  });

  it("embed 默认端口与 slime 隔离（8991，非 8999）", () => {
    const nodeSrc = readFileSync(path.join(ROOT, "packages/core/src/platform/node.ts"), "utf8");
    expect(nodeSrc).toContain("127.0.0.1:8991");
    expect(nodeSrc).not.toContain("127.0.0.1:8999");
  });

  it("shell 把 userData 显式落到品牌目录（%APPDATA%\\loopsoar）", () => {
    const idx = readFileSync(path.join(ROOT, "packages/shell/src/main/index.ts"), "utf8");
    expect(idx).toContain('setPath("userData"');
    // 目录归一化抽到无 Electron 依赖的 dataDir.ts（相对 LOOPSOAR_DATA_DIR 也能启动）
    expect(idx).toContain("resolveDataDir");
    const dataDir = readFileSync(path.join(ROOT, "packages/shell/src/main/dataDir.ts"), "utf8");
    expect(dataDir).toContain("DATA_DIR_NAME");
    expect(dataDir).toContain("path.resolve");
    expect(dataDir).toContain("appData");
  });

  it("品牌资产为仓库内自持的官方资产（shell/resources + ui/public）", () => {
    // 为什么断言存在 + 自持：旧项目串扰的直接表现就是「图标被换成了另一个项目的」，
    // 只允许品牌资产从本仓库的固定路径加载；且必须注明来源（README），资源缺失即红。
    const icon = path.join(ROOT, "packages/shell/resources/icon.png");
    const ico = path.join(ROOT, "packages/shell/resources/icon.ico");
    const logo = path.join(ROOT, "packages/ui/public/logo.png");
    const provenance = path.join(ROOT, "packages/shell/resources/README.md");
    expect(existsSync(icon), "缺少窗口图标（shell/resources/icon.png）").toBe(true);
    expect(existsSync(ico), "缺少多档图标（shell/resources/icon.ico）").toBe(true);
    expect(existsSync(logo), "缺少界面 logo（ui/public/logo.png）").toBe(true);
    expect(existsSync(provenance), "缺少品牌资产来源说明（shell/resources/README.md）").toBe(true);
    // 来源必须指向官方品牌目录，且明确禁止旧项目图标
    const note = readFileSync(provenance, "utf8");
    expect(note).toContain("quilt-inf");
    expect(note).toContain("_old-slime-icons");
  });

  it("UI/shell 不引用仓库外资产或旧项目资源路径", () => {
    const targets = [
      ...allSourceFiles().filter((f) => f.includes("packages/ui") || f.includes("packages/shell")),
      path.join(ROOT, "packages/ui/index.html"),
    ];
    const offenders: string[] = [];
    for (const f of targets) {
      const src = readFileSync(f, "utf8");
      // 只检查「真实引用」（src/href/url()），避免把注释里的叙述误伤：
      // ① 资源引用中出现旧项目名；② 出现仓库外绝对盘符路径。
      const assetRef = /(?:src|href)\s*=\s*["'][^"']*(?:slime|pilot)|url\(\s*["']?[^)]*(?:slime|pilot)/i;
      if (assetRef.test(src)) {
        offenders.push(`${path.relative(ROOT, f)}（引用旧项目资源）`);
      }
      if (/["'][A-Za-z]:[\\/]/.test(src)) {
        offenders.push(`${path.relative(ROOT, f)}（硬编码仓库外绝对路径）`);
      }
    }
    expect(offenders, `串扰风险：\n${offenders.join("\n")}`).toEqual([]);
  });
});
