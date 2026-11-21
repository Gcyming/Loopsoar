/**
 * 编译进程树守护 packages/shell/resources/jobGuard.exe。
 *
 * 为什么用 csc 而不是 MSVC：Windows 10/11 自带 .NET Framework 的 C# 编译器，
 * 打包机不需要安装 Visual Studio；产物只有几 KB，入库与随包分发都无压力。
 * 源码在 packages/shell/tools/jobGuard.cs，改了源码重新跑本脚本即可。
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE = path.join(ROOT, "packages/shell/tools/jobGuard.cs");
const OUT = path.join(ROOT, "packages/shell/resources/jobGuard.exe");
const CSC = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";

if (!existsSync(SOURCE)) {
  console.error("缺少源码：", SOURCE);
  process.exit(1);
}
if (existsSync(OUT) && statSync(OUT).mtimeMs >= statSync(SOURCE).mtimeMs) {
  console.log("jobGuard.exe 已是最新：", OUT);
  process.exit(0);
}
if (!existsSync(CSC)) {
  console.error("找不到 csc.exe（.NET Framework 4.x）：", CSC);
  process.exit(1);
}
const result = spawnSync(CSC, ["/nologo", "/optimize+", "/target:exe", `/out:${OUT}`, SOURCE], {
  stdio: "inherit",
  windowsHide: true,
});
if (result.status !== 0) {
  console.error("编译 jobGuard 失败，exit", result.status);
  process.exit(result.status ?? 1);
}
console.log("已编译：", OUT, `(${(statSync(OUT).size / 1024).toFixed(0)} KB)`);
