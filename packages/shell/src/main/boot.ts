/**
 * boot 辅助：数据目录与自定义协议。不 import electron（仅 index.ts 允许）。
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DATA_DIR_NAME } from "../shared/brand.js";

/** 永存双根之一：%APPDATA%\loopsoar（Knowledge 人读区 / 机读区后续按单写者划分）。 */
export function ensureLoopsoarDirs(userDataRoot: string): { dataDir: string; knowledgeDir: string } {
  const dataDir = path.join(userDataRoot, DATA_DIR_NAME);
  const knowledgeDir = path.join(dataDir, "Knowledge");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(knowledgeDir, { recursive: true });
  return { dataDir, knowledgeDir };
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
