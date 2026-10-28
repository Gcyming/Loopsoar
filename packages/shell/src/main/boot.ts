/**
 * boot 辅助：数据目录、自定义协议处理器、UI 产物服务。不 import electron（仅 index.ts / electronBrowser.ts 允许）。
 */
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { mapRequestToFile, UI_ENTRY } from "./uiProtocol.js";

/**
 * 永存双根之一：userDataRoot 已是 %APPDATA%\loopsoar（index.ts 用 app.setPath 显式落位）。
 * 这里按「品牌目录 = userData 根」约定，再建 Knowledge（人读区）与 config（非机密配置）。
 */
export function ensureLoopsoarDirs(userDataRoot: string): {
  dataDir: string;
  knowledgeDir: string;
  configDir: string;
} {
  const dataDir = userDataRoot;
  const knowledgeDir = path.join(dataDir, "Knowledge");
  const configDir = path.join(dataDir, "config");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(knowledgeDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  return { dataDir, knowledgeDir, configDir };
}

export interface ProtocolRequestLike {
  url: string;
}

/**
 * loopsoar:// 协议处理器：只读 ui/dist 内的静态文件（穿越防护在 mapRequestToFile 内，已单测）。
 * 为什么同步读文件：UI 产物是小体积静态资源，启动期一次性读取足够；
 * 若未来切流式大文件，再换 createReadStream（协议处理器支持返回 Response 流）。
 */
export function makeUiProtocolHandler(
  distDir: string,
): (req: ProtocolRequestLike) => Promise<Response> {
  return async (req) => {
    const mapping = mapRequestToFile(req.url, distDir);
    if (!mapping.ok) {
      return new Response(mapping.reason, {
        status: mapping.status,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    try {
      const data = readFileSync(mapping.filePath);
      return new Response(new Uint8Array(data), {
        headers: { "content-type": mapping.contentType },
      });
    } catch {
      return new Response(`资源不存在：${path.basename(mapping.filePath)}`, {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
  };
}

/** 兜底处理器：ui/dist 缺失时给出可读提示页（不白屏、不崩溃）。 */
export function makePlaceholderProtocolHandler(): (
  req: ProtocolRequestLike,
) => Promise<Response> {
  return async (req) => {
    const isEntry = new URL(req.url).pathname.endsWith(UI_ENTRY) || new URL(req.url).pathname === "/";
    if (!isEntry) {
      return new Response("not found", { status: 404 });
    }
    return new Response(
      `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Loopsoar</title></head>
<body style="font-family:system-ui;background:#0b1021;color:#e8eaed;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center">
<h1 style="margin:0 0 12px">Loopsoar</h1>
<p style="color:#9ca3af;margin:0">UI 产物缺失：请先运行 <code>pnpm --filter loopsoar-ui build</code></p>
</div></body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  };
}
