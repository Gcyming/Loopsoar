/**
 * L3 脚本 loop host（父进程侧，ADR-0010 三档中最自由的一档）。
 *
 * 为什么必须独立进程：脚本 loop 是用户代码，死循环/崩溃/阻塞不能拖垮主进程，
 * 也不能让它直接拿到 Electron / 偏好文件 / 密钥。父进程只代理三件事：
 *   · ctx.llm(messages, opts)   → 代理真实 LlmClient（流式 chunk 逐帧回传给 worker）
 *   · ctx.executeTool(name,args) → 代理真实 ToolExecutor（权限/沙箱/确认全在父进程侧生效）
 *   · ctx.emit(type, payload)    → 转成 LoopEvent 进 sink（UI 时间线照常显示）
 * worker 导出 `async run(ctx)` 返回 outcome；崩溃/超时一律 reject —— 由 core 的 LoopRegistry
 * 用同一 ctx 回退 builtin（安全模式），任务上下文不丢。
 *
 * 协议：stdin/stdout 行分隔 JSON（newline-delimited JSON）。帧定义见 WorkerFrameSchema；
 * worker 实现见 scriptLoopWorker.mjs。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import type { EventSink, LoopEventType } from "loopsoar-core/events";
import type { LlmClient, LlmMessage, LlmRequest } from "loopsoar-core/llm";
import type { PauseGate, ToolExecutor, ToolLoopOutcome } from "loopsoar-core/tool_loop";

/** worker 脚本文件名（与 extensionWorker.mjs 同目录）。 */
export const SCRIPT_WORKER_FILE = "scriptLoopWorker.mjs";
/** 启动超时：worker 必须在此时间内报 ready（含用户脚本 import 时间）。 */
export const DEFAULT_SCRIPT_START_TIMEOUT_MS = 8_000;
/** 单次代理调用超时（一次 ctx.llm 或 ctx.executeTool）。 */
export const DEFAULT_SCRIPT_CALL_TIMEOUT_MS = 60_000;
/** 整段脚本 loop 总超时（兜底；LoopRegistry 的静默超时默认 3h，对脚本太宽松）。 */
export const DEFAULT_SCRIPT_TOTAL_TIMEOUT_MS = 300_000;
/** 单帧上限（防止坏 worker 把内存打爆）。 */
export const MAX_SCRIPT_FRAME_CHARS = 2_000_000;

const SCRIPT_EVENT_TYPES: readonly LoopEventType[] = [
  "chunk",
  "reasoning",
  "tool",
  "tool_start",
  "progress",
  "heartbeat",
];

/** 子进程最小结构（真实 ChildProcess 与测试假子进程都满足）。 */
export interface ScriptChildLike {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: string): boolean;
}

/** 启动 worker 的注入点（测试用假子进程替换真实 spawn）。 */
export type SpawnScriptWorker = (workerPath: string, loopDir: string, script: string) => ScriptChildLike;

export interface ScriptRunLimits {
  maxRounds?: number;
  maxToolCalls?: number;
  maxTotalTokens?: number;
  maxWallClockMs?: number;
}

/** 一次脚本 loop 运行的全部输入（与 ToolLoopOpts 对齐，但由脚本自己编排）。 */
export interface ScriptRunInput {
  loopId: string;
  /** loop 目录（绝对路径；脚本必须位于其内）。 */
  loopDir: string;
  /** 相对 loopDir 的脚本文件。 */
  script: string;
  llm: LlmClient;
  executeTool: ToolExecutor;
  tools?: () => readonly { name: string; description: string; parameters: unknown }[];
  messages?: LlmMessage[];
  limits?: ScriptRunLimits;
  signal?: AbortSignal;
  sink?: EventSink;
  /** 暂停门：脚本每次 LLM/工具代理调用前等待（与内置 loop 一致）。 */
  pauseGate?: PauseGate;
  /** 覆盖 worker 脚本路径（默认 resolveScriptWorkerPath()）。 */
  workerPath?: string;
  startTimeoutMs?: number;
  callTimeoutMs?: number;
  totalTimeoutMs?: number;
  /** 测试注入：替换真实子进程。 */
  spawnWorker?: SpawnScriptWorker;
}

/** 可替换的 runner（测试注入替身；生产实现是 runScriptLoop）。 */
export type ScriptRunner = (input: ScriptRunInput) => Promise<ToolLoopOutcome>;

/** createLoopRuntime 的 scriptHost 配置。 */
export interface ScriptHostOptions {
  workerPath?: string;
  startTimeoutMs?: number;
  callTimeoutMs?: number;
  totalTimeoutMs?: number;
  /** 测试注入：整段 run 的替身（优先于真实子进程）。 */
  run?: ScriptRunner;
}

// ── 帧校验（worker → parent）────────────────────────────────────────────────

const LlmRequestSchema = z.object({
  messages: z.array(z.unknown()).max(1000).optional(),
  tools: z.array(z.unknown()).max(500).optional(),
  maxTokens: z.number().optional(),
  reasoningEffort: z.string().max(64).optional(),
});

const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  args: z.unknown(),
});

const WorkerFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("llm_request"), id: z.number(), request: LlmRequestSchema.optional() }),
  z.object({ type: z.literal("tool_call"), id: z.number(), call: ToolCallSchema }),
  z.object({ type: z.literal("emit"), eventType: z.string().max(40), payload: z.unknown().optional() }),
  z.object({ type: z.literal("outcome"), outcome: z.unknown() }),
  z.object({ type: z.literal("fatal"), message: z.string().max(4000) }),
]);

/** worker 返回的 outcome：宽松补默认（脚本少写字段也能跑），status 必须合法。 */
const ScriptOutcomeSchema = z.object({
  status: z.enum(["done", "budget", "aborted", "silent", "no-progress", "error"]),
  reason: z.string().max(4000).optional(),
  finalText: z.string().optional(),
  usage: z
    .object({
      rounds: z.number().optional(),
      toolCalls: z.number().optional(),
      totalTokens: z.number().optional(),
      wallClockMs: z.number().optional(),
    })
    .optional(),
});

// ── 环境与路径 ──────────────────────────────────────────────────────────────

function isInsideDir(dir: string, target: string): boolean {
  const root = path.resolve(dir);
  const resolved = path.resolve(target);
  return resolved === root || resolved.startsWith(root + path.sep);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * worker 的最小环境变量白名单：绝不把 API Key / token 之类的进程环境透给用户脚本。
 * （需要凭据时脚本只能走 ctx.llm 代理，不得自己发请求。）
 */
const WORKER_ENV_ALLOWLIST = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "OS",
  "LANG",
  "LC_ALL",
  "SHELL",
  "TERM",
] as const;

export function buildScriptWorkerEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of WORKER_ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === "string" && value) env[key] = value;
  }
  // Electron 可执行文件在非 electron 环境（vitest/node）下就是普通 node，这个变量无害；
  // 打包态 electron 进程必须靠它才能以 Node 语义跑 worker。
  env.ELECTRON_RUN_AS_NODE = "1";
  env.LOOPSOAR_SCRIPT_LOOP = "1";
  return env;
}

/** 解析 worker 脚本路径（源码态 src/main、打包态 dist/main 都能找到）。 */
export function resolveScriptWorkerPath(baseDir?: string): string {
  const dir = baseDir ?? path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(dir, SCRIPT_WORKER_FILE),
    path.join(dir, "../src/main", SCRIPT_WORKER_FILE),
    path.join(dir, "../../src/main", SCRIPT_WORKER_FILE),
    path.join(process.cwd(), "packages", "shell", "src", "main", SCRIPT_WORKER_FILE),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

/** 默认 spawn：独立进程 + 最小 env + 不经 shell（脚本路径不参与命令行解析）。 */
export function spawnScriptWorker(workerPath: string, loopDir: string, script: string): ScriptChildLike {
  const child = spawn(process.execPath, [workerPath, loopDir, script], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: buildScriptWorkerEnv(),
  });
  return child as unknown as ScriptChildLike;
}

function normalizeEventType(raw: string): LoopEventType {
  // done/error 由 ChatService 统一发（脚本提前发会让 UI 误判流结束），一律降级为 progress。
  return (SCRIPT_EVENT_TYPES as readonly string[]).includes(raw) ? (raw as LoopEventType) : "progress";
}

function toOutcome(raw: unknown): ToolLoopOutcome {
  const parsed = ScriptOutcomeSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("；");
    throw new Error(`脚本 loop 返回的 outcome 非法：${detail}`);
  }
  const data = parsed.data;
  return {
    status: data.status,
    reason: data.reason ?? `脚本 loop 返回 ${data.status}`,
    finalText: data.finalText ?? "",
    usage: {
      rounds: data.usage?.rounds ?? 0,
      toolCalls: data.usage?.toolCalls ?? 0,
      totalTokens: data.usage?.totalTokens ?? 0,
      wallClockMs: data.usage?.wallClockMs ?? 0,
    },
  };
}

/**
 * 运行一个 L3 脚本 loop。
 *
 * 失败语义（交给 LoopRegistry 处置，本函数只 reject 不自动回退）：
 *   · worker 缺失 / 脚本越界 / 脚本不存在 → 立即抛错（静态失败，无副作用）
 *   · 启动超时 / 单次代理超时 / 总超时 / 进程崩溃 / 非法 outcome → reject（成为 loop:fallback 原因）
 */
export async function runScriptLoop(input: ScriptRunInput): Promise<ToolLoopOutcome> {
  const loopDir = path.resolve(input.loopDir);
  const script = (input.script ?? "").trim();
  if (!script) throw new Error("脚本 loop 未指定脚本文件（script）");
  if (path.isAbsolute(script) || script.split(/[\\/]/).includes("..")) {
    throw new Error(`script 必须是 loop 目录内的相对路径：${script}`);
  }
  const scriptPath = path.resolve(loopDir, script);
  if (!isInsideDir(loopDir, scriptPath)) throw new Error(`脚本必须位于 loop 目录内：${script}`);
  if (!fs.existsSync(scriptPath)) throw new Error(`脚本不存在：${script}`);

  const workerPath = input.workerPath ?? resolveScriptWorkerPath();
  if (!input.spawnWorker && !fs.existsSync(workerPath)) {
    throw new Error(`脚本 loop worker 缺失：${workerPath}`);
  }
  const spawnWorker = input.spawnWorker ?? spawnScriptWorker;

  const startTimeoutMs = input.startTimeoutMs ?? DEFAULT_SCRIPT_START_TIMEOUT_MS;
  const callTimeoutMs = input.callTimeoutMs ?? DEFAULT_SCRIPT_CALL_TIMEOUT_MS;
  const requestedTotalTimeoutMs = input.totalTimeoutMs ?? DEFAULT_SCRIPT_TOTAL_TIMEOUT_MS;
  // 墙钟闸也归宿主：脚本的总超时不得越过本次任务的 maxWallClockMs（只能更紧）。
  const totalTimeoutMs =
    input.limits?.maxWallClockMs !== undefined
      ? Math.min(requestedTotalTimeoutMs, input.limits.maxWallClockMs)
      : requestedTotalTimeoutMs;

  const child = spawnWorker(workerPath, loopDir, script);

  return await new Promise<ToolLoopOutcome>((resolve, reject) => {
    let settled = false;
    let seq = 0;
    let ready = false;
    let stderrTail = "";
    let rl: readline.Interface | null = null;
    let startTimer: NodeJS.Timeout | undefined;
    let totalTimer: NodeJS.Timeout | undefined;
    const callTimers = new Map<number, NodeJS.Timeout>();

    // 预算护栏（ADR-0010：护栏归属 harness，自定义 loop 不得绕过）：
    // 脚本自己编排，但每次 llm/tool 都经父进程代理 → 这里硬计数，超限即 reject（回退 builtin）。
    const limits = input.limits ?? {};
    let llmCalls = 0;
    let proxyToolCalls = 0;
    let totalTokens = 0;
    const budgetHit = (): string | null => {
      if (limits.maxRounds !== undefined && llmCalls > limits.maxRounds) {
        return `轮次闸：llm 调用 ${llmCalls} 次，超过上限 ${limits.maxRounds}`;
      }
      if (limits.maxToolCalls !== undefined && proxyToolCalls > limits.maxToolCalls) {
        return `工具调用闸：${proxyToolCalls} 次，超过上限 ${limits.maxToolCalls}`;
      }
      if (limits.maxTotalTokens !== undefined && totalTokens > limits.maxTotalTokens) {
        return `Token 闸：${totalTokens} tokens，超过上限 ${limits.maxTotalTokens}`;
      }
      return null;
    };


    const clearCallTimer = (id: number): void => {
      const timer = callTimers.get(id);
      if (timer) clearTimeout(timer);
      callTimers.delete(id);
    };

    const clearAllTimers = (): void => {
      if (startTimer) clearTimeout(startTimer);
      if (totalTimer) clearTimeout(totalTimer);
      for (const timer of callTimers.values()) clearTimeout(timer);
      callTimers.clear();
    };

    const cleanup = (): void => {
      clearAllTimers();
      try {
        rl?.close();
      } catch {
        // 已关闭
      }
      try {
        child.kill();
      } catch {
        // 已退出
      }
    };

    /** 终止并 reject（回退由 LoopRegistry 触发）。 */
    const finishFail = (message: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    };

    /** 正常收束：先 resolve 再清理（kill 会触发 exit，但 settled 已置位不会二次处理）。 */
    const finishOk = (outcome: ToolLoopOutcome): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };

    const send = (frame: Record<string, unknown>): void => {
      if (settled) return;
      try {
        child.stdin?.write(`${JSON.stringify(frame)}\n`);
      } catch (err) {
        finishFail(`脚本 loop 通信失败：${errorMessage(err)}`);
      }
    };

    const armCallTimer = (id: number, label: string): void => {
      clearCallTimer(id);
      const timer = setTimeout(() => {
        callTimers.delete(id);
        finishFail(`${label}（超过 ${callTimeoutMs}ms，代理调用未返回）`);
      }, callTimeoutMs);
      callTimers.set(id, timer);
    };

    const handleFrame = (frame: z.infer<typeof WorkerFrameSchema>): void => {
      switch (frame.type) {
        case "ready": {
          if (ready) return;
          ready = true;
          if (startTimer) clearTimeout(startTimer);
          send({
            type: "start",
            loopId: input.loopId,
            messages: input.messages ?? [],
            tools: input.tools ? [...input.tools()] : [],
            limits: input.limits ?? {},
          });
          return;
        }
        case "llm_request": {
          const id = frame.id;
          llmCalls += 1;
          const hit = budgetHit();
          if (hit) {
            finishFail(`脚本 loop 触发预算收束（${hit}）`);
            return;
          }
          const request: LlmRequest = {
            messages: (frame.request?.messages ?? []) as LlmMessage[],
            tools: frame.request?.tools as LlmRequest["tools"],
            maxTokens: frame.request?.maxTokens,
            reasoningEffort: frame.request?.reasoningEffort,
            signal: input.signal,
          };
          void (async () => {
            try {
              await input.pauseGate?.wait(input.signal);
              if (settled) return;
              armCallTimer(id, "LLM 代理超时");
              for await (const chunk of input.llm.invoke(request)) {
                if (settled) return;
                if ("tokens" in chunk && typeof chunk.tokens === "number") totalTokens += chunk.tokens;
                send({ type: "llm_chunk", id, chunk });
                const overBudget = budgetHit();
                if (overBudget) {
                  finishFail(`脚本 loop 触发预算收束（${overBudget}）`);
                  return;
                }
              }
              if (settled) return;
              clearCallTimer(id);
              send({ type: "llm_done", id });
            } catch (err) {
              if (settled) return;
              clearCallTimer(id);
              send({ type: "llm_error", id, message: errorMessage(err) });
            }
          })();
          return;
        }
        case "tool_call": {
          const id = frame.id;
          proxyToolCalls += 1;
          const hit = budgetHit();
          if (hit) {
            finishFail(`脚本 loop 触发预算收束（${hit}）`);
            return;
          }
          void (async () => {
            try {
              await input.pauseGate?.wait(input.signal);
              if (settled) return;
              armCallTimer(id, "工具代理超时");
              const result = await input.executeTool.invoke({
                id: frame.call.id,
                name: frame.call.name,
                args: frame.call.args,
              });
              if (settled) return;
              clearCallTimer(id);
              send({
                type: "tool_result",
                id,
                result: { ok: result.ok, content: result.content, error: result.error },
              });
            } catch (err) {
              if (settled) return;
              clearCallTimer(id);
              const message = errorMessage(err);
              send({
                type: "tool_result",
                id,
                result: { ok: false, content: `[工具代理异常] ${message}`, error: message },
              });
            }
          })();
          return;
        }
        case "emit": {
          if (!input.sink) return;
          input.sink({
            seq: seq++,
            type: normalizeEventType(frame.eventType),
            data: frame.payload,
            ts: Date.now(),
          });
          return;
        }
        case "outcome": {
          clearAllTimers();
          let outcome: ToolLoopOutcome;
          try {
            outcome = toOutcome(frame.outcome);
          } catch (err) {
            finishFail(errorMessage(err));
            return;
          }
          finishOk(outcome);
          return;
        }
        case "fatal": {
          finishFail(`脚本 loop 报错：${frame.message}`);
          return;
        }
        default:
          return;
      }
    };

    // 先起超时表：后续任何静态失败都能被 cleanup 清干净，不会留下悬空定时器。
    startTimer = setTimeout(() => {
      finishFail(`脚本 loop 启动超时（${startTimeoutMs}ms 内 worker 未就绪）`);
    }, startTimeoutMs);
    totalTimer = setTimeout(() => {
      finishFail(`脚本 loop 总超时（${totalTimeoutMs}ms）`);
    }, totalTimeoutMs);

    if (!child.stdout) {
      finishFail("脚本 loop 子进程没有 stdout，无法通信");
      return;
    }
    rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line: string) => {
      if (settled) return;
      const text = line.trim();
      if (!text) return;
      if (text.length > MAX_SCRIPT_FRAME_CHARS) {
        finishFail(`脚本 loop 单帧过大（${text.length} 字符），已终止`);
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text) as unknown;
      } catch {
        // 用户脚本可能 console.log 到 stdout：非 JSON 行忽略（不当协议错误），保留诊断
        stderrTail = (stderrTail + `\n[非协议输出] ${text.slice(0, 200)}`).slice(-4000);
        return;
      }
      const parsed = WorkerFrameSchema.safeParse(raw);
      if (!parsed.success) {
        // 未知/不合法的帧：忽略（前向兼容），真正失败靠崩溃/超时/缺 outcome 判定
        return;
      }
      handleFrame(parsed.data);
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrTail = (stderrTail + String(chunk)).slice(-4000);
    });
    child.on("error", (err: Error) => {
      finishFail(`脚本 loop 进程错误：${err.message}`);
    });
    child.on("exit", (code: number | null) => {
      if (settled) return;
      const tail = stderrTail.trim().split("\n").at(-1);
      finishFail(`脚本 loop 进程退出（code=${code === null ? "null" : code}）${tail ? `：${tail}` : ""}`);
    });
  });
}
