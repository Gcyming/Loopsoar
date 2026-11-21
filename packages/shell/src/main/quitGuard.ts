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
  /** 自动化环境（E2E）不弹窗；返回 true 时直接退出。 */
  isAutomated(): boolean;
  /** 显示确认框：true = 仍然退出，false = 取消。 */
  confirmQuit(): boolean;
  /** 退出清理（幂等）。 */
  shutdown(): Promise<void>;
  /** 立即退出（app.exit）。 */
  exit(code: number): void;
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

export function installQuitGuard(deps: QuitGuardDeps): void {
  let quitting = false;
  deps.registerBeforeQuit((event) => {
    if (quitting) return;
    if (!deps.isAutomated() && deps.hasActiveStreams()) {
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
