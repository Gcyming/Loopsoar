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

export interface SubagentTaskRecord {
  id: string;
  parentSessionId: string;
  kind: "research" | "parallel";
  goal: string;
  context?: string;
  status: SubagentTaskStatus;
  result?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface NewSubagentTask {
  parentSessionId: string;
  kind: "research" | "parallel";
  goal: string;
  context?: string;
}

const MAX_GOAL_CHARS = 4_000;
const MAX_RESULT_CHARS = 12_000;
const MAX_TASKS_PER_SESSION = 200;

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
    const record: SubagentTaskRecord = {
      id: randomUUID(),
      parentSessionId: input.parentSessionId || "_default",
      kind: input.kind,
      goal: input.goal.trim().slice(0, MAX_GOAL_CHARS),
      ...(input.context?.trim() ? { context: input.context.trim().slice(0, MAX_GOAL_CHARS) } : {}),
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
  ): SubagentTaskRecord | null {
    const record = this.read(parentSessionId, id);
    if (!record) return null;
    record.status = status;
    record.finishedAt = Date.now();
    if (result !== undefined) record.result = result.slice(0, MAX_RESULT_CHARS);
    if (error) record.error = error.slice(0, 4_000);
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
