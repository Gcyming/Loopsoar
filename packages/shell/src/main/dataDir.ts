/**
 * 数据目录解析（无 Electron 依赖，便于单测）。
 *
 * 背景：`app.setPath("userData", value)` 只接受绝对路径；如果有人用
 * `LOOPSOAR_DATA_DIR=.loopsoar-data`（脚本/开发环境常见写法）启动，Electron 会在
 * 加载主进程时直接抛 “Path must be absolute”。这里统一做绝对化归一，
 * 让相对覆盖值也能正常启动。
 */
import path from "node:path";
import { DATA_DIR_NAME } from "../shared/brand.js";

/** 把 LOOPSOAR_DATA_DIR 归一为绝对路径；未设置（或全空白）时落到 appData 下的品牌目录。 */
export function resolveDataDir(override: string | undefined, appDataPath: string): string {
  const trimmed = override?.trim();
  return trimmed ? path.resolve(trimmed) : path.join(appDataPath, DATA_DIR_NAME);
}
