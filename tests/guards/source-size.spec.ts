/**
 * 架构守卫：模块体量预算（P1-7 行数红线的第二代）。
 *
 * 第一代只写「所有源码文件 ≤ 1500 行」。结果是文件长期停在 1435–1494：
 * 红线变成了「天花板即目标」，谁也不想为了 20 行去拆一个文件，于是所有人都贴着上限写。
 * 这不是守卫失效，是守卫设计错了——它允许「不变」，而架构债务的本性是「只增不减」。
 *
 * 第二代规则（两档 + 棘轮）：
 *   ① 默认预算 MODULE_MAX：任何未登记的源码文件不得超过 1400 行。
 *      比第一代的 1500 收紧 100 行，留出余量但不允许再贴着天花板写。
 *   ② 组合根白名单 COMPOSITION_ROOTS：Electron 入口、UI 根组件、记忆服务这类
 *      「装配/编排」文件天然更大，登记后允许超过 MODULE_MAX，但必须写明遗留原因与拆解目标。
 *   ③ 棘轮：白名单里的天花板 = 当前实际行数，**只降不升**。
 *      · 文件长大 → 失败（要么拆，要么把某段移出去）；
 *      · 文件缩小 → 失败，提示把天花板同步下调（否则缩小成果会被下一次改动吃掉）。
 *      这一条是整份守卫的核心：它把「贴着上限写」变成「必须持续变小」。
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
/** 默认预算：普通模块不得超过。 */
const MODULE_MAX = 1400;
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "e2e-evidence"]);

interface CompositionRoot {
  /** 当前实际行数（= 允许的上限）。缩小后必须同步下调。 */
  ceiling: number;
  /** 为什么它可以超过默认预算（必须具体，不能写「历史原因」）。 */
  reason: string;
  /** 下一步怎么拆（写给下一次动这个文件的人）。 */
  target: string;
}

/**
 * 组合根白名单。**新增条目需要在评审里解释**，因此它天然是「只减不增」的清单。
 */
const COMPOSITION_ROOTS: Record<string, CompositionRoot> = {
  "packages/shell/src/main/index.ts": {
    ceiling: 1415,
    reason:
      "Electron 主进程组合根：协议注册、核心服务装配、浏览器栈、IPC 域、窗口生命周期必须按顺序发生，拆开会让启动顺序隐式化。已把任务分支状态机（taskForks.ts）、崩溃取证（crashLog.ts）、退出守卫（quitGuard.ts）、指针几何（pointerScreenArea）移出。",
    target:
      "下一步拆「浏览器栈装配」（BrowserExtensionHost/popover/agentWindow/devToolsPanel）与「工具目录」（register*Tools）两块。",
  },
  "packages/shell/src/main/memoryService.ts": {
    ceiling: 1449,
    reason: "记忆服务的门面：写入/召回/索引/迁移共享同一份内存状态，对外只暴露一个类。",
    target:
      "下一步把 vault 索引层（loadIndex/persistIndex/readVaultIndexed/reconcile*）抽成 MemoryVaultIndex，门面只保留事实读写与召回。",
  },
  "packages/ui/src/App.tsx": {
    ceiling: 1465,
    reason:
      "UI 组合根：一个交互式单组件，已把 20+ 个子面板拆到独立文件；剩余部分是同一份会话状态上的分布布局，跨文件会引入大量透传。",
    target: "下一步把 body JSX 抽成 AppBody 并显式声明 props（约 -400 行），届时本条目应下调到 ~1070。",
  },
};

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

/** 内容行数（按编辑器显示计）：结尾换行不算多一行，避免 ±1 的假失败。 */
function contentLines(text: string): number {
  const rows = text.split(/\r?\n/);
  if (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
  return rows.length;
}

function measured(): { rel: string; lines: number }[] {
  const roots = [path.join(ROOT, "packages"), path.join(ROOT, "scripts")];
  return roots
    .flatMap(sourceFiles)
    .map((file) => ({
      rel: path.relative(ROOT, file).replace(/\\/g, "/"),
      lines: contentLines(readFileSync(file, "utf8")),
    }))
    .sort((a, b) => b.lines - a.lines);
}

describe("架构守卫：模块体量预算（两档 + 棘轮）", () => {
  const files = measured();

  it(`未登记的模块不得超过 ${MODULE_MAX} 行`, () => {
    const offenders = files
      .filter((file) => !(file.rel in COMPOSITION_ROOTS) && file.lines > MODULE_MAX)
      .map((file) => `${file.rel}: ${file.lines} > ${MODULE_MAX}（请拆分，或在 COMPOSITION_ROOTS 里登记并说明理由）`);

    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("组合根不得超过各自钉住的天花板（只降不升）", () => {
    const offenders: string[] = [];
    for (const [rel, pin] of Object.entries(COMPOSITION_ROOTS)) {
      const file = files.find((item) => item.rel === rel);
      if (!file) {
        offenders.push(`${rel}: 白名单里的文件不存在（删掉这条登记）`);
        continue;
      }
      if (file.lines > pin.ceiling) {
        offenders.push(`${rel}: ${file.lines} > 天花板 ${pin.ceiling}（只允许变小；要加代码先移出等价行数）`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("组合根缩小后必须同步下调天花板（否则缩小成果会被吃掉）", () => {
    const stale: string[] = [];
    for (const [rel, pin] of Object.entries(COMPOSITION_ROOTS)) {
      const file = files.find((item) => item.rel === rel);
      if (!file) continue;
      if (file.lines < pin.ceiling) {
        stale.push(`${rel}: 实际 ${file.lines} < 天花板 ${pin.ceiling}，请把 COMPOSITION_ROOTS 的天花板改成 ${file.lines}`);
      }
    }
    expect(stale, stale.join("\n")).toEqual([]);
  });

  it("组合根必须写明理由与拆解目标（禁止「历史原因」式登记）", () => {
    for (const [rel, pin] of Object.entries(COMPOSITION_ROOTS)) {
      expect(pin.reason.length, `${rel} 缺少具体理由`).toBeGreaterThan(20);
      expect(pin.target.length, `${rel} 缺少拆解目标`).toBeGreaterThan(10);
    }
  });
});
