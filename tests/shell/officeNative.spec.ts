import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  TRACKED_OFFICE_PID_MARKER,
  cleanupTrackedOfficeProcess,
  officeKindForFile,
  parseTrackedOfficePid,
  runOfficeExport,
} from "../../packages/shell/src/main/officeNative.ts";
import {
  TRACKED_PROCESS_MAX_AGE_MS,
  createOfficeProcessTracker,
  decideOfficeProcessCleanup,
  type ProcessSnapshotEntry,
} from "../../packages/shell/src/main/officeProcessGuard.ts";

describe("Office 原生导出：格式路由", () => {
  it("把微软 Office 格式分派到对应应用", () => {
    expect(officeKindForFile("C:/课程/第五章.ppt")).toBe("powerpoint");
    expect(officeKindForFile("C:/课程/第五章.PPTX")).toBe("powerpoint");
    expect(officeKindForFile("C:/实验/报告.doc")).toBe("word");
    expect(officeKindForFile("C:/实验/报告.docx")).toBe("word");
    expect(officeKindForFile("C:/实验/数据.xls")).toBe("excel");
    expect(officeKindForFile("C:/实验/数据.xlsx")).toBe("excel");
  });

  it("OpenDocument/PDF/未知格式不走原生 Office（交给 LibreOffice 或直接预览）", () => {
    expect(officeKindForFile("C:/课程/讲义.odp")).toBeNull();
    expect(officeKindForFile("C:/课程/讲义.odt")).toBeNull();
    expect(officeKindForFile("C:/课程/讲义.pdf")).toBeNull();
    expect(officeKindForFile("C:/课程/readme.txt")).toBeNull();
  });
});

const POWERPOINT_IMAGE = "POWERPNT.EXE";

interface FakeChild extends EventEmitter {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
}

/** runOfficeExport 的假子进程：stdout/stderr 用 EventEmitter，便于同步注入脚本输出。 */
function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 9000;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function asChildProcess(child: FakeChild): ChildProcess {
  return child as unknown as ChildProcess;
}

describe("Office 进程归属守卫：是否可 kill 是纯函数", () => {
  const tracked = { pid: 4242, kind: "powerpoint" as const, imageName: POWERPOINT_IMAGE, trackedAt: 1_000 };
  const running: ProcessSnapshotEntry[] = [{ pid: 4242, imageName: POWERPOINT_IMAGE }];
  const now = 2_000;

  it("属于本应用且仍在运行的 PID → kill", () => {
    expect(decideOfficeProcessCleanup({ tracked, snapshot: running, now })).toEqual({
      action: "kill",
      pid: 4242,
      imageName: POWERPOINT_IMAGE,
    });
  });

  it("没有 PID 记录 → 不 kill（无法证明归属）", () => {
    expect(decideOfficeProcessCleanup({ tracked: null, snapshot: running, now })).toEqual({
      action: "skip",
      reason: "no-tracking",
    });
  });

  it("进程列表查询失败 → 不 kill", () => {
    expect(decideOfficeProcessCleanup({ tracked, snapshot: null, now })).toEqual({
      action: "skip",
      reason: "snapshot-unavailable",
    });
  });

  it("快照里该 PID 不是我们的映像（PID 复用）→ 不 kill", () => {
    expect(
      decideOfficeProcessCleanup({ tracked, snapshot: [{ pid: 4242, imageName: "notepad.exe" }], now }),
    ).toEqual({ action: "skip", reason: "not-ours" });
  });

  it("记录的 PID 已自然退出 → 忽略", () => {
    expect(
      decideOfficeProcessCleanup({ tracked, snapshot: [{ pid: 9999, imageName: POWERPOINT_IMAGE }], now }),
    ).toEqual({ action: "skip", reason: "already-exited" });
  });

  it("记录过期 → 不 kill（PID 可能已被复用）", () => {
    expect(
      decideOfficeProcessCleanup({
        tracked,
        snapshot: running,
        now: tracked.trackedAt + TRACKED_PROCESS_MAX_AGE_MS + 1,
      }),
    ).toEqual({ action: "skip", reason: "stale-tracking" });
  });
});

describe("cleanupTrackedOfficeProcess：只按记录的 PID 清理", () => {
  it("属于本应用的 PID 仍在运行 → 只 kill 该 PID", () => {
    const tracker = createOfficeProcessTracker(() => 1_000);
    tracker.track("powerpoint", 4242, POWERPOINT_IMAGE);
    const killed: number[] = [];
    const decision = cleanupTrackedOfficeProcess("powerpoint", {
      tracker,
      listProcesses: () => [{ pid: 4242, imageName: POWERPOINT_IMAGE }],
      killProcess: (pid) => killed.push(pid),
      now: () => 2_000,
    });
    expect(decision).toEqual({ action: "kill", pid: 4242, imageName: POWERPOINT_IMAGE });
    expect(killed).toEqual([4242]);
  });

  it("没有 PID 记录 → 不 kill（系统里的 PowerPoint 是用户的）", () => {
    const tracker = createOfficeProcessTracker(() => 1_000);
    const killed: number[] = [];
    const decision = cleanupTrackedOfficeProcess("powerpoint", {
      tracker,
      // 系统里确实有 PowerPoint，但不是本应用启动的：没有记录就绝不按映像名 kill。
      listProcesses: () => [{ pid: 777, imageName: POWERPOINT_IMAGE }],
      killProcess: (pid) => killed.push(pid),
      now: () => 2_000,
    });
    expect(decision).toEqual({ action: "skip", reason: "no-tracking" });
    expect(killed).toEqual([]);
  });

  it("进程列表查询失败 → 不 kill", () => {
    const tracker = createOfficeProcessTracker(() => 1_000);
    tracker.track("powerpoint", 4242, POWERPOINT_IMAGE);
    const killed: number[] = [];
    const decision = cleanupTrackedOfficeProcess("powerpoint", {
      tracker,
      listProcesses: () => null,
      killProcess: (pid) => killed.push(pid),
      now: () => 2_000,
    });
    expect(decision).toEqual({ action: "skip", reason: "snapshot-unavailable" });
    expect(killed).toEqual([]);
  });

  it("记录的进程已退出 → 不 kill", () => {
    const tracker = createOfficeProcessTracker(() => 1_000);
    tracker.track("powerpoint", 4242, POWERPOINT_IMAGE);
    const killed: number[] = [];
    const decision = cleanupTrackedOfficeProcess("powerpoint", {
      tracker,
      listProcesses: () => [],
      killProcess: (pid) => killed.push(pid),
      now: () => 2_000,
    });
    expect(decision).toEqual({ action: "skip", reason: "already-exited" });
    expect(killed).toEqual([]);
  });
});

describe("runOfficeExport：PowerPoint 残留清理只认脚本报告的 PID", () => {
  it("脚本报告了本应用启动的 PID → 导出结束后只结束该 PID", async () => {
    const child = fakeChild();
    const tracker = createOfficeProcessTracker(() => 1_000);
    const killed: number[] = [];
    const pending = runOfficeExport("C:/slides/in.pptx", "C:/slides/out.pdf", "powerpoint", 5_000, {
      spawnProcess: () => asChildProcess(child),
      listProcesses: () => [{ pid: 4242, imageName: POWERPOINT_IMAGE }],
      killProcess: (pid) => killed.push(pid),
      tracker,
      now: () => 2_000,
    });
    const failure = expect(pending).rejects.toThrow(/Office 导出 PDF 失败/);
    child.stdout.emit("data", Buffer.from(`${TRACKED_OFFICE_PID_MARKER}4242\nOK\n`));
    child.emit("close", 1);
    await failure;
    expect(killed).toEqual([4242]);
  });

  it("脚本没有报告 PID → 绝不按映像名 kill 用户的 PowerPoint", async () => {
    const child = fakeChild();
    const tracker = createOfficeProcessTracker(() => 1_000);
    const killed: number[] = [];
    const pending = runOfficeExport("C:/slides/in.pptx", "C:/slides/out.pdf", "powerpoint", 5_000, {
      spawnProcess: () => asChildProcess(child),
      listProcesses: () => [{ pid: 777, imageName: POWERPOINT_IMAGE }],
      killProcess: (pid) => killed.push(pid),
      tracker,
      now: () => 2_000,
    });
    const failure = expect(pending).rejects.toThrow(/Office 导出 PDF 失败/);
    child.emit("close", 1);
    await failure;
    expect(killed).toEqual([]);
  });

  it("进程列表查询失败 → 不 kill", async () => {
    const child = fakeChild();
    const tracker = createOfficeProcessTracker(() => 1_000);
    const killed: number[] = [];
    const pending = runOfficeExport("C:/slides/in.pptx", "C:/slides/out.pdf", "powerpoint", 5_000, {
      spawnProcess: () => asChildProcess(child),
      listProcesses: () => null,
      killProcess: (pid) => killed.push(pid),
      tracker,
      now: () => 2_000,
    });
    const failure = expect(pending).rejects.toThrow(/Office 导出 PDF 失败/);
    child.stdout.emit("data", Buffer.from(`${TRACKED_OFFICE_PID_MARKER}4242\n`));
    child.emit("close", 1);
    await failure;
    expect(killed).toEqual([]);
  });

  it("PID 标记解析：命中返回 PID，缺失/非法返回 null", () => {
    expect(parseTrackedOfficePid(`${TRACKED_OFFICE_PID_MARKER}4242\nOK`)).toBe(4242);
    expect(parseTrackedOfficePid("OK")).toBeNull();
    expect(parseTrackedOfficePid(`${TRACKED_OFFICE_PID_MARKER}0`)).toBeNull();
  });
});
