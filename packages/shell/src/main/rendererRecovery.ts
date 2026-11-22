/**
 * 主窗口渲染进程自愈。
 *
 * 为什么单独存在：Electron 的 `render-process-gone` 只表示「网页进程死了」，
 * 主进程和 Agent 回合仍然活着；如果只写日志，窗口会保留一块黑色/隐藏的空壳，
 * 用户看到的就是「应用突然没有渲染内容」。这里把一次瞬态崩溃收敛为：
 * 记录 → 显示窗口 → 受控 reload；连续崩溃则落到可操作的错误页，而不是永久黑屏。
 *
 * 不依赖 electron 的纯逻辑（用最小窗口/网页接口），便于单测。
 */

export interface RendererRecoveryWebContents {
  reload(): void;
  loadURL(url: string): Promise<void> | void;
  getURL?(): string;
  getOSProcessId?(): number;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

export interface RendererRecoveryWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  show(): void;
  focus?(): void;
  webContents: RendererRecoveryWebContents;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

export interface RendererRecoveryOptions {
  /** 主窗口；回调内的 win 已销毁时全部降级为 no-op。 */
  window: RendererRecoveryWindow;
  /** 退出流程中不重启渲染器（否则会和关闭窗口抢生命周期）。 */
  isQuitting?: () => boolean;
  /** 崩溃/恢复取证；由主进程写入 crash.log 或 console。 */
  onEvent?: (kind: string, detail?: unknown) => void;
  /** 连续失败后显示的静态错误页，默认带「重新加载」按钮。 */
  errorPageUrl?: string;
  /** 同一窗口在 retryWindowMs 内允许的自动重载次数。 */
  maxAttempts?: number;
  retryWindowMs?: number;
  /** 页面被 Chromium 判定 unresponsive 后等待多久才 reload。 */
  unresponsiveMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_WINDOW_MS = 60_000;
const DEFAULT_UNRESPONSIVE_MS = 10_000;
/** 第一次崩溃立即回载；后续留出一点时间让 Chromium 清理旧进程。 */
const FIRST_RETRY_DELAY_MS = 250;
const LATER_RETRY_DELAY_MS = 1_000;

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 安装主窗口渲染进程看门狗，返回卸载函数。
 *
 * 关键行为：
 *   · `render-process-gone`（非 clean-exit）→ 显示窗口（若崩溃前可见）→ 250ms/1s 后 reload；
 *   · `unresponsive` 持续 10s → 同样走受控 reload，避免“窗口还在但永远画不出”；
 *   · `did-finish-load` → 清零连续失败计数；
 *   · 连续超过 maxAttempts → 加载静态错误页，保留可点击的重新加载入口。
 *
 * 注意：reload 不重建 BrowserWindow，也不会重置 Agent 回合；它只恢复 UI 进程，
 * 因此正在后台执行的流不会因为界面崩溃而被错误地取消。
 */
export function attachRendererRecovery(options: RendererRecoveryOptions): () => void {
  const { window } = options;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryWindowMs = options.retryWindowMs ?? DEFAULT_RETRY_WINDOW_MS;
  const unresponsiveMs = options.unresponsiveMs ?? DEFAULT_UNRESPONSIVE_MS;
  const onEvent = options.onEvent ?? (() => undefined);

  let disposed = false;
  let wasVisible = window.isVisible();
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let unresponsiveTimer: ReturnType<typeof setTimeout> | null = null;
  let healthTimer: ReturnType<typeof setInterval> | null = null;
  let attempts: number[] = [];
  let generation = 0;
  let hasFinishedLoad = false;
  let lastUrl = "";
  let deadProbes = 0;

  const alive = (): boolean => !disposed && !window.isDestroyed();

  const showIfNeeded = (visible: boolean): void => {
    if (!visible || !alive()) return;
    try {
      window.show();
      window.focus?.();
    } catch (error) {
      onEvent("renderer-show-failed", { error: safeMessage(error) });
    }
  };

  const clearTimers = (): void => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (unresponsiveTimer !== null) {
      clearTimeout(unresponsiveTimer);
      unresponsiveTimer = null;
    }
    if (healthTimer !== null) {
      clearInterval(healthTimer);
      healthTimer = null;
    }
  };

  const fallback = (detail: unknown): void => {
    if (!alive()) return;
    const fallbackUrl =
      options.errorPageUrl ??
      `data:text/html;charset=utf-8,${encodeURIComponent(
        `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
          html,body{height:100%;margin:0;background:#111318;color:#f5efe6;font:14px/1.7 system-ui,"Segoe UI",sans-serif}
          main{max-width:520px;margin:18vh auto;padding:28px 32px;border:1px solid #343943;border-radius:16px;background:#191d24}
          h1{font-size:18px;margin:0 0 10px} p{color:#b9b2a7;margin:0 0 20px}
          a{display:inline-block;padding:9px 16px;border-radius:9px;background:#e7a54b;color:#1b1710;text-decoration:none;font-weight:600}
        </style><main><h1>界面进程连续异常</h1>
        <p>Loopsoar 的界面渲染进程多次退出，已停止自动重载。你的会话和正在运行的任务仍在主进程中，请重新加载或重启应用。</p>
        <a href="loopsoar://app/index.html">重新加载 Loopsoar</a></main></html>`,
      )}`;
    try {
      onEvent("renderer-recovery-exhausted", detail);
      const result = window.webContents.loadURL(fallbackUrl);
      if (result && typeof (result as Promise<void>).catch === "function") {
        void (result as Promise<void>).catch((error: unknown) =>
          onEvent("renderer-fallback-failed", { error: safeMessage(error) }),
        );
      }
    } catch (error) {
      onEvent("renderer-fallback-failed", { error: safeMessage(error) });
    }
  };

  const scheduleReload = (visible: boolean, reason: string): void => {
    if (!alive() || options.isQuitting?.() || retryTimer !== null) return;

    const now = Date.now();
    attempts = attempts.filter((at) => now - at < retryWindowMs);
    if (attempts.length >= maxAttempts) {
      attempts.push(now);
      showIfNeeded(visible);
      fallback({ reason, attempts: attempts.length });
      return;
    }

    attempts.push(now);
    const attempt = attempts.length;
    // 新一轮加载开始前先关掉「已加载」状态：崩溃后的 reload 到新进程启动之间
    // getOSProcessId() 可能是 0，健康探针不能把这个窗口误判成第二次崩溃。
    hasFinishedLoad = false;
    deadProbes = 0;
    showIfNeeded(visible);
    const delay = attempt === 1 ? FIRST_RETRY_DELAY_MS : LATER_RETRY_DELAY_MS;
    onEvent("renderer-reload-scheduled", { reason, attempt, delay });
    const expectedGeneration = generation;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!alive() || expectedGeneration !== generation || options.isQuitting?.()) return;
      try {
        // 经验上 renderer 崩溃后 webContents.reload() 偶尔不会重新创建进程；
        // 用崩溃前的 URL 再 navigate 一次，比无限 reload 更可靠。
        if (lastUrl) {
          const result = window.webContents.loadURL(lastUrl);
          if (result && typeof (result as Promise<void>).catch === "function") {
            void (result as Promise<void>).catch((error: unknown) =>
              onEvent("renderer-navigate-failed", { error: safeMessage(error) }),
            );
          }
        } else {
          window.webContents.reload();
        }
        onEvent("renderer-reload", { reason, attempt });
      } catch (error) {
        fallback({ reason, error: safeMessage(error) });
      }
    }, delay);
  };

  const onRendererGone = (...args: unknown[]): void => {
    const details = (args[1] ?? {}) as { reason?: unknown; exitCode?: unknown };
    const reason = typeof details.reason === "string" ? details.reason : "unknown";
    const exitCode = details.exitCode;
    onEvent("renderer-process-gone", { reason, exitCode });
    // 正常关闭/退出不拉起，否则窗口关闭后又出现一个黑壳。
    if (reason === "clean-exit") return;
    scheduleReload(wasVisible, `renderer-${reason}`);
  };

  const onUnresponsive = (): void => {
    if (!alive() || unresponsiveTimer !== null) return;
    onEvent("renderer-unresponsive", { waitMs: unresponsiveMs });
    unresponsiveTimer = setTimeout(() => {
      unresponsiveTimer = null;
      scheduleReload(wasVisible, "unresponsive");
    }, unresponsiveMs);
  };

  const onResponsive = (): void => {
    if (unresponsiveTimer === null) return;
    clearTimeout(unresponsiveTimer);
    unresponsiveTimer = null;
    onEvent("renderer-responsive");
  };

  const onDidFinishLoad = (): void => {
    if (!alive()) return;
    hasFinishedLoad = true;
    deadProbes = 0;
    try {
      const current = window.webContents.getURL?.();
      if (current) lastUrl = current;
    } catch {
      // 窗口销毁边缘读取 URL 失败时沿用崩溃前记录
    }
    if (attempts.length > 0) onEvent("renderer-recovered", { attempts: attempts.length });
    attempts = [];
    generation += 1;
  };

  // 不能只依赖 render-process-gone：GPU 通道先崩时，Electron 可能保留一个
  // 无进程的 webContents。周期检查只在页面已成功加载过之后启用；连续两次
  // PID=0 才判定，给新 renderer 启动留出时间，避免自愈自己触发重试风暴。
  healthTimer = setInterval(() => {
    if (!alive() || !hasFinishedLoad || !window.isVisible() || retryTimer !== null) return;
    const pid = window.webContents.getOSProcessId?.();
    if (pid === 0) {
      deadProbes += 1;
      if (deadProbes >= 2) scheduleReload(true, "health-probe");
    } else {
      deadProbes = 0;
    }
  }, 5_000);
  healthTimer.unref?.();

  window.webContents.on("render-process-gone", onRendererGone);
  window.webContents.on("unresponsive", onUnresponsive);
  window.webContents.on("responsive", onResponsive);
  window.webContents.on("did-finish-load", onDidFinishLoad);
  window.on("show", () => {
    wasVisible = true;
    // 有些 Chromium 崩溃不会可靠触发 render-process-gone（例如 GPU 通道先挂）；
    // 重新显示时做一次进程存活探测，避免黑壳窗口被用户当成“应用没了”。
    if (!hasFinishedLoad) return;
    const pid = window.webContents.getOSProcessId?.();
    if (pid === 0) scheduleReload(true, "shown-without-renderer");
  });
  window.on("hide", () => {
    wasVisible = false;
  });
  window.on("closed", () => {
    // 主进程仍可能持有引用；卸载后所有延迟回调都必须失效。
    disposed = true;
    clearTimers();
  });

  return () => {
    disposed = true;
    clearTimers();
  };
}
