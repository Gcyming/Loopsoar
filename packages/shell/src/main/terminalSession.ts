/**
 * 持久终端会话管理：每终端一个独立子进程，保留 cwd / env / 解释器状态。
 *
 * 为什么不做「一条命令 spawn 一次」：交互式环境（python/node REPL、vcvars 工具链环境、
 * 长驻服务、watch 模式）依赖进程内状态，一次性进程无法覆盖；但持久进程会放大风险面，因此：
 *   · 环境变量白名单（buildTerminalEnv）——绝不把宿主密钥 / LOOPSOAR_* 业务变量带进子进程；
 *   · input()/run() 的完整命令行先过 hardRuleCheck（fail-closed：命中只提示、绝不写入 stdin）；
 *   · cwd 必须落在会话工作根内（symlink 先解析真实路径再判，防链接逃逸）；
 *   · 空闲回收 + 并发上限 + 退出注销 + 进程树清理（Windows taskkill /T /F），防进程泄漏。
 *
 * 事件（主进程 push → 渲染层）：
 *   terminal:data  { terminalId, data }                      stdout+stderr 合流，30ms 批处理
 *   terminal:state { terminalId, state, cwd?, label?, error? } state 仅 starting/ready/exited/error
 *   terminal:exit  { terminalId, code, signal? }              进程退出（code 可能为 null）
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  TERMINAL_BUFFER_BYTES,
  TERMINAL_IDLE_MS,
  TERMINAL_INPUT_MAX_BYTES,
  TERMINAL_MAX_SESSIONS,
} from "loopsoar-contracts/security-policy";
import { hardRuleCheck } from "loopsoar-core/tools/hard_rules";
import {
  buildTerminalEnv,
  detectTerminalProfiles,
  resolveProfile,
  type TerminalProfileInfo,
  type TerminalProfileKey,
} from "./terminalProfiles.js";

/** 终端实例状态（UI 只认这四个值，不额外引入 running/closed）。 */
export type TerminalState = "starting" | "ready" | "exited" | "error";

export interface TerminalSessionInfo {
  terminalId: string;
  sessionId: string;
  profile: TerminalProfileKey;
  cwd: string;
  state: TerminalState;
  createdAt: number;
  label: string;
}

export interface TerminalManagerOptions {
  /** 会话工作根解析（worktree > 会话工作区 > 活动工作区），由 index.ts 注入。 */
  resolveWorkspaceRoot: (sessionId?: string) => string;
  /** 事件推送（事件名不带 loopsoar: 前缀，由渲染层桥接加）。 */
  push: (event: string, payload: unknown) => void;
  /** 并发存活终端上限（默认 contracts TERMINAL_MAX_SESSIONS = 8）。 */
  maxSessions?: number;
  /** 空闲回收时间（默认 contracts TERMINAL_IDLE_MS = 30 分钟）。 */
  idleMs?: number;
}

export interface TerminalHistory {
  terminalId: string;
  profile: string;
  state: string;
  data: string;
}

/** 内部会话记录。 */
interface LiveSession {
  info: TerminalSessionInfo;
  child: ChildProcess | null;
  /** 环形回放缓冲：按字节裁剪，只丢最旧输出。 */
  ring: Buffer[];
  ringBytes: number;
  /** 30ms 批处理待推送文本（与 ring 独立：ring 是完整回放，pending 是待推事件）。 */
  pendingText: string;
  flushTimer: NodeJS.Timeout | null;
  idleTimer: NodeJS.Timeout | null;
  /** 强杀兜底：taskkill 后 5s 仍无 exit 事件时强制收尾，避免僵尸会话占并发额度。 */
  killerTimer: NodeJS.Timeout | null;
  decoder: StringDecoder;
  /** cmd/powershell 的 stdin 需要 CRLF 行尾；posix 解释器用 LF。 */
  lineEnding: "\r\n" | "\n";
  exited: boolean;
  closed: boolean;
}

const DATA_FLUSH_MS = 30;
const PENDING_FLUSH_LIMIT = 64 * 1024;
const KILL_FALLBACK_MS = 5_000;
/** 已退出终端的保留倍数（供回放）；超出后按创建时间淘汰最旧的。 */
const EXITED_RETENTION_MULTIPLIER = 2;

export class TerminalSessionManager {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly resolveWorkspaceRoot: (sessionId?: string) => string;
  private readonly pushEvent: (event: string, payload: unknown) => void;
  private readonly maxSessions: number;
  private readonly idleMs: number;
  private readonly bufferBytes: number;

  constructor(opts: TerminalManagerOptions) {
    this.resolveWorkspaceRoot = opts.resolveWorkspaceRoot;
    this.pushEvent = opts.push;
    this.maxSessions = opts.maxSessions ?? TERMINAL_MAX_SESSIONS;
    this.idleMs = opts.idleMs ?? TERMINAL_IDLE_MS;
    this.bufferBytes = TERMINAL_BUFFER_BYTES;
  }

  /** 配置档探测（60s 缓存；失败降级为 available:false，不抛）。 */
  async profiles(): Promise<TerminalProfileInfo[]> {
    return detectTerminalProfiles();
  }

  list(): TerminalSessionInfo[] {
    return Array.from(this.sessions.values()).map((session) => ({ ...session.info }));
  }

  /**
   * 打开一个持久终端。
   * 失败语义（调用方 try/catch）：未知配置档 / 超出并发上限 / 配置档不可用 / cwd 越界 / 启动失败。
   */
  async open(input: { sessionId?: string; profile: TerminalProfileKey; cwd?: string }): Promise<TerminalSessionInfo> {
    const profile = resolveProfile(input.profile);
    if (!profile) throw new Error(`未知终端配置档：${String(input.profile)}`);
    // 先查上限再探测可用性：超限是确定性的拒绝，不该再为一次注定失败的打开做路径探测
    if (this.liveCount() >= this.maxSessions) {
      throw new Error(`终端会话已达上限（${this.maxSessions}），请先关闭不用的终端`);
    }
    if (!profile.available || !profile.persistent) {
      throw new Error(`配置档「${profile.label}」不可用：${profile.detail ?? "未安装"}`);
    }

    const root = this.resolveWorkspaceRoot(input.sessionId);
    const cwd = resolveCwdWithin(root, input.cwd);
    const persistent = profile.persistent;
    const terminalId = `term-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const info: TerminalSessionInfo = {
      terminalId,
      sessionId: input.sessionId ?? "",
      profile: profile.key,
      cwd,
      state: "starting",
      createdAt: Date.now(),
      label: this.nextLabel(profile.label),
    };
    const session: LiveSession = {
      info,
      child: null,
      ring: [],
      ringBytes: 0,
      pendingText: "",
      flushTimer: null,
      idleTimer: null,
      killerTimer: null,
      decoder: new StringDecoder("utf8"),
      lineEnding: isCmdLike(persistent.command) ? "\r\n" : "\n",
      exited: false,
      closed: false,
    };
    this.sessions.set(terminalId, session);
    this.emitState(session);

    let child: ChildProcess;
    try {
      child = spawn(persistent.command, persistent.args, {
        cwd,
        // 白名单环境 + 配置档专用追加（如 MinGW 的 PATH 前缀）
        env: { ...buildTerminalEnv(), ...(persistent.env ?? {}) },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        // C++/MSVC 需要保留 call "C:\Program Files\..." 里的引号（见 TerminalSpawnSpec.verbatim）
        windowsVerbatimArguments: persistent.verbatim === true,
        // POSIX：独立进程组，interrupt/清理时可用负 pid 一次带走整棵树
        detached: process.platform !== "win32",
      });
    } catch (err) {
      this.sessions.delete(terminalId);
      const message = err instanceof Error ? err.message : String(err);
      this.pushEvent("terminal:state", { terminalId, state: "error", error: message });
      throw new Error(`[启动失败] ${profile.label}：${message}`);
    }

    try {
      await this.waitSpawned(child);
    } catch (err) {
      // spawn 失败（ENOENT/EACCES…）：移除半初始化会话，绝不留在列表里
      this.cleanupTimers(session);
      this.sessions.delete(terminalId);
      const message = err instanceof Error ? err.message : String(err);
      info.state = "error";
      this.pushEvent("terminal:state", { terminalId, state: "error", error: message });
      throw new Error(`[启动失败] ${profile.label}：${message}`);
    }

    // 先挂上 child：若 open 等待期间已被 close()（child 还是 null 杀不到），下面的 closed
    // 分支需要靠这个引用把真实子进程收掉。
    session.child = child;
    if (session.closed) {
      // 竞态：open 还没 spawn 完就被 close（用户连点/上层注销）。收掉子进程并中止打开流程，
      // 否则会返回一个已关闭会话的 ready 状态给调用方。
      this.shutdownSession(session);
      throw new Error("终端在启动过程中被关闭");
    }
    info.state = "ready";
    this.attachChild(session, child);
    this.touchIdle(session);
    this.emitState(session);
    return { ...info };
  }

  /** 原始输入（按键/整行）：含换行的完整命令行先过危险规则（fail-closed）。 */
  input(terminalId: string, data: string): { ok: boolean; error?: string } {
    const session = this.sessions.get(terminalId);
    if (!session) return { ok: false, error: "终端不存在或已关闭" };
    if (session.exited || session.info.state !== "ready" || !session.child?.stdin) {
      return { ok: false, error: "终端未运行（进程已退出）" };
    }
    if (typeof data !== "string" || data.length === 0) return { ok: false, error: "输入为空" };
    const bytes = Buffer.byteLength(data, "utf8");
    if (bytes > TERMINAL_INPUT_MAX_BYTES) {
      return { ok: false, error: `输入超过上限（${bytes} 字节 > ${TERMINAL_INPUT_MAX_BYTES} 字节）` };
    }
    try {
      if (/[\r\n]/.test(data)) {
        // 逐行判断：多行输入里夹带危险命令同样拦截（只提示，不写入 stdin）
        for (const line of data.split(/\r?\n/)) {
          const verdict = hardRuleCheck(line);
          if (verdict.blocked) return this.blockedInput(session, verdict.reason);
        }
      }
      session.child.stdin.write(data);
    } catch (err) {
      return { ok: false, error: `写入终端失败：${err instanceof Error ? err.message : String(err)}` };
    }
    this.touchIdle(session);
    return { ok: true };
  }

  /** 在持久会话里执行一条完整命令行（等价于用户敲回车）。 */
  async run(terminalId: string, command: string): Promise<{ ok: boolean; error?: string }> {
    const session = this.sessions.get(terminalId);
    if (!session) return { ok: false, error: "终端不存在或已关闭" };
    if (session.exited || session.info.state !== "ready" || !session.child?.stdin) {
      return { ok: false, error: "终端未运行（进程已退出）" };
    }
    const line = typeof command === "string" ? command.trim() : "";
    if (!line) return { ok: false, error: "命令为空" };
    for (const candidate of line.split(/\r?\n/)) {
      const verdict = hardRuleCheck(candidate);
      if (verdict.blocked) return this.blockedInput(session, verdict.reason);
    }
    try {
      session.child.stdin.write(`${line}${session.lineEnding}`);
    } catch (err) {
      return { ok: false, error: `写入终端失败：${err instanceof Error ? err.message : String(err)}` };
    }
    this.touchIdle(session);
    return { ok: true };
  }

  /**
   * 中断当前命令（UI 的 Ctrl+C）。
   * Windows 下管道 stdin 的 ^C 不会触发控制台中断信号，只能补进程树终止（终端随之 exited）；
   * POSIX 下向进程组发 SIGINT，保留终端本身。
   */
  interrupt(terminalId: string): boolean {
    const session = this.sessions.get(terminalId);
    if (!session || session.exited) return false;
    const child = session.child;
    if (!child) return false;
    try {
      child.stdin?.write("\x03");
    } catch {
      // 进程可能刚好退出
    }
    if (process.platform === "win32") {
      this.terminate(session);
    } else {
      try {
        if (child.pid) process.kill(-child.pid, "SIGINT");
      } catch {
        try {
          child.kill("SIGINT");
        } catch {
          // 已退出
        }
      }
    }
    this.touchIdle(session);
    return true;
  }

  /** 关闭单个终端（幂等：不存在/已离线返回 false）。 */
  close(terminalId: string): boolean {
    const session = this.sessions.get(terminalId);
    if (!session) return false;
    this.sessions.delete(terminalId);
    const wasLive = !session.exited;
    this.shutdownSession(session);
    if (wasLive) this.pushEvent("terminal:state", { terminalId, state: "exited", reason: "closed" });
    return true;
  }

  /** 关闭某会话的全部终端，返回关闭数量（幂等：无终端返回 0）。 */
  closeSession(sessionId: string): number {
    let closed = 0;
    for (const terminalId of Array.from(this.sessions.keys())) {
      const session = this.sessions.get(terminalId);
      if (!session || session.info.sessionId !== sessionId) continue;
      if (this.close(terminalId)) closed += 1;
    }
    return closed;
  }

  /**
   * 关闭全部终端（应用退出清理；幂等）。
   * 与 close() 的区别：退出路径上进程可能紧接着就没了，异步 spawn taskkill 来不及执行，
   * 因此这里对 Windows 活终端用 spawnSync 同步杀进程树，保证不留孤儿终端进程。
   */
  closeAll(): void {
    for (const terminalId of Array.from(this.sessions.keys())) {
      const session = this.sessions.get(terminalId);
      const child = session?.child;
      if (session && !session.exited && child?.pid && process.platform === "win32") {
        try {
          spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
            timeout: 5_000,
          });
        } catch {
          // taskkill 不可用/进程已退出：close() 里还有一次异步兜底
        }
      }
      this.close(terminalId);
    }
  }

  /** 回放缓冲快照（含 ANSI 原始输出）；不认识的 id 返回 null。 */
  history(terminalId: string): TerminalHistory | null {
    const session = this.sessions.get(terminalId);
    if (!session) return null;
    return {
      terminalId,
      profile: session.info.profile,
      state: session.info.state,
      data: Buffer.concat(session.ring, session.ringBytes).toString("utf8"),
    };
  }

  /* ───────────────────────── 内部实现 ───────────────────────── */

  private waitSpawned(child: ChildProcess): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => {
        child.off("error", onError);
        resolve();
      };
      const onError = (err: Error): void => {
        child.off("spawn", onSpawn);
        reject(err);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }

  private attachChild(session: LiveSession, child: ChildProcess): void {
    // stdout/stderr 合流：终端里用户只关心「按时间顺序发生了什么」，分开推反而让 UI 交错错乱
    child.stdout?.on("data", (chunk: Buffer) => this.onOutput(session, chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.onOutput(session, chunk));
    child.on("error", (err: Error) => this.onChildError(session, err));
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => this.onExit(session, code, signal));
    // stdin EPIPE（进程刚好退出）不应变成未捕获异常
    child.stdin?.on("error", () => undefined);
  }

  private onOutput(session: LiveSession, chunk: Buffer): void {
    if (session.exited || session.closed) return;
    const text = session.decoder.write(chunk);
    if (!text) return;
    this.appendRing(session, Buffer.from(text, "utf8"));
    session.pendingText += text;
    if (session.pendingText.length >= PENDING_FLUSH_LIMIT) {
      this.flushData(session);
    } else if (!session.flushTimer) {
      session.flushTimer = setTimeout(() => {
        session.flushTimer = null;
        this.flushData(session);
      }, DATA_FLUSH_MS);
      session.flushTimer.unref();
    }
    this.touchIdle(session);
  }

  private flushData(session: LiveSession): void {
    if (!session.pendingText) return;
    const data = session.pendingText;
    session.pendingText = "";
    this.pushEvent("terminal:data", { terminalId: session.info.terminalId, data });
  }

  private appendRing(session: LiveSession, chunk: Buffer): void {
    if (chunk.byteLength === 0) return;
    session.ring.push(chunk);
    session.ringBytes += chunk.byteLength;
    let overflow = session.ringBytes - this.bufferBytes;
    while (overflow > 0 && session.ring.length > 0) {
      const head = session.ring[0]!;
      if (head.byteLength <= overflow) {
        session.ring.shift();
        session.ringBytes -= head.byteLength;
        overflow -= head.byteLength;
      } else {
        session.ring[0] = head.subarray(overflow);
        session.ringBytes -= overflow;
        overflow = 0;
      }
    }
  }

  private touchIdle(session: LiveSession): void {
    if (session.exited || session.closed) return;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      session.idleTimer = null;
      this.recycleIdle(session);
    }, this.idleMs);
    session.idleTimer.unref();
  }

  private recycleIdle(session: LiveSession): void {
    if (session.exited || session.closed) return;
    const notice = `\r\n[终端空闲超过 ${Math.round(this.idleMs / 60_000)} 分钟，已自动回收]\r\n`;
    this.appendRing(session, Buffer.from(notice, "utf8"));
    this.pushEvent("terminal:data", { terminalId: session.info.terminalId, data: notice });
    this.terminate(session);
  }

  private blockedInput(session: LiveSession, reason: string | undefined): { ok: false; error: string } {
    const message = `[危险命令已拦截] ${reason ?? "匹配危险规则"}`;
    const notice = `\r\n${message}\r\n`;
    this.appendRing(session, Buffer.from(notice, "utf8"));
    this.pushEvent("terminal:data", { terminalId: session.info.terminalId, data: notice });
    return { ok: false, error: message };
  }

  /** 终止进程树；exit 事件负责把会话置为 exited 并推事件。 */
  private terminate(session: LiveSession): void {
    const child = session.child;
    if (!child) return;
    this.killTree(child);
    if (session.killerTimer) clearTimeout(session.killerTimer);
    session.killerTimer = setTimeout(() => {
      session.killerTimer = null;
      if (session.exited) return;
      // 最后手段：直接 SIGKILL 直接子进程，然后强制收尾（避免永久占额度）
      try {
        session.child?.kill("SIGKILL");
      } catch {
        // 已退出
      }
      this.onExit(session, null, "SIGKILL");
    }, KILL_FALLBACK_MS);
    session.killerTimer.unref();
  }

  /** Windows 必须杀整棵树（taskkill /T /F）：只杀直接子进程会留下孙进程并持有管道。 */
  private killTree(child: ChildProcess): void {
    const pid = child.pid;
    if (!pid) {
      try {
        child.kill("SIGKILL");
      } catch {
        // 已退出
      }
      return;
    }
    if (process.platform === "win32") {
      try {
        spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      } catch {
        try {
          child.kill();
        } catch {
          // 已退出
        }
      }
      return;
    }
    try {
      // detached spawn 已建独立进程组：负 pid 一次带走整棵树
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // 已退出
      }
    }
  }

  private onExit(session: LiveSession, code: number | null, signal: NodeJS.Signals | null): void {
    if (session.exited) return;
    session.exited = true;
    session.info.state = "exited";
    session.child = null;
    this.cleanupTimers(session);
    const tail = session.decoder.end();
    if (tail) {
      this.appendRing(session, Buffer.from(tail, "utf8"));
      session.pendingText += tail;
    }
    this.flushData(session);
    if (!session.closed) {
      this.emitState(session);
      this.pushEvent("terminal:exit", {
        terminalId: session.info.terminalId,
        code,
        signal: signal ?? undefined,
      });
    }
    this.pruneExited();
  }

  private onChildError(session: LiveSession, err: Error): void {
    if (session.exited) return;
    session.info.state = "error";
    this.emitState(session, err.message);
    this.pushEvent("terminal:data", {
      terminalId: session.info.terminalId,
      data: `\r\n[终端错误] ${err.message}\r\n`,
    });
    this.terminate(session);
  }

  private shutdownSession(session: LiveSession): void {
    session.closed = true;
    this.cleanupTimers(session);
    // 解码器残余字节补进回放缓冲；pendingText 已在 onOutput 时同步写入 ring，这里直接丢弃
    // （否则会把最后一批未推送输出在 history 里重复一次）。
    const tail = session.decoder.end();
    if (tail) this.appendRing(session, Buffer.from(tail, "utf8"));
    session.pendingText = "";
    const child = session.child;
    session.child = null;
    session.exited = true;
    session.info.state = "exited";
    if (!child) return;
    child.stdout?.removeAllListeners("data");
    child.stderr?.removeAllListeners("data");
    child.removeAllListeners("exit");
    child.removeAllListeners("error");
    try {
      child.stdin?.destroy();
    } catch {
      // 已关闭
    }
    this.killTree(child);
  }

  private cleanupTimers(session: LiveSession): void {
    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    if (session.killerTimer) {
      clearTimeout(session.killerTimer);
      session.killerTimer = null;
    }
  }

  private emitState(session: LiveSession, error?: string): void {
    if (session.closed) return;
    this.pushEvent("terminal:state", {
      terminalId: session.info.terminalId,
      state: session.info.state,
      cwd: session.info.cwd,
      label: session.info.label,
      error,
    });
  }

  /** 只统计存活会话（exited 的保留记录不占并发额度）。 */
  private liveCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (!session.exited) count += 1;
    }
    return count;
  }

  /** 淘汰超出保留上限的最旧 exited 记录（避免无限累积回放缓冲）。 */
  private pruneExited(): void {
    const limit = Math.max(this.maxSessions * EXITED_RETENTION_MULTIPLIER, 4);
    if (this.sessions.size <= limit) return;
    const exited = Array.from(this.sessions.values())
      .filter((session) => session.exited)
      .sort((a, b) => a.info.createdAt - b.info.createdAt);
    let toRemove = this.sessions.size - limit;
    for (const session of exited) {
      if (toRemove <= 0) break;
      this.sessions.delete(session.info.terminalId);
      toRemove -= 1;
    }
  }

  /** 同配置档多个终端时给标签加序号，UI 标签页才可区分。 */
  private nextLabel(base: string): string {
    let used = 0;
    for (const session of this.sessions.values()) {
      if (session.exited) continue;
      if (session.info.label === base || session.info.label.startsWith(`${base} `)) used += 1;
    }
    return used === 0 ? base : `${base} ${used + 1}`;
  }
}

/* ───────────────────────── 纯函数（可单测，不起子进程） ───────────────────────── */

/** cmd/powershell 的命令行行尾需要 CRLF；posix 解释器 LF 即可。 */
function isCmdLike(command: string): boolean {
  const base = path.basename(command).toLowerCase();
  return base === "cmd" || base === "cmd.exe" || base === "pwsh" || base.includes("powershell");
}

/** 路径是否位于 root 内（win32 的大小写不敏感由 path.relative 处理；跨盘返回绝对路径）。 */
export function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === "") return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function safeRealpath(candidate: string): string | null {
  try {
    return fs.realpathSync.native(candidate);
  } catch {
    return null;
  }
}

/**
 * 解析并校验终端工作目录：必须真实存在、是文件夹、且位于会话工作根内。
 * 先 realpath 再比较，防止「工作根里放一个指向外部的目录链接」绕过越界检查（fail-closed）。
 */
export function resolveCwdWithin(root: string, requested?: string): string {
  const resolvedRoot = path.resolve(root || process.cwd());
  const target =
    requested && requested.trim().length > 0 ? path.resolve(resolvedRoot, requested.trim()) : resolvedRoot;
  const realRoot = safeRealpath(resolvedRoot);
  if (!realRoot) throw new Error(`会话工作根不存在或不可访问：${resolvedRoot}`);
  const realTarget = safeRealpath(target);
  if (!realTarget) throw new Error(`工作目录不存在或不可访问：${target}`);
  if (!isPathWithin(realRoot, realTarget)) {
    throw new Error(`工作目录越界（必须在会话工作根 ${realRoot} 内）：${realTarget}`);
  }
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(realTarget).isDirectory();
  } catch {
    throw new Error(`工作目录不可访问：${realTarget}`);
  }
  if (!isDirectory) throw new Error(`工作目录不是文件夹：${realTarget}`);
  return realTarget;
}
