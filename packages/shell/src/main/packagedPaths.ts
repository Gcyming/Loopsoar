/**
 * 打包态路径工具（纯函数，可单测）。
 *
 * 为什么需要：Electron 的 asar 是只读虚拟文件系统，主进程用 fs 读没问题，
 * 但**子进程无法执行 asar 内的脚本**（process.execPath + asar 路径会直接失败）。
 * 因此 worker 脚本必须 asarUnpack 到 app.asar.unpacked，解析时要把 app.asar
 * 换成 app.asar.unpacked 再探测。
 */
import fs from "node:fs";
import path from "node:path";

/** 把路径里的 app.asar 段替换为 app.asar.unpacked（没有该段则原样返回）。 */
export function toUnpackedPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  if (!normalized.includes("/app.asar/")) return filePath;
  const replaced = normalized.replace("/app.asar/", "/app.asar.unpacked/");
  return filePath.includes("\\") ? replaced.replace(/\//g, "\\") : replaced;
}

/** 候选路径展开：每个候选同时给出「unpacked 版本」和原路径（unpacked 优先）。 */
export function withUnpackedCandidates(candidates: readonly string[]): string[] {
  const out: string[] = [];
  for (const candidate of candidates) {
    const unpacked = toUnpackedPath(candidate);
    if (unpacked !== candidate) out.push(unpacked);
    out.push(candidate);
  }
  return out;
}

/** 在候选里找第一个真实存在的文件；都不存在时返回 fallback。 */
export function firstExisting(candidates: readonly string[], fallback: string): string {
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // 权限/非法路径：继续试下一个
    }
  }
  return fallback;
}
