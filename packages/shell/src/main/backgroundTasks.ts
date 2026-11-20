/**
 * 后台任务：让 Agent 起一条长命令（构建/测试/dev server）后继续思考，而不是被 30s 超时掐断。
 *
 * 与 `terminal_run` 的分工：
 *   · `terminal_run` 一次性、等结果、有超时；适合秒级命令；
 *   · 这里只负责「起进程 + 读增量输出 + 杀」，不阻塞回合；输出进环形缓冲，不无限吃内存。
 *
 * 安全边界（与前台终端一致，绝不因为「后台」放宽）：
 *   · 危险命令先过 hardRuleCheck + classifyCommand（fail-closed）；
 *   · cwd 必须在会话工作根内（symlink 解析后判定）；
 *   · 环境变量白名单（不把宿主密钥带进子进程）；
 *   · 按会话隔离：只看/只杀自己会话的任务；应用退出时统一杀进程树。
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ToolContext, ToolRegistry, ToolResult } from "loopsoar-core/tools/registry";
import { hardRuleCheck } from "loopsoar-core/tools/hard_rules";
import { classifyCommand } from "loopsoar-core/tools/classifier";
import { buildTerminalEnv, resolveProfile, type TerminalProfileKey } from "./terminalProfiles.js";
import { resolveCwdWithin } from "./terminalSession.js";
import { killProcessTree } from "./terminalTools.js";

/** 每个任务保留的尾部输出上限；超出丢弃头部并记录 dropped，避免长构建吃满内存。 */
const MAX_BUFFER_CHARS = 40_000;
const DEFAULT_TAIL = 8_000;
const MAX_TASKS = 12;

export interface BackgroundTaskInfo {
  id: string;
  sessionId: string;
  command: string;
  profile: TerminalProfileKey;
  cwd: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  running: boolean;
  truncated: boolean;
  /** 已丢弃的头部字符数（绝对偏移从 0 开始，dropped 用于解释缺口）。 */
  dropped: number;
}

interface Task {
  info: BackgroundTaskInfo;
  child: ChildProcess;
  output: string;
}

function clip(text: string): string {
  return text.length <= MAX_BUFFER_CHARS ? text : text.slice(text.length - MAX_BUFFER_CHARS);
}

export class BackgroundTaskManager {
  private tasks = new Map<string, Task>();
  private seq = 0;

  start(input: {
    sessionId: string;
    command: string;
    profile: TerminalProfileKey;
    cwd: string;
    spec: { command: string; args: string[]; env?: Record<string, string>; verbatim?: boolean };
  }): { ok: true; info: BackgroundTaskInfo } | { ok: false; error: string } {
    if (this.tasks.size >= MAX_TASKS) {
      const finished = [...this.tasks.values()].find((task) => !task.info.running);
      if (!finished) return { ok: false, error: `后台任务已达上限（${MAX_TASKS}），先 terminal_kill 或等其结束` };
      this.tasks.delete(finished.info.id);
    }
    const id = `bg-${Date.now().toString(36)}-${(this.seq += 1).toString(36)}`;
    let child: ChildProcess;
    try {
      child = spawn(input.spec.command, input.spec.args, {
        cwd: input.cwd,
        env: { ...buildTerminalEnv(), ...(input.spec.env ?? {}) },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: input.spec.verbatim === true,
        detached: process.platform !== "win32",
      });
    } catch (err) {
      return { ok: false, error: `启动失败：${err instanceof Error ? err.message : String(err)}` };
    }
    const info: BackgroundTaskInfo = {
      id,
      sessionId: input.sessionId || "default",
      command: input.command,
      profile: input.profile,
      cwd: input.cwd,
      startedAt: Date.now(),
      running: true,
      truncated: false,
      dropped: 0,
    };
    const task: Task = { info, child, output: "" };
    const append = (text: string): void => {
      if (!text) return;
      task.output += text;
      if (task.output.length > MAX_BUFFER_CHARS) {
        task.info.dropped += task.output.length - MAX_BUFFER_CHARS;
        task.info.truncated = true;
        task.output = clip(task.output);
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (err) => {
      append(`\n[启动/运行错误] ${err.message}`);
      info.running = false;
      info.endedAt = Date.now();
      info.exitCode = null;
    });
    child.on("exit", (code) => {
      info.running = false;
      info.endedAt = Date.now();
      info.exitCode = code;
    });
    this.tasks.set(id, task);
    return { ok: true, info };
  }

  list(sessionId?: string): BackgroundTaskInfo[] {
    const sid = sessionId || "default";
    return [...this.tasks.values()]
      .filter((task) => task.info.sessionId === sid)
      .map((task) => task.info)
      .sort((a, b) => Number(b.running) - Number(a.running) || b.startedAt - a.startedAt);
  }

  /** 读增量：offset 是「已读到的绝对字符位置」，返回新 offset；越界自动夹紧。 */
  read(
    id: string,
    sessionId: string | undefined,
    offset: number,
    tail: number,
  ): { ok: true; info: BackgroundTaskInfo; chunk: string; nextOffset: number } | { ok: false; error: string } {
    const task = this.tasks.get(id);
    if (!task) return { ok: false, error: `没有这个后台任务：${id}` };
    if (sessionId && task.info.sessionId !== sessionId) return { ok: false, error: "该任务不属于当前会话" };
    const startAbs = Math.max(0, offset - task.info.dropped);
    const fromEnd = Math.max(0, task.output.length - tail);
    const from = Math.max(startAbs, fromEnd);
    const chunk = task.output.slice(from);
    return {
      ok: true,
      info: task.info,
      chunk,
      nextOffset: task.info.dropped + from + chunk.length,
    };
  }

  kill(id: string, sessionId?: string): { ok: boolean; content: string } {
    const task = this.tasks.get(id);
    if (!task) return { ok: false, content: `没有这个后台任务：${id}` };
    if (sessionId && task.info.sessionId !== sessionId) return { ok: false, content: "该任务不属于当前会话" };
    if (!task.info.running) return { ok: true, content: `任务 ${id} 已结束（退出码 ${task.info.exitCode ?? "null"}）` };
    killProcessTree(task.child);
    task.info.running = false;
    task.info.endedAt = Date.now();
    return { ok: true, content: `已终止任务 ${id}（进程树）` };
  }

  killSession(sessionId: string): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.info.sessionId === (sessionId || "default") && task.info.running) {
        killProcessTree(task.child);
        task.info.running = false;
        task.info.endedAt = Date.now();
        count += 1;
      }
    }
    return count;
  }

  killAll(): void {
    for (const task of this.tasks.values()) {
      if (task.info.running) {
        killProcessTree(task.child);
        task.info.running = false;
        task.info.endedAt = Date.now();
      }
    }
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

export function registerBackgroundTerminalTools(
  registry: ToolRegistry,
  manager: BackgroundTaskManager,
  workspaceRoot: (sessionId?: string) => string,
): void {
  registry.register({
    name: "terminal_background",
    description:
      "在会话工作区后台启动一条长命令（构建、测试、dev server），立即返回任务 id；用 terminal_output 读增量输出、terminal_tasks 看状态、terminal_kill 终止。危险命令与越界 cwd 同样被拒绝。",
    permissions: { terminal: true },
    schema: z.object({
      command: z.string().min(1).max(8000),
      profile: z.enum(["cmd", "powershell", "gitbash", "python", "node", "cpp"]).optional(),
      cwd: z.string().max(1024).optional(),
    }),
    execute: async (ctx: ToolContext): Promise<ToolResult> => {
      const params = (ctx.params ?? {}) as { command?: unknown; profile?: unknown; cwd?: unknown };
      const command = typeof params.command === "string" ? params.command : "";
      if (!command.trim()) return { ok: false, content: "[错误] 缺少 command" };
      const hard = hardRuleCheck(command);
      if (hard.blocked) return { ok: false, content: `[错误] 危险命令已拦截：${hard.reason ?? "匹配危险规则"}` };
      let verdict: "readonly" | "confirm" | "block";
      try {
        verdict = classifyCommand(command);
      } catch (err) {
        return { ok: false, content: `[错误] 命令安全分类失败（fail-closed）：${err instanceof Error ? err.message : String(err)}` };
      }
      if (verdict === "block") return { ok: false, content: "[错误] 危险命令已拦截：分类器判定 block" };
      const profileKey = (typeof params.profile === "string" ? params.profile : process.platform === "win32" ? "cmd" : "gitbash") as TerminalProfileKey;
      const profile = resolveProfile(profileKey);
      if (!profile) return { ok: false, content: `[错误] 未知终端配置档：${String(params.profile)}` };
      if (!profile.available) return { ok: false, content: `[错误] 配置档「${profile.label}」不可用：${profile.detail ?? "未安装"}` };
      let cwd: string;
      try {
        cwd = resolveCwdWithin(workspaceRoot(ctx.sessionId) || process.cwd(), typeof params.cwd === "string" ? params.cwd : undefined);
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        return { ok: false, content: `[错误] 工作目录不存在：${path.relative(workspaceRoot(ctx.sessionId) || cwd, cwd) || "."}` };
      }
      const spec = profile.buildOneShot(command);
      if (!spec) return { ok: false, content: `[错误] 配置档「${profile.label}」无法构造执行命令（fail-closed）` };
      const started = manager.start({ sessionId: ctx.sessionId ?? "default", command, profile: profileKey, cwd, spec });
      if (!started.ok) return { ok: false, content: `[错误] ${started.error}` };
      // 给启动一点时间收集首批输出（错误命令通常立刻有 stderr），不阻塞长任务。
      await new Promise((resolve) => setTimeout(resolve, 250));
      const first = manager.read(started.info.id, ctx.sessionId, 0, 1200);
      const head = first.ok && first.chunk.trim() ? `\n${first.chunk.trimEnd()}` : "";
      return {
        ok: true,
        content: `[后台任务 ${started.info.id}] 已启动（profile: ${profileKey}，cwd: ${cwd}）${head}`,
      };
    },
  });

  registry.register({
    name: "terminal_tasks",
    description: "列出本会话的后台任务：id、状态（running/exited）、退出码、运行时长、命令。只读。",
    permissions: { read: true },
    schema: z.object({}),
    execute: async (ctx): Promise<ToolResult> => {
      const list = manager.list(ctx.sessionId);
      if (list.length === 0) return { ok: true, content: "本会话没有后台任务。" };
      const lines = list.map((info) => {
        const state = info.running ? "running" : `exited(${info.exitCode ?? "null"})`;
        const duration = formatDuration((info.endedAt ?? Date.now()) - info.startedAt);
        return `- ${info.id}｜${state}｜${duration}｜${info.command.slice(0, 100)}${info.command.length > 100 ? "…" : ""}`;
      });
      return { ok: true, content: `后台任务（${list.length}）：\n${lines.join("\n")}` };
    },
  });

  registry.register({
    name: "terminal_output",
    description:
      "读取后台任务的输出增量。offset 传上次返回的 nextOffset（首次省略=从最近 tail 字符开始）；返回新 nextOffset 与任务状态，直到 exitCode 出现即结束。",
    permissions: { read: true },
    schema: z.object({
      id: z.string().min(1).max(80),
      offset: z.number().int().min(0).optional(),
      tail: z.number().int().min(200).max(20_000).optional(),
    }),
    execute: async (ctx): Promise<ToolResult> => {
      const params = (ctx.params ?? {}) as { id?: string; offset?: number; tail?: number };
      if (!params.id) return { ok: false, content: "[错误] 缺少 id" };
      const result = manager.read(params.id, ctx.sessionId, params.offset ?? 0, params.tail ?? DEFAULT_TAIL);
      if (!result.ok) return { ok: false, content: `[错误] ${result.error}` };
      const state = result.info.running
        ? "running"
        : `exited(${result.info.exitCode ?? "null"})`;
      const duration = formatDuration((result.info.endedAt ?? Date.now()) - result.info.startedAt);
      const body = result.chunk || "（暂无新输出）";
      const gap = result.info.dropped > 0 ? `\n（较早的 ${result.info.dropped} 字符已被环形缓冲丢弃）` : "";
      return {
        ok: true,
        content: `[${result.info.id}] ${state} · ${duration} · nextOffset=${result.nextOffset}${gap}\n${body}`,
      };
    },
  });

  registry.register({
    name: "terminal_kill",
    description: "终止一个后台任务（连同子进程树）。已结束的任务返回退出码，不报错。",
    permissions: { terminal: true },
    schema: z.object({ id: z.string().min(1).max(80) }),
    execute: async (ctx): Promise<ToolResult> => {
      const params = (ctx.params ?? {}) as { id?: string };
      if (!params.id) return { ok: false, content: "[错误] 缺少 id" };
      const result = manager.kill(params.id, ctx.sessionId);
      return { ok: result.ok, content: result.content };
    },
  });
}
