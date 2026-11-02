/**
 * 页面保存（shell 主进程，纯逻辑，零 electron 依赖）。
 *
 * 为什么不用 Electron 的 savePage API：那需要 Page 对象/下载管线，且与「会话级 BrowserHost」耦合；
 * 这里用 BrowserHost 已有的 executeScript 取 `document.title` + `documentElement.outerHTML`，
 * 由主进程用 node:fs 落盘——同一实现可被 IPC（browser:savePage）与 Agent 工具复用，也便于单测。
 *
 * 存储位置：<downloadDir 或 dataDir>/saved-pages/<清洗后的标题>-<时间戳>.html
 * 限制：空内容拒绝；超过 20MB 拒绝（防止把超大页面/内联 base64 拖垮主进程与磁盘）。
 */
import fs from "node:fs";
import path from "node:path";

/** 单次保存最大字节数（20MB）：超过即拒绝，避免写爆磁盘/主进程内存。 */
export const SAVE_PAGE_MAX_BYTES = 20 * 1024 * 1024;

/** 保存结果：成功带路径/标题/字节数，失败带可读中文错误。 */
export type SavePageResult =
  | { ok: true; path: string; title: string; bytes: number }
  | { ok: false; error: string };

/** 页面上下文的最小接口（BrowserHost 满足；测试用假对象）。 */
export interface SavePageHost {
  executeScript(script: string, sessionId?: string): Promise<unknown>;
}

export interface SavePageOptions {
  host: SavePageHost;
  /** 下载目录（偏好 downloadDir）；空串/未提供时落到 dataDir。 */
  downloadDir?: string;
  /** 数据目录（下载目录为空时的兜底）。 */
  dataDir: string;
  sessionId?: string;
  /** 时间源（测试注入；默认 Date.now，仅用于文件名时间戳）。 */
  now?: () => number;
}

/** 取标题与整页 HTML 的注入脚本（返回 JSON-safe 对象，不依赖任何 electron API）。 */
const CAPTURE_SCRIPT = `(() => ({
  title: (document.title || "").trim(),
  html: document.documentElement ? document.documentElement.outerHTML : ""
}))()`;

/** 文件名清洗：去掉 Windows 非法字符与控制字符，去首尾点，限制长度，兜底默认名。 */
export function sanitizeFileName(title: string, fallback = "saved-page"): string {
  let name = String(title ?? "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  // 首尾点/空格在 Windows 上非法或会生成隐藏文件
  name = name.replace(/^[.\s]+/, "").replace(/[.\s]+$/, "");
  // Windows 保留设备名（CON/PRN/AUX/NUL/COM1/LPT1…）加前缀避免创建失败
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) name = `_${name}`;
  if (name.length > 80) name = name.slice(0, 80).trim();
  return name || fallback;
}

/** 文件名时间戳（本地时区）：YYYYMMDD-HHmmss。 */
function formatStamp(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * 补 UTF-8 声明：outerHTML 通常带 charset，但缺省时保存的本地文件用浏览器打开会乱码。
 * 只在缺失时注入，避免重复声明。
 */
export function ensureUtf8Meta(html: string): string {
  const head = html.slice(0, 4096);
  if (/<meta[^>]+charset\s*=/i.test(head)) return html;
  if (/<head(\s[^>]*)?>/i.test(html)) {
    return html.replace(/<head(\s[^>]*)?>/i, (match) => `${match}<meta charset="utf-8">`);
  }
  return `<meta charset="utf-8">${html}`;
}

/** 补 DOCTYPE：保存的页面用浏览器打开时按标准模式渲染（否则可能怪异模式）。 */
function ensureDoctype(html: string): string {
  return /<!doctype/i.test(html.slice(0, 256)) ? html : `<!DOCTYPE html>\n${html}`;
}

/** 在目标目录里挑一个不存在的文件名（同一秒重复保存时追加序号）。 */
function uniqueFile(dir: string, baseName: string): string {
  for (let index = 0; index < 50; index += 1) {
    const suffix = index === 0 ? "" : `-${index}`;
    const candidate = path.join(dir, `${baseName}${suffix}.html`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${baseName}-${Date.now().toString(36)}.html`);
}

/**
 * 保存当前活动标签页为完整 HTML 文件。
 * 失败一律返回 { ok:false, error }（不抛异常），供 IPC/工具直接展示。
 */
export async function saveActivePage(opts: SavePageOptions): Promise<SavePageResult> {
  let raw: unknown;
  try {
    raw = await opts.host.executeScript(CAPTURE_SCRIPT, opts.sessionId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `保存页面失败：${message}` };
  }

  const captured = (raw ?? {}) as { title?: unknown; html?: unknown };
  const rawHtml = typeof captured.html === "string" ? captured.html : "";
  if (!rawHtml.trim()) {
    return { ok: false, error: "无法读取页面内容（页面可能尚未加载完成或已关闭）" };
  }
  const title = (typeof captured.title === "string" ? captured.title : "").trim().slice(0, 200);

  const html = ensureDoctype(ensureUtf8Meta(rawHtml));
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes <= 0) return { ok: false, error: "页面内容为空（0 字节），拒绝保存" };
  if (bytes > SAVE_PAGE_MAX_BYTES) {
    const sizeMb = (bytes / 1024 / 1024).toFixed(1);
    return { ok: false, error: `页面过大（${sizeMb}MB），超过保存上限 ${SAVE_PAGE_MAX_BYTES / 1024 / 1024}MB` };
  }

  const downloadDir = String(opts.downloadDir ?? "").trim();
  const baseDir = downloadDir || opts.dataDir;
  if (!baseDir) return { ok: false, error: "未配置保存目录（下载目录/数据目录均不可用）" };
  const dir = path.join(baseDir, "saved-pages");
  const stamp = formatStamp((opts.now ?? Date.now)());
  const baseName = `${sanitizeFileName(title)}-${stamp}`;

  let file: string;
  try {
    fs.mkdirSync(dir, { recursive: true });
    file = uniqueFile(dir, baseName);
    fs.writeFileSync(file, html, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `保存页面失败：写入 ${dir} 出错（${message}）` };
  }

  return { ok: true, path: file, title, bytes };
}
