/**
 * 进程树守护（Windows Job Object）的主进程侧接线。
 *
 * 为什么要外部 exe：Node 没有创建 Windows Job Object 的能力，而「主进程被强杀后
 * 终端/MCP/扩展 worker/后台构建不能变成孤儿」只能靠内核级 job（KILL_ON_JOB_CLOSE）。
 * 实现见 packages/shell/tools/jobGuard.cs，随包放到 resources/jobGuard.exe。
 *
 * 行为：
 *   · 启动一个 detached 守护进程并传入主进程 PID；
 *   · 守护把主进程 Assign 进 job 后等待主进程退出；
 *   · 主进程以任何方式结束 → 守护退出 → job 句柄关闭 → 内核结束 job 内所有进程。
 *   · 守护缺失/启动失败只记录，不影响应用启动（降级到原有清理逻辑）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const GUARD_FILE = "jobGuard.exe";

/** 探测守护 exe：打包后在 resources/；开发态在 packages/shell/resources。 */
export function jobGuardCandidates(input: { moduleDir: string; resourcesPath?: string; cwd?: string }): string[] {
  const candidates: string[] = [];
  if (input.resourcesPath) candidates.push(path.join(input.resourcesPath, GUARD_FILE));
  candidates.push(path.join(input.moduleDir, "../resources", GUARD_FILE));
  candidates.push(path.join(input.moduleDir, "../../resources", GUARD_FILE));
  if (input.cwd) candidates.push(path.join(input.cwd, "packages/shell/resources", GUARD_FILE));
  return candidates;
}

/** 返回第一个存在的守护 exe；都不存在返回 null。 */
export function resolveJobGuardPath(input: { moduleDir: string; resourcesPath?: string; cwd?: string }): string | null {
  for (const candidate of jobGuardCandidates(input)) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // 权限/路径异常：继续试下一个
    }
  }
  return null;
}

/** 应用入口用的一步封装：解析 exe + 拉起守护（返回是否启用）。 */
export function startJobGuardForApp(input: {
  moduleDir: string;
  resourcesPath?: string;
  cwd?: string;
  pid?: number;
  platform?: NodeJS.Platform;
  spawnFn?: typeof spawn;
}): boolean {
  return startJobGuard({
    guardPath: resolveJobGuardPath(input),
    pid: input.pid ?? process.pid,
    platform: input.platform,
    spawnFn: input.spawnFn,
  });
}

export interface StartJobGuardOptions {
  guardPath: string | null;
  pid: number;
  platform?: NodeJS.Platform;
  /** 测试注入；返回是否成功拉起守护。 */
  spawnFn?: typeof spawn;
  log?: (message: string) => void;
}

/** 拉起守护；返回是否成功（失败只记录，不影响启动）。 */
export function startJobGuard(options: StartJobGuardOptions): boolean {
  const platform = options.platform ?? process.platform;
  const log = options.log ?? ((message: string) => console.warn(message));
  if (platform !== "win32") return false;
  if (!options.guardPath) {
    log("[Loopsoar] 未找到 jobGuard.exe，进程树守护未启用（强杀后可能残留子进程）");
    return false;
  }
  try {
    const spawnFn = options.spawnFn ?? spawn;
    const child = spawnFn(options.guardPath, [String(options.pid)], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    log(`[Loopsoar] 进程树守护已启动：pid=${options.pid}`);
    return true;
  } catch (err) {
    log(`[Loopsoar] 进程树守护启动失败（已忽略）：${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
