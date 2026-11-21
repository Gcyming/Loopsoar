/**
 * 自动更新的纯策略（不 import electron，可单测）：
 *   · 只有 downloaded 才能安装；
 *   · Agent 回合运行中禁止安装（避免静默重启打断任务）；
 *   · 安装前必须先走退出清理。
 */
export type UpdateStateName =
  | "disabled"
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error";

export interface UpdatePolicySnapshot {
  state: UpdateStateName;
  version?: string;
}

export type InstallDecision = { ok: true } | { ok: false; error: string };

/** 安装门禁：状态 + 是否有运行中的 Agent 回合。 */
export function canInstallUpdate(snapshot: UpdatePolicySnapshot, hasActiveStreams: boolean): InstallDecision {
  if (snapshot.state === "disabled") return { ok: false, error: "当前版本未启用自动更新" };
  if (snapshot.state !== "downloaded") return { ok: false, error: "没有已下载的更新" };
  if (hasActiveStreams) return { ok: false, error: "Agent 正在运行，请停止后再安装更新" };
  return { ok: true };
}

/** 检查/下载的可用性（UI 按钮禁用逻辑与主进程保持一致）。 */
export function canCheckForUpdate(snapshot: UpdatePolicySnapshot): boolean {
  return snapshot.state !== "disabled" && snapshot.state !== "checking" && snapshot.state !== "downloading";
}

export function canDownloadUpdate(snapshot: UpdatePolicySnapshot): boolean {
  return snapshot.state === "available";
}
