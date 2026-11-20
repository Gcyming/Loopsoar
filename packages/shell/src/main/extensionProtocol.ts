/**
 * 扩展富 UI 协议处理器：loopsoar-ext://<extensionId>/<path>
 *
 * 隔离模型：
 *   · 只服务"声明了 views 且已启用"的扩展目录，路径 realpath 必须落在目录内；
 *   · 响应带严格 CSP（default-src 'none'，脚本/样式只允许 self，connect-src 'none'）；
 *   · 由渲染层用 <iframe sandbox="allow-scripts"> 承载，扩展拿不到主界面 DOM/Electron API；
 *   · 与主界面 loopsoar:// 协议分属不同 origin，扩展无法读应用存储。
 *
 * 为什么用自定义协议而不是 file://：file:// 的 origin 语义不可控，且无法统一注入 CSP。
 */
import fs from "node:fs";
import path from "node:path";
import type { ExtensionHost } from "./extensions.js";

export const EXTENSION_UI_SCHEME = "loopsoar-ext";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function cspFor(extensionId: string): string {
  return [
    "default-src 'none'",
    // 沙箱 iframe 的 origin 是 opaque，'self' 不保证匹配自定义协议资源；
    // 显式按扩展 host 放行，避免 A 扩展加载 B 扩展的脚本/样式。
    `script-src loopsoar-ext://${extensionId}`,
    `style-src loopsoar-ext://${extensionId} 'unsafe-inline'`,
    `img-src loopsoar-ext://${extensionId} data:`,
    `font-src loopsoar-ext://${extensionId} data:`,
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors loopsoar://*",
  ].join("; ");
}

function notFound(message: string): Response {
  return new Response(message, { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
}

export function makeExtensionProtocolHandler(host: ExtensionHost): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return notFound("bad url");
    }
    const id = decodeURIComponent(url.hostname).toLowerCase();
    const item = host.list().find((entry) => entry.manifest.id.toLowerCase() === id);
    if (!item || !item.enabled) return notFound("extension not found");
    if ((item.manifest.contributes?.views?.length ?? 0) === 0) return notFound("extension declares no views");

    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    if (!relative) return notFound("missing path");
    const root = path.resolve(item.dir);
    const target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(root + path.sep)) return notFound("path escape");
    // realpath 二次校验：防止扩展目录内的 symlink 指向外部。
    let real: string;
    try {
      real = fs.realpathSync(target);
    } catch {
      return notFound("file not found");
    }
    const realRoot = fs.realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return notFound("path escape");
    let data: Buffer;
    try {
      const stat = fs.statSync(real);
      if (!stat.isFile()) return notFound("not a file");
      if (stat.size > 8 * 1024 * 1024) return notFound("file too large");
      data = fs.readFileSync(real);
    } catch {
      return notFound("read failed");
    }
    const mime = MIME[path.extname(real).toLowerCase()] ?? "application/octet-stream";
    return new Response(new Uint8Array(data), {
      status: 200,
      headers: {
        "content-type": mime,
        "content-security-policy": cspFor(id),
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      },
    });
  };
}
