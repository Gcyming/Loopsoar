/**
 * 数据目录解析（无 Electron 依赖，便于单测）。
 *
 * 背景：`app.setPath("userData", value)` 只接受绝对路径；如果有人用
 * `LOOPSOAR_DATA_DIR=.loopsoar-data`（脚本/开发环境常见写法）启动，Electron 会在
 * 加载主进程时直接抛 “Path must be absolute”。这里统一做绝对化归一，
 * 让相对覆盖值也能正常启动。
 */
import os from "node:os";
import path from "node:path";
import { ensureLoopsoarDirs } from "./boot.js";
import { DATA_DIR_NAME } from "../shared/brand.js";

/** 把 LOOPSOAR_DATA_DIR 归一为绝对路径；未设置（或全空白）时落到 appData 下的品牌目录。 */
export function resolveDataDir(override: string | undefined, appDataPath: string): string {
  const trimmed = override?.trim();
  return trimmed ? path.resolve(trimmed) : path.join(appDataPath, DATA_DIR_NAME);
}

/** 最小 app 路径接口，避免把 Electron 值导入纯模块。 */
export interface AppPathLike {
  getPath(name: "userData"): string;
  setPath(name: "userData", value: string): void;
}

/**
 * 解析可写数据根：优先显式覆盖 → 品牌 userData → 工作区本地目录 → 临时目录。
 * 为什么做降级链：受限会话/只读盘上 %APPDATA% 可能不可写，宁可换目录也不能启动即挂。
 */
export function ensureWritableDataDirs(
  app: AppPathLike,
  options: { allowCwdFallback?: boolean } = {},
): ReturnType<typeof ensureLoopsoarDirs> {
  const candidates = [
    process.env.LOOPSOAR_DATA_DIR,
    app.getPath("userData"),
    // 打包态不允许落到 cwd：快捷方式的 cwd 是安装目录，会把用户数据写进程序目录
    // （卸载时一起被删，或被只读 ACL 拒绝后启动失败）。
    ...(options.allowCwdFallback === false ? [] : [path.join(process.cwd(), ".loopsoar-data")]),
    path.join(os.tmpdir(), `loopsoar-${process.pid}`),
  ].filter((c): c is string => typeof c === "string" && c.length > 0);

  let lastErr: unknown = new Error("无可写数据目录");
  for (const root of candidates) {
    try {
      const dirs = ensureLoopsoarDirs(root);
      app.setPath("userData", root);
      return dirs;
    } catch (err) {
      if (process.env.LOOPSOAR_E2E_SECRET_DUMP) {
        console.log(`[E2E] dataDir candidate failed: ${root} → ${err instanceof Error ? err.message : String(err)}`);
      }
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
