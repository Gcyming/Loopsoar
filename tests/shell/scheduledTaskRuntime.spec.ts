/**
 * 定时任务调度纯逻辑：本机本地时间、下一次/上一次触发、持久化与删除。
 * 不启动真实 LLM / 会话，只验证调度器自己的边界。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createScheduledTaskRuntime,
  nextOccurrence,
  previousOccurrence,
} from "../../packages/shell/src/main/scheduledTaskRuntime.ts";
import { __resetHandlerRegistryForTests } from "../../packages/shell/src/main/trustedIpc.ts";
import type { ChatDeps } from "../../packages/shell/src/main/domains/chat.ts";

const dirs: string[] = [];
beforeEach(() => __resetHandlerRegistryForTests());
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-schedule-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const saturdayMorning = new Date(2026, 10, 21, 10, 0, 0, 0).getTime();

function fakeDeps(): ChatDeps {
  return {
    ipc: { handle: () => undefined },
    audit: () => undefined,
    chatService: {} as never,
    push: () => undefined,
  } as ChatDeps;
}

describe("调度时间计算（本地时间，无 UTC 漂移）", () => {
  it("每天 09:00：当天已过则落到明天同一本地时刻", () => {
    const next = nextOccurrence({ title: "t", prompt: "p", frequency: "daily", time: "09:00" }, saturdayMorning);
    const date = new Date(next!);
    expect(date.getDate()).toBe(22);
    expect(date.getHours()).toBe(9);
    expect(date.getMinutes()).toBe(0);
  });

  it("工作日跳过周六周日", () => {
    const next = new Date(nextOccurrence({ title: "t", prompt: "p", frequency: "weekdays", time: "09:00" }, saturdayMorning)!);
    expect(next.getDay()).toBe(1);
    expect(next.getDate()).toBe(23);
  });

  it("每周只命中选中的星期", () => {
    const next = new Date(
      nextOccurrence({ title: "t", prompt: "p", frequency: "weekly", time: "09:00", weekdays: [3] }, saturdayMorning)!,
    );
    expect(next.getDay()).toBe(3);
  });

  it("单次任务已过期返回 null；未来日期返回该时刻", () => {
    expect(nextOccurrence({ title: "t", prompt: "p", frequency: "once", time: "09:00", date: "2026-11-20" }, saturdayMorning)).toBeNull();
    const future = new Date(nextOccurrence({ title: "t", prompt: "p", frequency: "once", time: "09:00", date: "2026-11-22" }, saturdayMorning)!);
    expect(future.getDate()).toBe(22);
  });

  it("previousOccurrence 用于启动补跑：返回最近一次已到点的时间", () => {
    const previous = new Date(previousOccurrence({ title: "t", prompt: "p", frequency: "daily", time: "09:00" }, saturdayMorning)!);
    expect(previous.getDate()).toBe(21);
    expect(previous.getHours()).toBe(9);
  });
});

describe("后台执行", () => {
  it("runNow 会新建会话、调用 ChatService，并把结果写回任务与运行记录", async () => {
    const dataDir = tempDir();
    const appended: Array<{ sessionId: string; user: string; assistant: string }> = [];
    const browserControl: boolean[] = [];
    let current = "sess-user-visible";
    const deps = {
      ipc: { handle: () => undefined },
      audit: () => undefined,
      push: () => undefined,
      chatService: {
        stream: async () => ({ finalText: "定时任务完成" }),
      },
      sessions: {
        currentId: () => current,
        newSession: () => ({ sessionId: "sess-task-run" }),
        get: (id: string) => ({ id }),
        switchTo: (id: string) => {
          current = id;
        },
        renameSession: () => undefined,
        setBrowserControl: (_sessionId: string, enabled: boolean) => {
          browserControl.push(enabled);
        },
        append: (sessionId: string, user: string, assistant: string) => {
          appended.push({ sessionId, user, assistant });
        },
      },
      getModelInfo: () => ({ provider: "test", model: "fake" }),
      onTurnStarted: () => undefined,
      onTurnSettled: () => undefined,
    } as never;
    const runtime = createScheduledTaskRuntime({
      dataDir,
      chatDeps: deps,
      push: () => undefined,
      now: () => saturdayMorning,
    });
    const saved = runtime.save({ title: "后台跑", prompt: "请执行", frequency: "daily", time: "09:59" });
    expect(saved.ok).toBe(true);
    expect(runtime.runNow(saved.task!.id).accepted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const task = runtime.list().tasks.find((item) => item.id === saved.task!.id)!;
    expect(task.lastStatus).toBe("ok");
    expect(task.lastSessionId).toBe("sess-task-run");
    expect(current).toBe("sess-user-visible");
    expect(browserControl).toEqual([true]);
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ sessionId: "sess-task-run", user: "请执行", assistant: "定时任务完成" });
    expect(runtime.list().runs[0]).toMatchObject({ status: "ok", summary: "定时任务完成" });
  });
});

describe("任务持久化", () => {
  it("保存后落盘、列表可读，删除后文件同步", () => {
    const dataDir = tempDir();
    const runtime = createScheduledTaskRuntime({
      dataDir,
      chatDeps: fakeDeps(),
      push: () => undefined,
      now: () => saturdayMorning,
    });
    const saved = runtime.save({ title: "早报", prompt: "汇总新闻", frequency: "daily", time: "09:00" });
    expect(saved.ok).toBe(true);
    expect(saved.task?.nextRunAt).toBeTypeOf("number");
    expect(runtime.list().tasks).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, "schedules.json"), "utf8")).tasks).toHaveLength(1);

    const disabled = runtime.save({ ...saved.task!, enabled: false });
    expect(disabled.task?.nextRunAt).toBeNull();

    expect(runtime.remove(saved.task!.id)).toBe(true);
    expect(runtime.list().tasks).toHaveLength(0);
  });

  it("拒绝非法时间与 weekly 空星期", () => {
    const runtime = createScheduledTaskRuntime({ dataDir: tempDir(), chatDeps: fakeDeps(), push: () => undefined });
    expect(runtime.save({ title: "x", prompt: "y", frequency: "daily", time: "25:00" }).ok).toBe(false);
    expect(runtime.save({ title: "x", prompt: "y", frequency: "weekly", time: "09:00", weekdays: [] }).ok).toBe(false);
  });
});
