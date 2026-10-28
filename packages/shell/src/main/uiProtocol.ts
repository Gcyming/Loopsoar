/**
 * loopsoar:// 协议 → UI 产物映射（纯函数，可单测）。
 * 为什么单独建模：协议处理器是渲染进程的「文件系统入口」，路径穿越是经典攻击面，
 * 这段逻辑必须可测且不掺 electron 依赖。
 */
import path from "node:path";
import { existsSync } from "node:fs";

/** 入口页（省略路径时返回）。 */
export const UI_ENTRY = "index.html";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

export function contentTypeFor(filePath: string): string {
  return MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/** 候选 UI 产物目录（src 运行 / dist 运行 / bundle 运行 / cwd 运行都能命中）。 */
export function uiDistCandidates(moduleDir: string, cwd: string): string[] {
  return [
    path.resolve(moduleDir, "../../ui/dist"), // dist/ 或 src/main/ 运行
    path.resolve(moduleDir, "../../../ui/dist"), // src/main 运行
    path.resolve(moduleDir, "../../../../ui/dist"),
    path.resolve(cwd, "packages/ui/dist"),
    path.resolve(cwd, "../packages/ui/dist"),
  ];
}

/** 找到第一个含 index.html 的候选目录；都没有 → null（由调用方决定降级）。 */
export function resolveUiDistDir(candidates: string[]): string | null {
  for (const dir of candidates) {
    if (existsSync(path.join(dir, UI_ENTRY))) return dir;
  }
  return null;
}

export type FileMapping =
  | { ok: true; filePath: string; contentType: string }
  | { ok: false; status: number; reason: string };

/**
 * 把 loopsoar://app/<path> 映射到 distDir 内的真实文件。
 * 拒绝：非 app 主机、编码后的 ..、绝对路径、越界路径（resolve 后必须仍在 distDir 内）。
 */
export function mapRequestToFile(requestUrl: string, distDir: string): FileMapping {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return { ok: false, status: 400, reason: "非法 URL" };
  }
  if (parsed.host !== "app") {
    return { ok: false, status: 404, reason: `未知主机 ${parsed.host}` };
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return { ok: false, status: 400, reason: "非法路径编码" };
  }
  const rel = pathname === "/" || pathname === "" ? UI_ENTRY : pathname.replace(/^\/+/, "");

  // 显式拒绝常见穿越形态（Windows 反斜杠、URL 编码已解码、绝对盘符）
  if (rel.includes("\0")) return { ok: false, status: 400, reason: "非法路径" };
  const normalized = path.posix.normalize(rel);
  if (normalized.startsWith("..") || path.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
    return { ok: false, status: 403, reason: "路径越界" };
  }

  const distRoot = path.resolve(distDir);
  const filePath = path.resolve(distRoot, normalized);
  const relative = path.relative(distRoot, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { ok: false, status: 403, reason: "路径越界" };
  }
  return { ok: true, filePath, contentType: contentTypeFor(filePath) };
}
