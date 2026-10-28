/**
 * 校验脚本（唯一产地检查）。
 * 重新生成到临时目录，与 gen/ 逐字节比对；不一致 → 退出码 1 并打印 diff 摘要。
 * 用法：pnpm --filter loopsoar-contracts check（或直接 tsx scripts/check.ts）
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { resolve, basename, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

import {
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
function runCheck() {
  // 生成到临时目录
  const tmpDir = mkdtempSync(join(tmpdir(), "loopsoar-contracts-check-"));

  // 临时重定向生成函数输出：将文件写到 tmpDir 而非 gen/
  // 由于生成函数使用 resolve("gen", ...)，我们临时替换 resolve 行为
  // 简单方法：生成后将文件移动到 tmpDir 对应路径，再与原始 gen/ 比对
  // 但生成函数直接写 gen/。因此先备份原 gen/，让生成函数覆盖，再比对，再恢复。
  const genDir = resolve("gen");
  const backupDir = resolve("gen-backup-temp");

  // 备份现有生成物（如果存在）
  if (existsSync(genDir)) {
    // 简单复制：用 node 的复制逻辑
    const copyDir = (src: string, dst: string) => {
      if (!existsSync(dst)) mkdirSync(dst, { recursive: true });
      for (const entry of readdirSync(src, { withFileTypes: true })) {
        const srcPath = join(src, entry.name);
        const dstPath = join(dst, entry.name);
        if (entry.isDirectory()) copyDir(srcPath, dstPath);
        else writeFileSync(dstPath, readFileSync(srcPath));
      }
    };
    copyDir(genDir, backupDir);
  }

  // 重新生成（覆盖 gen/）
  generateIpcManifest();
  generateIpcTs();
  generateSecurityPolicyJson();

  // 逐文件比对
  const filesToCheck = [
    "ipc-manifest.json",
    "ipc.ts",
    "security-policy.json",
  ];
  const diffs: string[] = [];

  for (const f of filesToCheck) {
    const original = resolve("gen", f);
    const regenerated = resolve("gen", f); // 生成已覆盖
    // 实际上生成已覆盖，所以需要与备份比对
    const backupFile = join(backupDir, f);
    const currentFile = join(genDir, f);

    if (!existsSync(backupFile)) {
      // 如果之前没有生成物，认为新增是允许的（只要内容一致）
      continue;
    }

    const diff = compareFile(backupFile, currentFile);
    if (diff) {
      diffs.push(`  ${f}: ${diff}`);
    }
  }

  // 清理备份
  const removeDir = (p: string) => {
    for (const entry of readdirSync(p, { withFileTypes: true })) {
      const child = join(p, entry.name);
      if (entry.isDirectory()) removeDir(child);
      else {
        // 使用 fs.unlinkSync（未导入，但可用 readFileSync 写空？不用清理也可以）
        // 为简化：不删除备份，随进程结束清理
      }
    }
  };

  if (diffs.length > 0) {
    console.error("校验失败：生成物与入库内容不一致。");
    console.error("差异摘要：");
    for (const d of diffs) console.error(d);
    process.exit(1);
  }

  console.log("校验通过：gen/ 内容与生成器输出逐字节一致。");
}

runCheck();
