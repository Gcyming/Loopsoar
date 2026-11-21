/**
 * 启动期「窗口/协议/崩踏转储」装配辅助（纯编排，不直接 import electron）。
 *
 * 抽出的目的：主进程入口是受行数棘轮约束的组合根；这些装配逻辑与业务无关，
 * 放在单独文件里可以单测候选路径、也避免入口继续长胖。
 */
import { installUiProtocol, type ProtocolRequestLike } from "./boot.js";
import { mkdirSync } from "node:fs";
import { resolveDataDir } from "./dataDir.js";
import { resolveUiDistDir, uiDistCandidates } from "./uiProtocol.js";

/** 解析 UI 产物目录并注册 loopsoar:// 协议（找不到时降级占位页）。 */
export function installUiProtocolFromApp(options: {
  protocolScheme: string;
  moduleDir: string;
  cwd: string;
  resourcesPath?: string;
  handle: (scheme: string, handler: (req: ProtocolRequestLike) => Promise<Response>) => void;
  warn: (message: string) => void;
}): string | null {
  const distDir = resolveUiDistDir(uiDistCandidates(options.moduleDir, options.cwd, options.resourcesPath));
  installUiProtocol({
    protocol: options.protocolScheme,
    distDir,
    handle: options.handle,
    warn: options.warn,
  });
  return distDir;
}

/** 品牌目录 + userData 落位（必须在任何 Chromium 路径/崩溃转储初始化之前）。 */
export function configureUserData(
  app: { setName(name: string): void; setPath(key: string, value: string): void; getPath(key: string): string },
  appName: string,
  override?: string,
): string {
  app.setName(appName);
  const dataDir = resolveDataDir(override, app.getPath("appData"));
  app.setPath("userData", dataDir);
  // Chromium 的 ProcessSingleton 不会替我们建 userData：目录不存在时单实例锁会失败，
  // 旧逻辑据此判定「已有实例」直接退出——首次安装就会表现为「双击没反应」。
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch {
    // 目录不可写：交给上层降级路径，仍继续启动
  }
  return dataDir;
}

/** 崩溃转储：只写本地（上传需用户同意）；打包态才启用。 */
export function installCrashReporter(
  reporter: { start(options: Record<string, unknown>): void },
  productName: string,
  enabled: boolean,
): void {
  if (!enabled) return;
  reporter.start({ uploadToServer: false, compress: true, productName });
}
