/** 主窗口路径与原生文件夹打开（无 Electron 运行时依赖，shell.openPath 由 index 注入）。 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveAppIconPath } from "./appIcon.js";

/** 应用图标路径：dist/src/打包三种目录深度都探测，Windows 优先多档 .ico（详见 appIcon.ts）。 */
export function iconPath(): string | undefined {
  return resolveAppIconPath({
    dirname: __dirname,
    resourcesPath: process.resourcesPath,
    cwd: process.cwd(),
    platform: process.platform,
  });
}

/** preload 路径按运行形态探测（bundle/dist 运行与 src 运行目录深度不同）。 */
export function preloadPath(): string {
  const candidates = [
    path.join(__dirname, "../src/preload/index.cjs"), // bundle/dist 运行
    path.join(__dirname, "../../src/preload/index.cjs"), // src/main 运行
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) console.error("PRELOAD_NOT_FOUND candidates=", candidates);
  return found ?? candidates[0];
}

/** 打开文件夹：Windows 直接拉起 explorer.exe；其他平台用注入的 shell.openPath。 */
export async function openDirectoryNative(
  dir: string,
  openPath: (target: string) => Promise<string>,
): Promise<string> {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // 已存在/权限问题交给后续检查
  }
  if (!fs.existsSync(dir)) return `目录不存在：${dir}`;
  if (process.platform === "win32") {
    try {
      const child = spawn("explorer.exe", [dir], { detached: true, stdio: "ignore" });
      child.unref();
      return "";
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
  return (await openPath(dir)) || "";
}
