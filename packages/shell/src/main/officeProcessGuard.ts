/**
 * Office 进程归属守卫：只允许结束「本应用自己启动、并记录过 PID」的 Office 进程。
 *
 * 背景：旧实现用 `taskkill /IM POWERPNT.EXE /F` 按映像名清理残留进程。用户恰好在
 * 导出/预览期间自己打开 PowerPoint 时，那条命令会连用户正在编辑的窗口一起杀掉。
 * 按映像名杀进程无法区分归属，唯一安全的依据是「我们启动时记下的 PID」。
 *
 * 归属规则（宁可漏杀，不可误杀）：
 *   1. 没有 PID 记录 → 不 kill：无法证明进程是本应用启动的；
 *   2. 记录过期 → 不 kill：PID 可能已被系统复用，旧记录不再有归属力；
 *   3. 进程快照查询失败 → 不 kill：无法证明进程还在，也不能盲目结束；
 *   4. 快照里没有该 PID → 进程已自然退出，忽略；
 *   5. 快照里该 PID 的映像名与记录不符 → 不是我们的进程（PID 复用），不 kill。
 *
 * 这里只做纯判断与登记，不 import electron / node:child_process，便于单测。
 */

export type OfficeProcessKind = "word" | "excel" | "powerpoint";

export interface TrackedOfficeProcess {
  readonly pid: number;
  readonly kind: OfficeProcessKind;
  /** 期望的进程映像名（如 POWERPNT.EXE），用于识别 PID 复用。 */
  readonly imageName: string;
  /** 记录时刻（epoch ms）。 */
  readonly trackedAt: number;
}

export interface ProcessSnapshotEntry {
  readonly pid: number;
  /** 进程映像名，比较时大小写不敏感（如 POWERPNT.EXE）。 */
  readonly imageName: string;
}

/** 进程快照；null = 查询失败，调用方不得据此 kill。 */
export type ProcessSnapshot = readonly ProcessSnapshotEntry[] | null;

/** PID 记录的保鲜期：超过后即使 PID 还在也不认作本应用进程（PID 可能已被复用）。 */
export const TRACKED_PROCESS_MAX_AGE_MS = 10 * 60_000;

export type OfficeCleanupSkipReason =
  | "no-tracking"
  | "stale-tracking"
  | "snapshot-unavailable"
  | "already-exited"
  | "not-ours";

export type OfficeCleanupDecision =
  | { readonly action: "kill"; readonly pid: number; readonly imageName: string }
  | { readonly action: "skip"; readonly reason: OfficeCleanupSkipReason };

export interface OfficeCleanupInput {
  /** 本应用记录的 Office 进程；null/undefined = 从未记录过。 */
  readonly tracked: TrackedOfficeProcess | null | undefined;
  /** 当前进程快照；null = 查询失败。 */
  readonly snapshot: ProcessSnapshot;
  /** 当前时间（epoch ms），由调用方注入便于测试。 */
  readonly now: number;
}

/** 纯函数：依据 PID 记录 + 进程快照判断「是否允许结束这个进程」。 */
export function decideOfficeProcessCleanup(input: OfficeCleanupInput): OfficeCleanupDecision {
  const { tracked, snapshot, now } = input;
  if (!tracked || !Number.isSafeInteger(tracked.pid) || tracked.pid <= 0) {
    return { action: "skip", reason: "no-tracking" };
  }
  if (
    !Number.isFinite(tracked.trackedAt) ||
    !Number.isFinite(now) ||
    now - tracked.trackedAt > TRACKED_PROCESS_MAX_AGE_MS
  ) {
    return { action: "skip", reason: "stale-tracking" };
  }
  if (snapshot === null) {
    return { action: "skip", reason: "snapshot-unavailable" };
  }
  const running = snapshot.find((entry) => entry.pid === tracked.pid);
  if (!running) {
    return { action: "skip", reason: "already-exited" };
  }
  if (running.imageName.toLowerCase() !== tracked.imageName.toLowerCase()) {
    return { action: "skip", reason: "not-ours" };
  }
  return { action: "kill", pid: tracked.pid, imageName: tracked.imageName };
}

export interface OfficeProcessTracker {
  /** 记录「本应用启动的 Office 进程」；同一 kind 只保留最近一次。 */
  track(kind: OfficeProcessKind, pid: number, imageName: string): TrackedOfficeProcess;
  /** 取出并清除记录：同一 PID 只允许被清理一次。 */
  take(kind: OfficeProcessKind): TrackedOfficeProcess | null;
  clear(): void;
}

/** PID 登记表：进程守卫唯一的归属依据。 */
export function createOfficeProcessTracker(now: () => number = () => Date.now()): OfficeProcessTracker {
  const tracked = new Map<OfficeProcessKind, TrackedOfficeProcess>();
  return {
    track(kind, pid, imageName) {
      const record: TrackedOfficeProcess = { pid, kind, imageName, trackedAt: now() };
      tracked.set(kind, record);
      return record;
    },
    take(kind) {
      const record = tracked.get(kind) ?? null;
      tracked.delete(kind);
      return record;
    },
    clear() {
      tracked.clear();
    },
  };
}
