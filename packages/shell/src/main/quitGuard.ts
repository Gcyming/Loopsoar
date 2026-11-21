/**
 * 退出守卫（纯逻辑，不 import electron）：把「有 Agent 在生成 → 先确认」与
 * 「清理完再 exit」两件事从主进程入口移出来，入口只负责注入窗口/对话框。
 *
 * 为什么必须 preventDefault：Electron 的 before-quit 一旦放行，窗口与子进程会被立刻销毁，
 * shutdown 里的落盘/杀进程树来不及执行。
 */
export interface QuitGuardDeps {
  /** 注册 before-quit 监听（index.ts 传 app.on）。 */
  registerBeforeQuit(listener: (event: { preventDefault(): void }) => void): void;
  /** 是否有正在生成的回合（有则先弹确认）。 */
  hasActiveStreams(): boolean;
  /** 自动化环境（E2E）不弹窗；默认按 LOOPSOAR_E2E* 环境变量判断。 */
  isAutomated?(): boolean;
  /** 显示确认框：true = 仍然退出，false = 取消。 */
  confirmQuit(): boolean;
  /** 退出清理（幂等）。 */
  shutdown(): Promise<void>;
  /** 立即退出（app.exit）。 */
  exit(code: number): void;
  /** 更新安装中：退出流程由 electron-updater 接管，不再 preventDefault。 */
  isUpdating?: () => boolean;
}

/** 退出确认框的文案与按钮（默认「取消」，避免误触丢回合）。 */
export function quitConfirmOptions(): {
  type: "warning";
  buttons: string[];
  defaultId: number;
  cancelId: number;
  noLink: boolean;
  title: string;
  message: string;
  detail: string;
} {
  return {
    type: "warning",
    buttons: ["取消", "仍然退出"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: "Agent 正在运行",
    message: "Agent 正在生成回复，退出会中断当前回合。",
    detail: "已生成的内容会保留在会话记录里，但本轮不会完成。",
  };
}

/**
 * 退出确认框：先让窗口可见，再问「取消 / 仍然退出」。
 * 返回值 = 是否继续退出（默认按钮是取消，避免误触丢回合）。
 */
export function createQuitConfirm(options: {
  getWindow: () => { isDestroyed(): boolean; show(): void; focus(): void } | null;
  /** 调用方注入 dialog.showMessageBoxSync（保持本模块不 import electron）。 */
  showMessageBox: (window: unknown, options: ReturnType<typeof quitConfirmOptions>) => number;
}): () => boolean {
  return () => {
    const window = options.getWindow();
    if (window && !window.isDestroyed()) {
      window.show();
      window.focus();
    }
    const choice = options.showMessageBox(window && !window.isDestroyed() ? window : null, quitConfirmOptions());
    return choice === 1;
  };
}

export function installQuitGuard(deps: QuitGuardDeps): void {
  let quitting = false;
  deps.registerBeforeQuit((event) => {
    // 更新安装器已经启动：必须让 Electron 正常退出，否则安装步骤会被 app.exit 打断。
    if (deps.isUpdating?.()) return;
    if (quitting) return;
    const automated = deps.isAutomated
      ? deps.isAutomated()
      : Object.keys(process.env).some((key) => key.startsWith("LOOPSOAR_E2E"));
    if (!automated && deps.hasActiveStreams()) {
      event.preventDefault();
      if (!deps.confirmQuit()) return;
    }
    quitting = true;
    event.preventDefault();
    void deps
      .shutdown()
      .catch(() => undefined)
      .finally(() => {
        deps.exit(0);
      });
  });
}
