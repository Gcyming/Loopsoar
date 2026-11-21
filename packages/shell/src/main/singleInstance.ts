/**
 * 单实例守卫：托盘后台驻留后，用户再次双击图标不应该启动第二套调度器/托盘/浏览器栈。
 *
 * 为什么需要 PID 锁兜底：Chromium 的 ProcessSingleton 在部分环境（受限令牌、杀软、
 * 数据目录权限异常）会报 "Lock file can not be created: 拒绝访问"，此时
 * requestSingleInstanceLock() 返回 false —— 但它并不是「已有实例」，直接 quit 会让应用
 * 永远打不开。这里用 <userData>/instance.lock 做第二道判断，并且**锁文件不可写时不再阻断启动**：
 *   · 抢到 PID 锁 → 正常启动；
 *   · 抢不到且 PID 仍存活 → 真的是第二个实例，退出；
 *   · 抢不到但 PID 已死 → 清理残留锁后重试；
 *   · 锁文件因权限/IO 不可写 → 记录警告并继续启动（宁可失去单实例保证，也不能打不开）。
 */
import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";

export interface SingleInstanceOptions {
  /** 数据目录（PID 锁落在这里；不存在会尝试创建）。 */
  dataDir: string;
  log?: (message: string) => void;
  /** 第二实例退出（默认 process.exit；测试注入避免杀掉测试进程）。 */
  exit?: (code: number) => void;
}

type PidLockResult =
  | { kind: "acquired"; fd: number }
  | { kind: "locked" }
  | { kind: "unavailable"; error: string };

function acquirePidLock(lockFile: string, log: (message: string) => void): PidLockResult {
  const tryOpen = (): PidLockResult => {
    try {
      fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    } catch (err) {
      // 目录不可创建（路径被普通文件占用/无权限）：锁不可用，但不能当成「已有实例」。
      return { kind: "unavailable", error: err instanceof Error ? err.message : String(err) };
    }
    try {
      const fd = fs.openSync(lockFile, "wx");
      fs.writeFileSync(lockFile, String(process.pid));
      return { kind: "acquired", fd };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return { kind: "locked" };
      return { kind: "unavailable", error: err instanceof Error ? err.message : String(err) };
    }
  };
  const first = tryOpen();
  if (first.kind !== "locked") return first;

  // 已有 PID 锁：判断持有者是否还活着（死进程的残留锁要清理）。
  let holder = 0;
  try {
    holder = Number(fs.readFileSync(lockFile, "utf8").trim());
  } catch {
    // 读不到按残留处理
  }
  let alive = false;
  if (Number.isFinite(holder) && holder > 0) {
    try {
      process.kill(holder, 0);
      alive = true;
    } catch {
      alive = false;
    }
  }
  if (alive) return { kind: "locked" };
  try {
    fs.rmSync(lockFile, { force: true });
  } catch {
    return { kind: "unavailable", error: "残留锁无法清理" };
  }
  const second = tryOpen();
  if (second.kind === "locked") {
    log("[Loopsoar] 单实例锁刚被其他进程抢占，本次退出");
    return { kind: "locked" };
  }
  return second;
}

export function ensureSingleInstance(
  app: App,
  onSecond: (argv: string[]) => void,
  options: SingleInstanceOptions,
): boolean {
  const log = options.log ?? ((message: string) => console.warn(message));
  const lockFile = path.join(options.dataDir, "instance.lock");
  const pidLock = acquirePidLock(lockFile, log);
  if (pidLock.kind === "locked") {
    log("[Loopsoar] 已有实例在运行，退出本次启动");
    app.quit();
    const exit = options.exit ?? ((code: number) => setTimeout(() => process.exit(code), 0).unref?.());
    exit(0);
    return false;
  }
  if (pidLock.kind === "unavailable") {
    // 权限/杀软拦截：不阻断启动；单实例由 Chromium 锁兜底（它也可能同样失败，那只剩窗口行为）。
    log(`[Loopsoar] 单实例 PID 锁不可用（继续启动）：${pidLock.error}`);
  } else {
    const release = (): void => {
      try {
        fs.closeSync(pidLock.fd);
        fs.rmSync(lockFile, { force: true });
      } catch {
        // 退出阶段忽略
      }
    };
    process.on("exit", release);
    app.on("will-quit", release);
  }

  let chromiumLock = false;
  try {
    chromiumLock = app.requestSingleInstanceLock();
  } catch {
    chromiumLock = false;
  }
  if (chromiumLock) {
    // 第二实例可能是被系统默认浏览器启动的：argv 里带着 http(s) URL，必须转交给主实例。
    app.on("second-instance", (_event, argv) => onSecond(argv));
  } else {
    // Chromium 锁不可用：如果 PID 锁已生效，单实例仍成立，只是失去「聚焦已有窗口」。
    log("[Loopsoar] Chromium 单实例锁不可用，已降级（不影响启动）");
  }
  return true;
}
