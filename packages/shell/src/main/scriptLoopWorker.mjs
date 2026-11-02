/**
 * L3 脚本 loop worker（由 scriptLoopHost.spawn 启动；不 import electron，不依赖 shell 代码）。
 * 用法：node scriptLoopWorker.mjs <loopDir> <scriptRel>
 *
 * 协议（stdin/stdout 行分隔 JSON）：
 *   parent → worker：{ type:"start", loopId, messages, tools, limits }
 *                    { type:"llm_chunk", id, chunk } / { type:"llm_done", id } / { type:"llm_error", id, message }
 *                    { type:"tool_result", id, result } / { type:"shutdown" }
 *   worker → parent：{ type:"ready" }
 *                    { type:"llm_request", id, request } / { type:"tool_call", id, call }
 *                    { type:"emit", eventType, payload } / { type:"outcome", outcome } / { type:"fatal", message }
 *
 * 用户脚本契约（ESM，默认 loop.mjs）：
 *   export async function run(ctx) {
 *     const stream = ctx.llm([{ role: "user", content: "…" }]);   // AsyncIterable<LlmChunk>
 *     for await (const chunk of stream) { if (chunk.kind === "text") … }
 *     const result = await ctx.executeTool("file_read", { path: "a.txt" });  // { ok, content, error? }
 *     ctx.emit("progress", { note: "…" });                                  // UI 时间线事件
 *     return { status: "done", reason: "…", finalText: "…", usage: { rounds: 1, toolCalls: 1 } };
 *   }
 * （也接受 `export default run`。）
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import util from "node:util";
import { pathToFileURL } from "node:url";

const [, , loopDirArg, scriptRelArg] = process.argv;

/** 已收束标记：收束后不再写任何帧（避免 parent 已 kill 后继续写导致 EPIPE）。 */
let closed = false;
/** JSON-RPC 请求序号（llm_request / tool_call 共用，worker 内部单调递增）。 */
let seq = 0;

/** @type {Map<number, ReturnType<typeof createStream>>} */
const llmStreams = new Map();
/** @type {Map<number, (result: any) => void>} */
const pendingTools = new Map();

/** 起始上下文：parent 收到 ready 后才下发（此时用户脚本已成功 import）。 */
let startCtx = { loopId: "", messages: [], tools: [], limits: {} };
let resolveStart = null;
const startPromise = new Promise((resolve) => {
  resolveStart = resolve;
});

function writeFrame(frame, onDone) {
  const text = `${JSON.stringify(frame)}\n`;
  try {
    process.stdout.write(text, onDone);
  } catch {
    onDone?.();
  }
}

function send(frame) {
  if (closed) return;
  writeFrame(frame);
}

/** 终帧：必须等 stdout 真正刷出后再退出（Windows 管道写是异步的，直接 exit 会截断）。 */
function sendAndExit(frame, code) {
  if (closed) {
    process.exit(code);
    return;
  }
  closed = true;
  writeFrame(frame, () => process.exit(code));
  // 兜底：写回调因管道异常不触发时也要退出，避免留下孤儿进程
  setTimeout(() => process.exit(code), 1000);
}

function fatal(message) {
  sendAndExit({ type: "fatal", message: String(message).slice(0, 4000) }, 1);
}

process.on("uncaughtException", (err) => fatal(`脚本未捕获异常：${err instanceof Error ? err.message : String(err)}`));
process.on("unhandledRejection", (err) => fatal(`脚本未处理 Promise 拒绝：${err instanceof Error ? err.message : String(err)}`));
// parent 先死（stdin 关闭）→ 自我了断，不留孤儿。
// 给 1s 宽限：启动瞬间的 EOF（如父进程写完后立刻关管道）不应抢在 boot/收束之前把进程杀掉。
process.stdin.on("end", () => {
  setTimeout(() => process.exit(0), 1000);
});

/**
 * 把用户脚本的 console.* 重定向到 stderr：
 * stdout 是协议通道，任何 console.log 都会破坏帧解析（parent 侧虽有容错，但这里直接根除）。
 */
for (const method of ["log", "info", "debug", "warn", "error"]) {
  console[method] = (...args) => {
    try {
      process.stderr.write(`${util.format(...args)}\n`);
    } catch {
      // stderr 也坏了：放弃输出
    }
  };
}

/** 单次 LLM 流：把 parent 回传的 chunk 变成 AsyncIterable。 */
function createStream() {
  /** @type {any[]} */
  const queue = [];
  let done = false;
  /** @type {Error | null} */
  let error = null;
  /** @type {null | (() => void)} */
  let wake = null;

  const notify = () => {
    if (!wake) return;
    const resume = wake;
    wake = null;
    resume();
  };

  return {
    push(chunk) {
      queue.push(chunk);
      notify();
    },
    close() {
      done = true;
      notify();
    },
    fail(err) {
      error = err instanceof Error ? err : new Error(String(err));
      done = true;
      notify();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queue.length > 0) {
          yield queue.shift();
          continue;
        }
        if (error) throw error;
        if (done) return;
        await new Promise((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

/** ctx.llm(messages, opts?) → AsyncIterable<LlmChunk>（由父进程代理真实模型）。 */
async function* llm(messages, opts = {}) {
  const id = ++seq;
  const stream = createStream();
  llmStreams.set(id, stream);
  send({
    type: "llm_request",
    id,
    request: {
      messages: Array.isArray(messages) ? messages : [],
      tools: Array.isArray(opts.tools) ? opts.tools : undefined,
      maxTokens: typeof opts.maxTokens === "number" ? opts.maxTokens : undefined,
      reasoningEffort: typeof opts.reasoningEffort === "string" ? opts.reasoningEffort : undefined,
    },
  });
  try {
    yield* stream;
  } finally {
    llmStreams.delete(id);
  }
}

/** ctx.executeTool(name, args) → Promise<ToolResult>（父进程做权限判定后执行）。 */
function executeTool(name, args) {
  const id = ++seq;
  return new Promise((resolve) => {
    pendingTools.set(id, resolve);
    send({ type: "tool_call", id, call: { id: `script_${id}`, name: String(name), args } });
  });
}

/** ctx.emit(type, payload)：progress/chunk/tool… 事件进 sink（done/error 由宿主统一发）。 */
function emit(type, payload) {
  send({ type: "emit", eventType: String(type ?? "progress").slice(0, 40), payload });
}

const STATUSES = new Set(["done", "budget", "aborted", "silent", "no-progress", "error"]);

/** 把脚本返回的 outcome 归一成宿主可校验的形状（未知字段丢弃，数值兜底 0）。 */
function normalizeOutcome(raw) {
  const outcome = raw && typeof raw === "object" ? raw : {};
  const usageRaw = outcome.usage && typeof outcome.usage === "object" ? outcome.usage : {};
  const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const validStatus = typeof outcome.status === "string" && STATUSES.has(outcome.status);
  const status = validStatus ? outcome.status : "error";
  const reason =
    typeof outcome.reason === "string" && outcome.reason
      ? outcome.reason
      : validStatus
        ? `脚本 loop 返回 ${status}`
        : `脚本 loop 返回非法 status（${String(outcome.status)}），按 error 处理`;
  return {
    status,
    reason: reason.slice(0, 4000),
    finalText: typeof outcome.finalText === "string" ? outcome.finalText : "",
    usage: {
      rounds: num(usageRaw.rounds),
      toolCalls: num(usageRaw.toolCalls),
      totalTokens: num(usageRaw.totalTokens),
      wallClockMs: num(usageRaw.wallClockMs),
    },
  };
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "start": {
      startCtx = {
        loopId: typeof msg.loopId === "string" ? msg.loopId : "",
        messages: Array.isArray(msg.messages) ? msg.messages : [],
        tools: Array.isArray(msg.tools) ? msg.tools : [],
        limits: msg.limits && typeof msg.limits === "object" ? msg.limits : {},
      };
      if (resolveStart) {
        const resume = resolveStart;
        resolveStart = null;
        resume();
      }
      break;
    }
    case "llm_chunk": {
      llmStreams.get(msg.id)?.push(msg.chunk);
      break;
    }
    case "llm_done": {
      llmStreams.get(msg.id)?.close();
      break;
    }
    case "llm_error": {
      llmStreams.get(msg.id)?.fail(msg.message ?? "LLM 代理失败");
      break;
    }
    case "tool_result": {
      const resolve = pendingTools.get(msg.id);
      if (!resolve) break;
      pendingTools.delete(msg.id);
      const result = msg.result && typeof msg.result === "object" ? msg.result : {};
      resolve({
        ok: result.ok !== false,
        content: typeof result.content === "string" ? result.content : "",
        error: typeof result.error === "string" ? result.error : undefined,
      });
      break;
    }
    case "shutdown": {
      process.exit(0);
      break;
    }
    default:
      break;
  }
});

async function boot() {
  if (!loopDirArg || !scriptRelArg) {
    fatal("缺少 loop 目录或脚本文件参数");
    return;
  }
  const loopDir = path.resolve(loopDirArg);
  const scriptRel = scriptRelArg;
  if (path.isAbsolute(scriptRel) || scriptRel.split(/[\\/]/).includes("..")) {
    fatal(`脚本必须是 loop 目录内的相对路径：${scriptRel}`);
    return;
  }
  const entry = path.resolve(loopDir, scriptRel);
  if (!(entry === loopDir || entry.startsWith(loopDir + path.sep))) {
    fatal(`脚本必须位于 loop 目录内：${scriptRel}`);
    return;
  }
  if (!fs.existsSync(entry)) {
    fatal(`脚本不存在：${scriptRel}`);
    return;
  }

  let mod;
  try {
    mod = await import(pathToFileURL(entry).href);
  } catch (err) {
    fatal(`脚本 import 失败：${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const run =
    typeof mod.run === "function" ? mod.run : typeof mod.default === "function" ? mod.default : null;
  if (!run) {
    fatal("脚本缺少 run(ctx) 导出（或 default 函数）");
    return;
  }

  send({ type: "ready" });
  await startPromise;

  const ctx = {
    loopId: startCtx.loopId,
    loopDir,
    get messages() {
      return startCtx.messages;
    },
    get tools() {
      return startCtx.tools;
    },
    get limits() {
      return startCtx.limits;
    },
    llm,
    executeTool,
    emit,
  };

  let outcome;
  try {
    outcome = await run(ctx);
  } catch (err) {
    fatal(`脚本 run(ctx) 抛错：${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  sendAndExit({ type: "outcome", outcome: normalizeOutcome(outcome) }, 0);
}

boot().catch((err) => fatal(`脚本 loop worker 启动失败：${err instanceof Error ? err.message : String(err)}`));
