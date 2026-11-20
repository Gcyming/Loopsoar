/**
 * 「浏览器任务分支」状态机（从 index.ts 的启动闭包里拆出）。
 *
 * 背景：一个会话第一次让 Agent 动手时，它才**升格**为任务；升格不能立刻做，
 * 因为本轮回复还没落库——必须等回合结束，把「操作前」的历史留给原会话、
 * 把「本轮用户消息 + 回复」搬到新分支。这段时间里进程可能崩溃，
 * 所以要有一条落盘记录（pending-task-forks.json）供下次启动补完。
 *
 * 为什么必须独立成类：这套状态有 4 份（待分支集合、保留条数、落盘记录、回合起始快照）
 * 且被 3 个入口读写（浏览器动作、回合开始/结束、启动恢复）。留在 boot 闭包里时，
 * 这 4 份状态的所有权无人能说清，恢复逻辑和转发逻辑相隔 300 行，改动极易漏一条分支。
 *
 * 不变量（并发/崩溃都成立）：
 *   ① 任何时刻「任务身份」只属于一个会话：要么原会话，要么分支；
 *   ② 分支点永远 ≤ 本轮开始前的消息数（fork 不会把操作过程复制两份）；
 *   ③ 落盘记录与内存状态同源：每次改变都先改内存再整体落盘（幂等，可重放）；
 *   ④ 没有可搬内容的孤儿记录在恢复时被清掉，不留「任务但没有分支」的状态。
 */
import fs from "node:fs";
import type { PersistedBrowserState } from "./browserSessionState.js";

/** 落盘的待分支记录（sourceId 是键，forkId 补完后回填以便重启续做）。 */
export interface PendingFork {
  sourceId: string;
  keep: number;
  forkId?: string;
}

/** 协调器需要的最小会话面（结构类型：不把 SessionStore 整体拖进来）。 */
export interface ForkSessionStore {
  get(sessionId: string): { messages: readonly unknown[] } | null;
  isTask(sessionId: string): boolean;
  setTask(sessionId: string, task: boolean): void;
  fork(sessionId: string, keepCount: number, title?: string, options?: { activate?: boolean }): { sessionId: string } | null;
  moveTail(sourceId: string, targetId: string, keep: number): boolean;
  remove(sessionId: string): void;
}

/** 浏览器标签状态面（任务页过户用）。 */
export interface ForkBrowserStates {
  get(sessionId: string): PersistedBrowserState | null;
  set(sessionId: string, state: PersistedBrowserState): void;
  delete(sessionId: string): void;
}

export interface ForkBrowserHost {
  reassignSession(from: string, to: string): void;
  snapshotSession(sessionId: string): PersistedBrowserState | null;
}

export interface TaskForkDeps {
  sessions: ForkSessionStore;
  browserStates: ForkBrowserStates;
  /** 记录文件（<dataDir>/pending-task-forks.json）。 */
  file: string;
  /** 需要宿主时返回 null（无窗口/未就绪）：此时只记身份，不动页面。 */
  browserHost(): ForkBrowserHost | null;
  push(event: string, payload: unknown): void;
  /** 过户前取消旧会话的防抖保存，避免 400ms 后又把任务页写回普通会话。 */
  cancelStateSave?(sessionId: string): void;
  /** 原会话被分支接管时同步「下次启动打开哪个会话」。 */
  onSourceMoved?(from: string, to: string): void;
}

export class TaskForkCoordinator {
  /** 本回合适格为任务、等待结束时过户的会话。 */
  private readonly pending = new Set<string>();
  /** 分支点（本轮开始前的消息数）。 */
  private readonly keep = new Map<string, number>();
  /** 落盘记录（崩溃恢复的唯一依据）。 */
  private readonly records = new Map<string, PendingFork>();
  /** 回合开始时的消息数快照：动作发生在本轮，分支必须从更早的位置切。 */
  private readonly turnStarts = new Map<string, number>();

  constructor(private readonly deps: TaskForkDeps) {
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.deps.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.deps.file, "utf8")) as unknown;
      for (const item of Array.isArray(raw) ? (raw as PendingFork[]) : []) {
        if (item && typeof item.sourceId === "string" && Number.isFinite(item.keep)) {
          this.records.set(item.sourceId, item);
        }
      }
    } catch {
      // 标记文件损坏：忽略（下次写入会重建）
    }
  }

  private persist(): void {
    try {
      fs.writeFileSync(this.deps.file, JSON.stringify([...this.records.values()]), "utf8");
    } catch {
      // 恢复标记落盘失败不阻断运行：最坏结果是这次崩溃无法自动补完分支
    }
  }

  /** 回合开始：记下「本轮之前」的消息数（后续分支点不会晚于它）。 */
  onTurnStarted(sessionId: string): void {
    this.turnStarts.set(sessionId, this.deps.sessions.get(sessionId)?.messages.length ?? 0);
  }

  /** 回合结束：清掉起始快照（身份/分支记录由 settle 处理）。 */
  onTurnSettledStart(sessionId: string): void {
    this.turnStarts.delete(sessionId);
  }

  /**
   * Agent 首次动手：会话立刻显示为任务（折叠工作区立即出现），
   * 真正的分支留到回合结束再做（那时本轮回复才落库）。
   */
  markBrowserAction(sessionId: string): void {
    if (this.deps.sessions.isTask(sessionId)) return;
    this.deps.sessions.setTask(sessionId, true);
    const keep = this.turnStarts.get(sessionId) ?? 0;
    this.pending.add(sessionId);
    this.keep.set(sessionId, keep);
    this.records.set(sessionId, { sourceId: sessionId, keep });
    this.persist();
  }

  /**
   * 回合结束：把任务身份从原会话过户给分支。
   * 返回 true = 本次确实处理了一次待分支（调用方可据此跳过其它收尾）。
   */
  settle(sessionId: string): boolean {
    if (!this.pending.delete(sessionId)) return false;
    const source = this.deps.sessions.get(sessionId);
    const keep = this.keep.get(sessionId) ?? Math.max(0, (source?.messages.length ?? 0) - 2);
    this.keep.delete(sessionId);
    this.turnStarts.delete(sessionId);

    if (!source || source.messages.length <= keep) {
      // 回合没落库（异常/退出）：不留「任务但没有分支」的孤儿状态。
      this.deps.sessions.setTask(sessionId, false);
      this.records.delete(sessionId);
      this.persist();
      return true;
    }

    const fork = this.deps.sessions.fork(sessionId, keep, undefined, { activate: false });
    if (!fork) return true;

    const record = this.records.get(sessionId);
    if (record) {
      record.forkId = fork.sessionId;
      this.persist();
    }
    if (!this.deps.sessions.moveTail(sessionId, fork.sessionId, keep)) {
      // 搬不动就把分支撤掉，不能留下一个空分支挂着任务身份。
      this.deps.sessions.remove(fork.sessionId);
      this.deps.sessions.setTask(sessionId, false);
      this.records.delete(sessionId);
      this.persist();
      return true;
    }

    this.deps.sessions.setTask(sessionId, false);
    this.deps.sessions.setTask(fork.sessionId, true);
    const host = this.deps.browserHost();
    if (host) {
      host.reassignSession(sessionId, fork.sessionId);
      const state = host.snapshotSession(fork.sessionId);
      if (state && state.tabs.length > 0) this.deps.browserStates.set(fork.sessionId, state);
    }
    // 过户后旧会话可能还有防抖保存队列：先取消，避免把任务页又写回普通会话。
    this.deps.cancelStateSave?.(sessionId);
    this.deps.browserStates.delete(sessionId);
    this.records.delete(sessionId);
    this.persist();
    this.deps.push("chat:taskForked", { from: sessionId, to: fork.sessionId });
    return true;
  }

  /**
   * 启动恢复：上次崩溃时没来得及 fork 的任务，补完或清掉孤儿标记。
   * 幂等：跑两遍结果一致（第二遍记录已空）。
   */
  recover(): void {
    for (const [sourceId, record] of [...this.records]) {
      const source = this.deps.sessions.get(sourceId);
      if (!source) {
        this.records.delete(sourceId);
        this.persist();
        continue;
      }
      let fork = record.forkId ? this.deps.sessions.get(record.forkId) : null;
      let forkId = record.forkId ? { sessionId: record.forkId } : null;
      if (!fork && source.messages.length > record.keep) {
        forkId = this.deps.sessions.fork(sourceId, record.keep, undefined, { activate: false });
        if (forkId) {
          record.forkId = forkId.sessionId;
          this.persist();
        }
      }
      const target = fork ? record.forkId ?? null : forkId?.sessionId ?? null;
      if (target) {
        if (source.messages.length > record.keep) this.deps.sessions.moveTail(sourceId, target, record.keep);
        this.deps.sessions.setTask(sourceId, false);
        this.deps.sessions.setTask(target, true);
        const state = this.deps.browserStates.get(sourceId);
        if (state) this.deps.browserStates.set(target, state);
        this.deps.browserStates.delete(sourceId);
        this.deps.onSourceMoved?.(sourceId, target);
      } else {
        // 没有可搬的操作回合：不留任务身份，也不留只剩任务页的孤儿存档。
        this.deps.sessions.setTask(sourceId, false);
        this.deps.browserStates.delete(sourceId);
      }
      this.records.delete(sourceId);
      this.persist();
    }
  }

  /** 诊断：当前待分支会话数（E2E/日志用）。 */
  pendingCount(): number {
    return this.records.size;
  }
}
