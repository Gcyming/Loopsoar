/**
 * 子代理任务记录（P1-5 第二步）：把委派任务落盘到 <dataDir>/subagents/<parent>/<task>.json。
 *
 * 只做“任务记录 + 回查”，不是完整任务树：记录 parentSessionId，便于从父会话
 * 找回它派出的任务；没有子会话分叉/恢复。放在独立目录而不是 sessions/，
 * 避免污染用户会话列表。每个任务一个文件，并行任务完成时不会互相覆盖。
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type SubagentTaskStatus = "running" | "done" | "failed" | "aborted";

/** 子会话可恢复的最小会话记录：只保存用户目标与子代理最终答复，不伪装成完整工具轨迹。 */
export interface SubagentHistoryEntry {
  role: "user" | "assistant";
  content: string;
}

export interface SubagentTaskRecord {
  id: string;
  parentSessionId: string;
  kind: "research" | "parallel" | "tree" | "child";
  goal: string;
  context?: string;
  /** 任务树中的父任务 id；根任务为空。 */
  parentTaskId?: string;
  /** 子会话历史（用户目标 + 子代理答复）；用于 fork/恢复上下文。 */
  history?: SubagentHistoryEntry[];
  status: SubagentTaskStatus;
  result?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface NewSubagentTask {
  parentSessionId: string;
  kind: "research" | "parallel" | "tree" | "child";
  goal: string;
  context?: string;
  parentTaskId?: string;
  history?: SubagentHistoryEntry[];
}

const MAX_GOAL_CHARS = 4_000;
const MAX_RESULT_CHARS = 12_000;
const MAX_TASKS_PER_SESSION = 200;
const MAX_HISTORY_ENTRIES = 20;
const MAX_HISTORY_CHARS = 24_000;

/** 历史只保留最近若干轮，且总字符有上限，避免恢复上下文反过来撑爆任务文件。 */
function clampHistory(history?: SubagentHistoryEntry[]): SubagentHistoryEntry[] | undefined {
  if (!history?.length) return undefined;
  const entries: SubagentHistoryEntry[] = [];
  let total = 0;
  for (let i = history.length - 1; i >= 0 && entries.length < MAX_HISTORY_ENTRIES; i--) {
    const entry = history[i];
    const content = entry.content.trim();
    if (!content) continue;
    const remaining = MAX_HISTORY_CHARS - total;
    if (remaining <= 0) break;
    const clipped = content.slice(0, remaining);
    entries.unshift({ role: entry.role, content: clipped });
    total += clipped.length;
  }
  return entries.length > 0 ? entries : undefined;
}

function safeSegment(value: string): string {
  const clean = value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  return clean || "_default";
}

export class SubagentTaskStore {
  constructor(private root: string) {}

  private dirFor(parentSessionId: string): string {
    return path.join(this.root, safeSegment(parentSessionId || "_default"));
  }

  private fileFor(parentSessionId: string, id: string): string {
    return path.join(this.dirFor(parentSessionId), `${safeSegment(id)}.json`);
  }

  private write(record: SubagentTaskRecord): void {
    const dir = this.dirFor(record.parentSessionId);
    fs.mkdirSync(dir, { recursive: true });
    const file = this.fileFor(record.parentSessionId, record.id);
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(record, null, 2), "utf8");
    fs.renameSync(temp, file);
  }

  create(input: NewSubagentTask): SubagentTaskRecord {
    const history = clampHistory(input.history);
    const record: SubagentTaskRecord = {
      id: randomUUID(),
      parentSessionId: input.parentSessionId || "_default",
      kind: input.kind,
      goal: input.goal.trim().slice(0, MAX_GOAL_CHARS),
      ...(input.context?.trim() ? { context: input.context.trim().slice(0, MAX_GOAL_CHARS) } : {}),
      ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      ...(history ? { history } : {}),
      status: "running",
      startedAt: Date.now(),
    };
    this.write(record);
    return record;
  }

  finish(
    parentSessionId: string,
    id: string,
    status: SubagentTaskStatus,
    result?: string,
    error?: string,
    history?: SubagentHistoryEntry[],
  ): SubagentTaskRecord | null {
    const record = this.read(parentSessionId, id);
    if (!record) return null;
    record.status = status;
    record.finishedAt = Date.now();
    if (result !== undefined) record.result = result.slice(0, MAX_RESULT_CHARS);
    if (error) record.error = error.slice(0, 4_000);
    const clamped = clampHistory(history);
    if (clamped) record.history = clamped;
    this.write(record);
    return record;
  }

  read(parentSessionId: string, id: string): SubagentTaskRecord | null {
    try {
      const raw = fs.readFileSync(this.fileFor(parentSessionId, id), "utf8");
      const parsed = JSON.parse(raw) as SubagentTaskRecord;
      return parsed && typeof parsed.id === "string" ? parsed : null;
    } catch {
      return null;
    }
  }

  list(parentSessionId: string, limit = 50): SubagentTaskRecord[] {
    const dir = this.dirFor(parentSessionId);
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
    const records: SubagentTaskRecord[] = [];
    for (const name of names) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as SubagentTaskRecord;
        if (parsed && typeof parsed.id === "string") records.push(parsed);
      } catch {
        // 坏文件跳过，不让一条损坏记录拖垮列表。
      }
    }
    return records
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, Math.min(Math.max(1, limit), MAX_TASKS_PER_SESSION));
  }
}
