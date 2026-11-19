/**
 * 校验脚本（唯一产地检查）。
 * 重新生成到临时目录，与 gen/ 逐字节比对；不一致 → 退出码 1 并打印 diff 摘要。
 * 用法：pnpm --filter loopsoar-contracts check（或直接 tsx scripts/check.ts）
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  GENERATED_FILES,
  generateIpcManifest,
  generateIpcTs,
  generateSecurityPolicyJson,
} from "./gen.ts";

/**
 * 比对两个文件的字节内容。返回差异信息或 null（完全一致）。
 */
function compareFile(aPath: string, bPath: string): string | null {
  const a = readFileSync(aPath);
  const b = readFileSync(bPath);
  if (a.length !== b.length) {
    return `长度不同: ${aPath} (${a.length} 字节) vs ${bPath} (${b.length} 字节)`;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      const snippetA = a.slice(Math.max(0, i - 20), i + 20).toString("utf8").replace(/\n/g, "\\n");
      const snippetB = b.slice(Math.max(0, i - 20), i + 20).toString("utf8").replace(/\n/g, "\\n");
      return `首差异字节偏移 ${i}: ${aPath} 片段 [${snippetA}] vs ${bPath} 片段 [${snippetB}]`;
    }
  }
  return null;
}

/**
 * 主校验流程。
 */
function runCheck(): void {
  const tmpDir = mkdtempSync(join(tmpdir(), "loopsoar-contracts-check-"));
  try {
    generateIpcManifest(tmpDir);
    generateIpcTs(tmpDir);
    generateSecurityPolicyJson(tmpDir);

    const genDir = resolve("gen");
    const diffs: string[] = [];

    for (const file of GENERATED_FILES) {
      const original = join(genDir, file);
      const regenerated = join(tmpDir, file);
      if (!existsSync(original)) {
        diffs.push(`  ${file}: 入库文件缺失（请运行 pnpm --filter loopsoar-contracts gen）`);
        continue;
      }
      const diff = compareFile(original, regenerated);
      if (diff) diffs.push(`  ${file}: ${diff}`);
    }

    if (diffs.length > 0) {
      console.error("校验失败：生成物与入库内容不一致。");
      console.error("差异摘要：");
      for (const diff of diffs) console.error(diff);
      process.exitCode = 1;
      return;
    }

    console.log("校验通过：gen/ 内容与生成器输出逐字节一致。");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

runCheck();
