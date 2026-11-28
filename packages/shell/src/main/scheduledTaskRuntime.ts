/**
 * 定时任务运行时（自动巡航）。
 *
 * 设计要点：
 *   · 调度器在主进程而不是渲染层：窗口隐藏到托盘、页面重载、甚至 UI 卡住都不影响触发。
 *   · 每次触发创建**独立新会话**（不污染当前对话），完成后把结果会话 id 写回任务；
 *     用户点「打开结果」即可看完整过程。
 *   · 落盘采用原子写；启动时重算下一次触发并支持 2 小时补跑（单次任务 24 小时），
 *     避免电脑休眠/重启后整天不跑。
 *   · 时间一律按本机本地时间解释，不存 UTC，避免 DST/时区迁移后漂移。
 */
import fs from "node:fs";
import path from "node:path";
import {
  ScheduleInputSchema,
  type ScheduleInput,
  type ScheduleRun,
  type ScheduledTask,
} from "loopsoar-contracts/schemas";
import type { ChatDeps } from "./domains/chat.js";
import { startStream } from "./domains/chat.js";
import { handleTrusted } from "./trustedIpc.js";
import type { SessionStore } from "./sessionStore.js";

const FILE_VERSION = 1;
const TICK_MS = 20_000;
/** 定时任务补跑窗口：应用在触发时刻没运行，恢复后仍在窗口内则补一次。 */
const CATCHUP_MS = 2 * 60 * 60 * 1000;
const ONCE_CATCHUP_MS = 24 * 60 * 60 * 1000;
const MAX_RUNS = 40;
const MAX_TASKS = 100;

interface StoreFile {
  version: number;
  tasks: ScheduledTask[];
  runs: ScheduleRun[];
}

export interface ScheduledTaskRuntimeOptions {
  dataDir: string;
  chatDeps: ChatDeps;
  push: (event: string, payload: unknown) => void;
  now?: () => number;
  /** 可选桌面通知（index 注入 Electron Notification；测试不注入）。 */
  notify?: (title: string, body: string, sessionId?: string) => void;
}

export interface ScheduledTaskRuntime {
  start(): void;
  stop(): void;
  tick(): void;
  list(): { tasks: ScheduledTask[]; runs: ScheduleRun[]; timezoneOffsetMinutes: number };
  save(input: ScheduleInput): { ok: boolean; task?: ScheduledTask; error?: string };
  remove(id: string): boolean;
  runNow(id: string): { accepted: boolean; runId?: string; sessionId?: string; error?: string };
}

function atLocal(day: Date, time: string): number {
  const [hour, minute] = time.split(":").map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute, 0, 0).getTime();
}

function isoWeekday(date: Date): number {
  const day = date.getDay();
  return day === 0 ? 7 : day;
}

function parseDate(date: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(year, month - 1, day);
  if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) return null;
  return { year, month, day };
}

function candidateOn(day: Date, task: Pick<ScheduleInput, "time">): number {
  return atLocal(day, task.time);
}

/** 从 from 之后（不含）找未来一次触发；找不到返回 null（单次任务已过期）。 */
export function nextOccurrence(task: ScheduleInput, from: number): number | null {
  const start = new Date(from);
  if (task.frequency === "once") {
    if (!task.date) return null;
    const parsed = parseDate(task.date);
    if (!parsed) return null;
    const at = new Date(parsed.year, parsed.month - 1, parsed.day).getTime();
    const candidate = atLocal(new Date(at), task.time);
    return candidate > from ? candidate : null;
  }
  if (task.frequency === "daily") {
    const today = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    let candidate = candidateOn(today, task);
    if (candidate <= from) {
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      candidate = candidateOn(tomorrow, task);
    }
    return candidate;
  }
  if (task.frequency === "weekdays") {
    for (let offset = 0; offset <= 8; offset += 1) {
      const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset);
      const weekday = isoWeekday(day);
      if (weekday > 5) continue;
      const candidate = candidateOn(day, task);
      if (candidate > from) return candidate;
    }
    return null;
  }
  const days = new Set(task.weekdays ?? []);
  for (let offset = 0; offset <= 14; offset += 1) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset);
    if (!days.has(isoWeekday(day))) continue;
    const candidate = candidateOn(day, task);
    if (candidate > from) return candidate;
  }
  return null;
}

/** 从 from 之前（含）找最近一次触发；用于启动补跑判断。 */
export function previousOccurrence(task: ScheduleInput, from: number): number | null {
  const start = new Date(from);
  if (task.frequency === "once") {
    if (!task.date) return null;
    const parsed = parseDate(task.date);
    if (!parsed) return null;
    const at = atLocal(new Date(parsed.year, parsed.month - 1, parsed.day), task.time);
    return at <= from ? at : null;
  }
  if (task.frequency === "daily") {
    const today = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    let candidate = candidateOn(today, task);
    if (candidate > from) {
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      candidate = candidateOn(yesterday, task);
    }
    return candidate;
  }
  if (task.frequency === "weekdays") {
    for (let offset = 0; offset <= 8; offset += 1) {
      const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() - offset);
      if (isoWeekday(day) > 5) continue;
      const candidate = candidateOn(day, task);
      if (candidate <= from) return candidate;
    }
    return null;
  }
  const days = new Set(task.weekdays ?? []);
  for (let offset = 0; offset <= 14; offset += 1) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() - offset);
    if (!days.has(isoWeekday(day))) continue;
    const candidate = candidateOn(day, task);
    if (candidate <= from) return candidate;
  }
  return null;
}

function summarize(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 500 ? `${clean.slice(0, 500)}…` : clean;
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function createScheduledTaskRuntime(options: ScheduledTaskRuntimeOptions): ScheduledTaskRuntime {
  const file = path.join(options.dataDir, "schedules.json");
  const now = options.now ?? (() => Date.now());
  const running = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let started = false;
  let store: StoreFile = { version: FILE_VERSION, tasks: [], runs: [] };

  function load(): void {
    try {
      if (!fs.existsSync(file)) return;
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<StoreFile>;
      store = {
        version: FILE_VERSION,
        tasks: Array.isArray(raw.tasks)
          ? raw.tasks.filter((task): task is ScheduledTask => Boolean(task) && typeof task === "object" && typeof (task as ScheduledTask).id === "string")
          : [],
        runs: Array.isArray(raw.runs)
          ? raw.runs.filter((run): run is ScheduleRun => Boolean(run) && typeof run === "object" && typeof (run as ScheduleRun).id === "string")
          : [],
      };
    } catch {
      // 损坏文件不阻塞应用启动：保留空列表，下一次保存会覆盖。
      store = { version: FILE_VERSION, tasks: [], runs: [] };
    }
    for (const task of store.tasks) {
      // 上次进程在任务执行中退出：不能一直显示「运行中」，交给下一次触发/用户重试。
      if (task.lastStatus === "running") {
        task.lastStatus = "error";
        task.lastSummary = "上次运行在应用退出时中断";
      }
      if (!task.enabled) {
        task.nextRunAt = null;
        continue;
      }
      if (task.frequency === "once") {
        if (task.lastRunAt) {
          task.enabled = false;
          task.nextRunAt = null;
        } else {
          const parsed = task.date ? parseDate(task.date) : null;
          task.nextRunAt = parsed ? atLocal(new Date(parsed.year, parsed.month - 1, parsed.day), task.time) : null;
        }
        continue;
      }
      const previous = previousOccurrence(task, now());
      const canCatchUp = previous !== null && previous > (task.lastRunAt ?? 0) && now() - previous <= CATCHUP_MS;
      task.nextRunAt = canCatchUp ? previous : nextOccurrence(task, now());
    }
    persist(false);
  }

  function persist(notify = true): void {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
      fs.renameSync(tmp, file);
    } catch (err) {
      console.warn("[Loopsoar] 定时任务保存失败：", err instanceof Error ? err.message : String(err));
    }
    if (notify) options.push("schedule:updated", {});
  }

  function list() {
    return {
      tasks: store.tasks.map((task) => ({ ...task })),
      runs: store.runs.slice().sort((a, b) => b.startedAt - a.startedAt),
      timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
    };
  }

  function save(input: ScheduleInput): { ok: boolean; task?: ScheduledTask; error?: string } {
    const parsed = ScheduleInputSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues.map((issue) => issue.message).join("；") };
    }
    const value = parsed.data;
    if (!value.id && store.tasks.length >= MAX_TASKS) return { ok: false, error: `最多 ${MAX_TASKS} 个定时任务` };
    const existing = value.id ? store.tasks.find((task) => task.id === value.id) : undefined;
    if (value.id && !existing) return { ok: false, error: "任务不存在" };
    const timestamp = now();
    const id = existing?.id ?? value.id ?? newId("task");
    if (!existing && store.tasks.some((task) => task.id === id)) return { ok: false, error: "任务 id 已被占用" };
    const task: ScheduledTask = {
      ...(existing ?? {}),
      id,
      title: value.title.trim(),
      prompt: value.prompt.trim(),
      frequency: value.frequency,
      time: value.time,
      ...(value.date ? { date: value.date } : {}),
      ...(value.weekdays?.length ? { weekdays: value.weekdays.slice().sort((a, b) => a - b) } : {}),
      enabled: value.enabled !== false,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      runCount: existing?.runCount ?? 0,
    };
    // 单次任务已完成过：只有改动了日期/时间才视为重新排期，否则保存后仍应保持禁用，
    // 不能被旧时间重新触发一次。
    const onceRescheduled =
      task.frequency === "once" &&
      Boolean(existing?.lastRunAt) &&
      (existing?.date !== value.date || existing?.time !== value.time);
    if (onceRescheduled) {
      task.lastRunAt = null;
      delete task.lastStatus;
      delete task.lastSummary;
    }
    if (task.enabled) {
      if (task.frequency === "once") {
        if (task.lastRunAt) {
          task.enabled = false;
          task.nextRunAt = null;
        } else {
          const parsedDate = task.date ? parseDate(task.date) : null;
          task.nextRunAt = parsedDate ? atLocal(new Date(parsedDate.year, parsedDate.month - 1, parsedDate.day), task.time) : null;
        }
      } else {
        task.nextRunAt = nextOccurrence(task, timestamp);
      }
    } else {
      task.nextRunAt = null;
    }
    store.tasks = existing
      ? store.tasks.map((item) => (item.id === id ? task : item))
      : [...store.tasks, task];
    persist();
    return { ok: true, task: { ...task } };
  }

  function remove(id: string): boolean {
    const before = store.tasks.length;
    store.tasks = store.tasks.filter((task) => task.id !== id);
    store.runs = store.runs.filter((run) => run.taskId !== id);
    if (store.tasks.length === before) return false;
    running.delete(id);
    persist();
    return true;
  }

  function finish(task: ScheduledTask, run: ScheduleRun, status: "ok" | "error", detail: string): void {
    const finishedAt = now();
    const nextRun = store.runs.find((item) => item.id === run.id);
    if (nextRun) {
      nextRun.status = status;
      nextRun.finishedAt = finishedAt;
      nextRun.summary = summarize(detail);
      if (status === "error") nextRun.error = summarize(detail);
    }
    const target = store.tasks.find((item) => item.id === task.id);
    if (target) {
      target.lastRunAt = finishedAt;
      target.lastStatus = status;
      target.lastSummary = summarize(detail);
      if (run.sessionId) target.lastSessionId = run.sessionId;
      target.runCount = (target.runCount ?? 0) + 1;
      target.updatedAt = finishedAt;
      if (target.frequency === "once") {
        target.enabled = false;
        target.nextRunAt = null;
      } else if (target.enabled) {
        target.nextRunAt = nextOccurrence(target, finishedAt);
      }
    }
    store.runs = store.runs.slice(0, MAX_RUNS);
    running.delete(task.id);
    persist();
    options.notify?.(
      status === "ok" ? `定时任务完成 · ${task.title}` : `定时任务失败 · ${task.title}`,
      summarize(detail).slice(0, 140),
      run.sessionId,
    );
  }

  function execute(task: ScheduledTask, trigger: "schedule" | "manual" | "catchup"): { accepted: boolean; runId?: string; sessionId?: string; error?: string } {
    if (running.has(task.id)) return { accepted: false, error: "该任务正在运行" };
    const sessions = options.chatDeps.sessions;
    if (!sessions) return { accepted: false, error: "会话存储未装配，无法运行定时任务" };
    const previousCurrent = sessions.currentId();
    const session = sessions.newSession(options.chatDeps.getActiveWorkspaceId?.() ?? null);
    if (previousCurrent && sessions.get(previousCurrent)) sessions.switchTo(previousCurrent);
    const sessionId = session.sessionId;
    // 定时任务通常要查资料/打开网页：任务即用户对本次无人值守运行的显式授权，
    // 因此为结果会话打开浏览器控制；敏感步骤仍由 autoConfirm 拒绝。
    sessions.setBrowserControl?.(sessionId, true);
    sessions.renameSession(sessionId, `定时 · ${task.title}`.slice(0, 40));
    const run: ScheduleRun = {
      id: newId("run"),
      taskId: task.id,
      taskTitle: task.title,
      startedAt: now(),
      status: "running",
      sessionId,
      trigger,
    };
    store.runs = [run, ...store.runs].slice(0, MAX_RUNS);
    running.add(task.id);
    const current = store.tasks.find((item) => item.id === task.id);
    if (current) {
      current.lastStatus = "running";
      current.updatedAt = run.startedAt;
    }
    persist();
    let settled = false;
    const settle = (status: "ok" | "error", detail: string): void => {
      if (settled) return;
      settled = true;
      finish(task, run, status, detail);
    };
    try {
      startStream(
        options.chatDeps,
        { message: task.prompt, sessionId, mode: "build", autonomous: true },
        {
          onDone: (result) => settle("ok", result.finalText || "（无正文）"),
          onError: (result) => settle("error", result.error),
        },
      );
    } catch (err) {
      settle("error", err instanceof Error ? err.message : String(err));
    }
    return { accepted: true, runId: run.id, sessionId };
  }

  function tick(): void {
    const timestamp = now();
    let changed = false;
    for (const task of [...store.tasks]) {
      if (!task.enabled || !task.nextRunAt || running.has(task.id)) continue;
      if (task.nextRunAt > timestamp) continue;
      const lateBy = timestamp - task.nextRunAt;
      const grace = task.frequency === "once" ? ONCE_CATCHUP_MS : CATCHUP_MS;
      if (lateBy > grace) {
        task.lastStatus = "missed";
        task.lastSummary = "错过触发时间（应用当时未运行）";
        task.updatedAt = timestamp;
        task.nextRunAt = task.frequency === "once" ? null : nextOccurrence(task, timestamp);
        if (task.frequency === "once") task.enabled = false;
        changed = true;
        continue;
      }
      execute(task, lateBy > 60_000 ? "catchup" : "schedule");
    }
    if (changed) persist();
  }

  function runNow(id: string): { accepted: boolean; runId?: string; sessionId?: string; error?: string } {
    const task = store.tasks.find((item) => item.id === id);
    if (!task) return { accepted: false, error: "任务不存在" };
    return execute(task, "manual");
  }

  load();

  handleTrusted(options.chatDeps, "schedule:list", () => list());
  handleTrusted(options.chatDeps, "schedule:save", (payload) => {
    const parsed = ScheduleInputSchema.safeParse(payload);
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "参数不合法" };
    return save(parsed.data);
  });
  handleTrusted(options.chatDeps, "schedule:delete", (payload) => {
    const id = typeof (payload as { id?: unknown })?.id === "string" ? (payload as { id: string }).id : "";
    return { ok: remove(id) };
  });
  handleTrusted(options.chatDeps, "schedule:run", (payload) => {
    const id = typeof (payload as { id?: unknown })?.id === "string" ? (payload as { id: string }).id : "";
    return runNow(id);
  });

  return {
    start() {
      if (started) return;
      started = true;
      // 首次 tick 延后 2 秒：避免应用还在装配时就和窗口/浏览器抢资源。
      const kick = setTimeout(() => tick(), 2_000);
      kick.unref?.();
      timer = setInterval(() => tick(), TICK_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      started = false;
    },
    tick,
    list,
    save,
    remove,
    runNow,
  };
}

/** 给 UI/测试用的任务 id 生成器（不暴露内部运行时）。 */
export function newScheduledTaskId(): string {
  return newId("task");
}

export type { SessionStore };
