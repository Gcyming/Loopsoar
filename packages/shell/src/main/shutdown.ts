/**
 * 退出清理编排（before-quit / 优雅退出）：
 *   保存浏览器标签 → 关闭 MCP → 停止扩展 → 关闭终端 → flush 审计
 *
 * 三条硬约束：
 *   ① 幂等：第二次调用直接返回同一个 Promise（Electron 的 before-quit 可能触发多次）；
 *   ② 隔离：Promise.allSettled，任何一步失败/抛同步异常都不影响其他步骤继续执行；
 *   ③ 兜底：整体超时（默认 3000ms）后返回，绝不因为某个子进程不响应而挂死退出流程。
 * 超时后不取消正在进行的步骤（进程即将退出，强杀交给 OS）；只是不再等待。
 */

export interface ShutdownDeps {
  /** 把每个会话的浏览器标签状态落盘（同步或异步均可）。 */
  saveBrowserStates: () => void | Promise<void>;
  /**
   * 把「仍在生成中」的回复已流出部分落盘（同步）。
   * 没有这一步时，退出瞬间正在写的回复会整段丢失，重启后表现为「回复截断」。
   */
  flushActiveStreams?: () => void;
  /** 断开并回收 MCP 子进程。 */
  shutdownMcp: () => void | Promise<void>;
  /** 停止扩展宿主子进程。 */
  stopExtensions: () => void | Promise<void>;
  /** 关闭所有持久终端会话（同步，避免退出流程再多一个等待点）。 */
  closeTerminals: () => void;
  /**
   * 杀掉后台任务进程树（构建/dev server 等）。
   * 为什么必须放这里：退出流程最后走 app.exit(0)，它不会触发 will-quit，
   * 只挂在 will-quit 的清理永远不会执行。
   */
  killBackgroundTasks?: () => void;
  /** 把审计队列刷盘。 */
  flushAudit: () => Promise<void>;
  /** 整体超时（默认 3000ms）。 */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 3_000;

/** 单步包一层 async：同步抛出的异常也会变成 rejected，被 allSettled 接住。 */
async function runStep(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    // 某一步失败只记录，不阻断其他步骤（退出路径必须「尽力而为」）
    console.warn(`[Loopsoar] 退出清理步骤 ${name} 失败（已忽略）：`, err instanceof Error ? err.message : err);
  }
}

/**
 * 整体超时兜底：到点直接 resolve（不取消底层步骤）。
 * 计时器 unref：即使步骤永不返回，也不因为清理计时器把进程吊住。
 */
function withTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), timeoutMs);
    timer.unref?.();
    void promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

/**
 * 创建退出处理器。返回值可重复调用：所有调用共享同一次清理。
 */
export function createShutdownHandler(deps: ShutdownDeps): () => Promise<void> {
  let started: Promise<void> | null = null;
  return (): Promise<void> => {
    if (started) return started;
    started = runShutdown(deps);
    return started;
  };
}

async function runShutdown(deps: ShutdownDeps): Promise<void> {
  const timeoutMs =
    typeof deps.timeoutMs === "number" && Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0
      ? deps.timeoutMs
      : DEFAULT_TIMEOUT_MS;

  const steps: Array<[string, () => void | Promise<void>]> = [
    ["flushActiveStreams", deps.flushActiveStreams ?? (() => undefined)],
    ["saveBrowserStates", deps.saveBrowserStates],
    ["shutdownMcp", deps.shutdownMcp],
    ["stopExtensions", deps.stopExtensions],
    ["closeTerminals", deps.closeTerminals],
    ["killBackgroundTasks", deps.killBackgroundTasks ?? (() => undefined)],
    ["flushAudit", deps.flushAudit],
  ];

  // 并发启动全部步骤：退出时总耗时取决于最慢的一步，而不是累加
  const settled = Promise.allSettled(steps.map(([name, fn]) => runStep(name, fn))).then(() => undefined);
  await withTimeout(settled, timeoutMs);
}
