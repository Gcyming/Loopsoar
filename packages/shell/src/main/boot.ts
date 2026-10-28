/**
 * boot 辅助：数据目录与自定义协议。不 import electron（仅 index.ts 允许）。
 */
import { mkdirSync } from "node:fs";
import path from "node:path";

/** 永存双根之一：userDataRoot 已是 %APPDATA%\loopsoar（index.ts 用 app.setPath 显式落位）。
 *  why：Electron 默认把 userData 放 %APPDATA%\<包名>，与品牌目录不一致会写进别的应用数据区；
 *  这里按「品牌目录 = userData 根」约定，再建 Knowledge（人读区）与 config（非机密配置）。 */
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

/** loopsoar:// 协议处理器：D0/打包阶段实现资源路由；当前返回占位页。 */
export function makeProtocolHandler(
  fetchFn: (url: string) => Promise<Response>,
): (req: { url: string }) => Promise<Response> {
  return async (req) => {
    void req;
    return fetchFn("data:text/html;charset=utf-8,<h1>Loopsoar shell placeholder</h1>");
  };
}
