/**
 * 升级演练用构建：临时把版本号改成指定值（默认在当前版本上 +1），构建到独立目录，然后**无论成败都恢复**。
 *
 * 为什么要改源码：APP_VERSION 是 bundle 的构建期常量（brand.ts 单一产地），
 * 升级备份/版本记录都读它；只改安装包 package.json 不会触发「版本变化」逻辑。
 *
 * 用法：
 *   node scripts/drill-build-version.mjs --to 0.0.2 --out release/drill-0.0.2
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const brandPath = path.join(ROOT, "packages/shell/src/shared/brand.ts");
const rootPkgPath = path.join(ROOT, "package.json");
const shellPkgPath = path.join(ROOT, "packages/shell/package.json");
const targets = [brandPath, rootPkgPath, shellPkgPath];

const current = /APP_VERSION = "(\d+\.\d+\.\d+)"/.exec(readFileSync(brandPath, "utf8"))?.[1];
if (!current) {
  console.error("无法从 brand.ts 读取 APP_VERSION");
  process.exit(1);
}
const next = argOf("--to", current.split(".").slice(0, 2).concat(String(Number(current.split(".")[2]) + 1)).join("."));
const outDir = path.resolve(ROOT, argOf("--out", `release/drill-${next}`));
if (next === current) {
  console.error("演练版本不能与当前版本相同：", current);
  process.exit(1);
}

const backup = mkdtempSync(path.join(os.tmpdir(), "loopsoar-drill-"));
const restore = () => {
  for (const [index, target] of targets.entries()) copyFileSync(path.join(backup, String(index)), target);
  rmSync(backup, { recursive: true, force: true });
};
try {
  targets.forEach((target, index) => copyFileSync(target, path.join(backup, String(index))));
  const brand = readFileSync(brandPath, "utf8").replace(`APP_VERSION = "${current}"`, `APP_VERSION = "${next}"`);
  writeFileSync(brandPath, brand, "utf8");
  for (const pkgPath of [rootPkgPath, shellPkgPath]) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    pkg.version = next;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  }
  console.log(`演练构建：${current} → ${next}，输出 ${outDir}`);
  execFileSync(process.execPath, [path.join(ROOT, "scripts/package.mjs")], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, LOOPSOAR_OUT_DIR: outDir },
  });
  console.log("演练构建完成：", outDir);
} finally {
  restore();
  console.log("版本文件已恢复为", current);
}
