/**
 * 插件运行时（壳层，ADR-0011「万物皆插件」）：每个「已启用且声明 main」的插件一个隔离子进程。
 *
 * 为什么走子进程：插件是第三方代码，崩溃/死循环/阻塞 stdout 不能拖垮主进程（隔离优先），
 * 与 extensionRuntime 同一思路；但生命周期来源是 PluginStore（builtin/user 插件、启用状态）。
 *
 * 协议：复用 core/extensionWorker 的 stdin/stdout 行分隔 JSON 契约
 *   worker → 父：ready{tools} / result{id,ok,content,error} / fatal{message} / log{message}
 *   父 → worker：call{id,tool,args} / shutdown
 * 差异只在：工具注册名 `plugin__<id>__<tool>`、权限取插件声明、冲突 fail-closed 不覆盖。
 *
 * 安全：子进程 env 走白名单（不继承 API key/token 等敏感环境变量）；
 *      启动 8s / 调用 20s 超时；崩溃只影响该插件（精确注销它的工具）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { z } from "zod";
import { parseWorkerLine, type ExtensionToolDef, type ParentToWorker } from "loopsoar-core/extensionWorker";
import type { ToolDefinition, ToolRegistry, ToolResult } from "loopsoar-core/tools/registry";
import type { PluginEntry, PluginStore } from "./pluginStore.js";

export type PluginRuntimeState = "idle" | "starting" | "ready" | "error";

/** 面向 UI 的工具摘要（短名，不含 plugin__ 前缀）。 */
export interface PluginToolInfo {
  name: string;
  description?: string;
}

export interface PluginRuntimeStatus {
  state: PluginRuntimeState;
  /** 已注册进 ToolRegistry 的完整工具名（注销依据）。 */
  tools: string[];
  /** 插件声明的原始工具名 + 描述（UI 展示用）。 */
  toolInfos: PluginToolInfo[];
  error?: string;
}

/** 子进程最小接口：测试可注入 fake spawn（PassThrough 流 + 手动触发 exit/error）。 */
export interface PluginChild {
  stdin: { write(chunk: string): unknown };
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals): boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export type PluginSpawn = (
  command: string,
  args: string[],
  options: {
    stdio: ["pipe", "pipe", "pipe"];
    env: NodeJS.ProcessEnv;
    windowsHide: boolean;
  },
) => PluginChild;

const START_TIMEOUT_MS = 8_000;
const CALL_TIMEOUT_MS = 20_000;
/** 单插件工具上限：防止一个插件把工具表塞爆（模型上下文与沙箱同步都按工具数线性膨胀）。 */
const MAX_TOOLS_PER_PLUGIN = 64;
/** 每个插件保留的日志行数（stderr/log 环形缓冲，只用于错误展示）。 */
const MAX_LOG_LINES = 20;

/**
 * worker 环境变量白名单（小写比较）：PATH/SystemRoot/TEMP 等启动必需项。
 * 为什么不直接继承 process.env：主进程环境里可能有 API key / token / 代理凭据，
 * 第三方插件代码不应因此拿到本机机密（fail-closed）。
 */
const WORKER_ENV_ALLOWLIST = new Set([
  "path",
  "pathext",
  "systemroot",
  "systemdrive",
  "windir",
  "comspec",
  "temp",
  "tmp",
  "userprofile",
  "homedrive",
  "homepath",
  "home",
  "appdata",
  "localappdata",
  "lang",
  "lc_all",
  "shell",
  "term",
  "number_of_processors",
  "processor_architecture",
  "os",
]);

export function buildPluginWorkerEnv(pluginId: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (typeof value !== "string") continue;
    if (WORKER_ENV_ALLOWLIST.has(key.toLowerCase())) env[key] = value;
  }
  env.ELECTRON_RUN_AS_NODE = "1";
  env.LOOPSOAR_PLUGIN_ID = pluginId;
  return env;
}

/** 插件工具在全局工具表里的注册名：plugin__<pluginId>__<toolName>（只含模型/契约安全字符）。 */
export function pluginToolRegistryName(pluginId: string, toolName: string): string {
  const safeId = pluginId.replace(/[^a-zA-Z0-9_-]/g, "-");
  const safeTool = toolName.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `plugin__${safeId}__${safeTool}`;
}

interface PendingCall {
  resolve: (result: ToolResult) => void;
  timer: NodeJS.Timeout;
}

interface PluginRun {
  pluginId: string;
  child: PluginChild;
  ready: boolean;
  tools: string[];
  toolInfos: PluginToolInfo[];
  nextId: number;
  pending: Map<number, PendingCall>;
  log: string[];
  /** fail-closed 跳过注册的工具名/原因（ready 后作为 error 暴露给 UI/诊断）。 */
  conflicts: string[];
}

export interface PluginRuntimeOptions {
  plugins: PluginStore;
  registry: ToolRegistry;
  /** worker 脚本绝对路径（开发态 src，打包态 dist）。 */
  workerPath: string;
  onUpdate?: (id: string, status: PluginRuntimeStatus) => void;
  /** 工具集变化（注册/注销）后回调：壳层刷新沙箱已知工具。 */
  onToolsChanged?: () => void;
  startTimeoutMs?: number;
  callTimeoutMs?: number;
  /** 测试注入（默认 node:child_process.spawn）；返回对象需兼容 PluginChild。 */
  spawn?: PluginSpawn;
}

export class PluginRuntime {
  private runs = new Map<string, PluginRun>();
  private statusMap = new Map<string, PluginRuntimeStatus>();

  constructor(private opts: PluginRuntimeOptions) {}

  /** 单个插件运行状态（未运行 = idle；error 状态会保留到下次 start/stop）。 */
  status(id: string): PluginRuntimeStatus {
    const run = this.runs.get(id);
    if (run) {
      return {
        state: run.ready ? "ready" : "starting",
        tools: [...run.tools],
        toolInfos: run.toolInfos.map((info) => ({ ...info })),
        error: run.ready && run.conflicts.length > 0 ? `工具名冲突（fail-closed 未覆盖）：${run.conflicts.join("；")}` : run.log.at(-1),
      };
    }
    const saved = this.statusMap.get(id);
    return saved ? { ...saved, tools: [...saved.tools], toolInfos: saved.toolInfos.map((i) => ({ ...i })) } : { state: "idle", tools: [], toolInfos: [] };
  }

  /** 全部插件状态（key=插件 id；供域把 store 与 runtime 合并成 UI 数据）。 */
  statuses(): Record<string, PluginRuntimeStatus> {
    const out: Record<string, PluginRuntimeStatus> = {};
    for (const entry of this.opts.plugins.list()) out[entry.id] = this.status(entry.id);
    return out;
  }

  /**
   * 启动插件（幂等：已运行先停再启）。返回最终状态（不抛：启动失败以 state=error 返回）。
   * 纯声明式插件（无 main）不拉进程，直接记 idle。
   */
  async start(id: string): Promise<PluginRuntimeStatus> {
    const entry = this.opts.plugins.get(id);
    if (!entry) return this.setStatus(id, { state: "error", tools: [], toolInfos: [], error: `插件不存在：${id}` });
    if (!entry.enabled) return this.setStatus(id, { state: "idle", tools: [], toolInfos: [] });
    if (!entry.main) {
      // 纯声明式插件（只贡献清单/规则，不提供运行时代码）：保持 idle，不视为错误
      return this.setStatus(id, { state: "idle", tools: [], toolInfos: [] });
    }
    if (!entry.dir) return this.setStatus(id, { state: "error", tools: [], toolInfos: [], error: "插件目录缺失（builtin 不应声明 main）" });
    // 入口文件必须真实存在：否则子进程一定失败，提前给出可读原因（fail-closed，不盲起进程）
    if (!fs.existsSync(path.join(entry.dir, entry.main))) {
      return this.setStatus(id, { state: "error", tools: [], toolInfos: [], error: `插件入口不存在：${entry.main}` });
    }
    if (!fs.existsSync(this.opts.workerPath)) {
      return this.setStatus(id, { state: "error", tools: [], toolInfos: [], error: `插件 worker 脚本缺失：${this.opts.workerPath}` });
    }
    this.stop(id);
    const spawnImpl: PluginSpawn = this.opts.spawn ?? ((command, args, options) => spawn(command, args, options) as unknown as PluginChild);
    let child: PluginChild;
    try {
      child = spawnImpl(process.execPath, [this.opts.workerPath, entry.dir, entry.main], {
        stdio: ["pipe", "pipe", "pipe"],
        env: buildPluginWorkerEnv(id),
        windowsHide: true,
      });
    } catch (err) {
      return this.setStatus(id, {
        state: "error",
        tools: [],
        toolInfos: [],
        error: `插件进程启动失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
    const run: PluginRun = {
      pluginId: id,
      child,
      ready: false,
      tools: [],
      toolInfos: [],
      nextId: 0,
      pending: new Map(),
      log: [],
      conflicts: [],
    };
    this.runs.set(id, run);
    this.setStatus(id, { state: "starting", tools: [], toolInfos: [] });

    return await new Promise<PluginRuntimeStatus>((resolve) => {
      let settled = false;
      const startTimer = setTimeout(() => {
        this.teardown(id, run);
        finish({ state: "error", tools: [], toolInfos: [], error: `插件启动超时（${this.opts.startTimeoutMs ?? START_TIMEOUT_MS}ms）` });
      }, this.opts.startTimeoutMs ?? START_TIMEOUT_MS);
      const finish = (status: PluginRuntimeStatus): void => {
        if (settled) return;
        settled = true;
        clearTimeout(startTimer);
        resolve(this.setStatus(id, status));
      };

      readline.createInterface({ input: child.stdout }).on("line", (line) => {
        const message = parseWorkerLine(line);
        if (!message) return;
        if (message.type === "ready") {
          run.ready = true;
          this.registerTools(entry, run, message.tools);
          finish(this.readyStatus(run));
          return;
        }
        if (message.type === "result") {
          const pending = run.pending.get(message.id);
          if (!pending) return;
          run.pending.delete(message.id);
          clearTimeout(pending.timer);
          pending.resolve({ ok: message.ok, content: message.content ?? "", error: message.error });
          return;
        }
        if (message.type === "fatal") {
          this.pushLog(run, message.message);
          if (!settled) {
            this.teardown(id, run);
            finish({ state: "error", tools: [], toolInfos: [], error: message.message });
          } else {
            this.failRun(id, run, message.message);
          }
          return;
        }
        if (message.type === "log") this.pushLog(run, message.message);
      });

      child.stderr.on("data", (chunk: Buffer | string) => {
        const text = String(chunk).trim();
        if (text) this.pushLog(run, text.slice(0, 500));
      });
      child.on("error", (err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.pushLog(run, message);
        if (!settled) {
          this.teardown(id, run);
          finish({ state: "error", tools: [], toolInfos: [], error: message });
        } else {
          this.failRun(id, run, message);
        }
      });
      child.on("exit", (code) => {
        if (this.runs.get(id) !== run) return; // 主动停止
        const message = `插件进程退出（code=${String(code ?? "null")}）${run.log.at(-1) ? `：${run.log.at(-1)}` : ""}`;
        if (!settled) finish({ state: "error", tools: [], toolInfos: [], error: message });
        else this.failRun(id, run, message);
      });
    });
  }

  /** 停止插件并精确注销其工具（幂等）；error 状态保留（下次启动/重扫才清）。 */
  stop(id: string): PluginRuntimeStatus {
    const run = this.runs.get(id);
    if (run) this.teardown(id, run);
    if (this.statusMap.get(id)?.state !== "error") {
      this.setStatus(id, { state: "idle", tools: [], toolInfos: [] });
    }
    return this.status(id);
  }

  /** 停止全部插件（退出清理用）。 */
  stopAll(): void {
    for (const id of [...this.runs.keys()]) this.stop(id);
  }

  /** 启动所有「已启用且声明 main」的插件（单个失败不影响其它）。 */
  async startEnabled(): Promise<void> {
    const entries = this.opts.plugins.list().filter((entry) => entry.enabled && entry.main);
    await Promise.all(entries.map((entry) => this.start(entry.id).catch(() => undefined)));
  }

  /** 与磁盘/启用状态重新对齐：全停 → 按当前清单启动（reload 用）。 */
  async sync(): Promise<void> {
    this.stopAll();
    this.statusMap.clear();
    await this.startEnabled();
  }

  private readyStatus(run: PluginRun): PluginRuntimeStatus {
    return {
      state: "ready",
      tools: [...run.tools],
      toolInfos: run.toolInfos.map((info) => ({ ...info })),
      ...(run.conflicts.length > 0 ? { error: `工具名冲突（fail-closed 未覆盖）：${run.conflicts.join("；")}` } : {}),
    };
  }

  /** 把 worker 上报的工具桥接进 ToolRegistry；冲突/重名/超限一律跳过并记原因（绝不覆盖已有工具）。 */
  private registerTools(entry: PluginEntry, run: PluginRun, defs: ExtensionToolDef[]): void {
    const seen = new Set<string>();
    for (const def of Array.isArray(defs) ? defs : []) {
      if (!def || typeof def.name !== "string" || !def.name.trim()) continue;
      if (run.tools.length >= MAX_TOOLS_PER_PLUGIN) {
        run.conflicts.push(`超过单插件工具上限 ${MAX_TOOLS_PER_PLUGIN}：${def.name}`);
        continue;
      }
      const registryName = pluginToolRegistryName(entry.id, def.name);
      if (seen.has(registryName)) {
        run.conflicts.push(`插件内工具重名：${def.name}`);
        continue;
      }
      seen.add(registryName);
      if (this.opts.registry.has(registryName)) {
        // fail-closed：绝不静默覆盖（可能是另一个插件/内置工具先注册）
        run.conflicts.push(`工具名已存在：${registryName}`);
        continue;
      }
      const definition: ToolDefinition = {
        name: registryName,
        description: def.description ?? `插件 ${entry.id} 提供的工具：${def.name}`,
        permissions: def.permissions ?? {},
        schema: z.any(),
        parameters: def.parameters,
        execute: async (ctx) => this.call(entry.id, def.name, ctx.params),
      };
      try {
        this.opts.registry.register(definition);
        run.tools.push(registryName);
        run.toolInfos.push({ name: def.name, ...(def.description ? { description: def.description } : {}) });
      } catch (err) {
        run.conflicts.push(`注册失败 ${registryName}：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.opts.onToolsChanged?.();
  }

  private call(id: string, tool: string, args: unknown): Promise<ToolResult> {
    const run = this.runs.get(id);
    if (!run || !run.ready) return Promise.resolve({ ok: false, content: `[插件未运行] ${id}` });
    const callId = ++run.nextId;
    return new Promise<ToolResult>((resolve) => {
      const timeoutMs = this.opts.callTimeoutMs ?? CALL_TIMEOUT_MS;
      const timer = setTimeout(() => {
        run.pending.delete(callId);
        resolve({ ok: false, content: `[插件执行超时] ${tool} 超过 ${timeoutMs}ms` });
      }, timeoutMs);
      run.pending.set(callId, { resolve, timer });
      try {
        const message: ParentToWorker = { type: "call", id: callId, tool, args };
        run.child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (err) {
        clearTimeout(timer);
        run.pending.delete(callId);
        resolve({ ok: false, content: `[插件通信失败] ${err instanceof Error ? err.message : String(err)}` });
      }
    });
  }

  private pushLog(run: PluginRun, message: string): void {
    run.log.push(message);
    if (run.log.length > MAX_LOG_LINES) run.log.splice(0, run.log.length - MAX_LOG_LINES);
  }

  private failRun(id: string, run: PluginRun, message: string): void {
    if (this.runs.get(id) !== run) return;
    this.unregisterTools(run);
    for (const pending of run.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, content: `[插件已退出] ${message}` });
    }
    run.pending.clear();
    this.runs.delete(id);
    this.setStatus(id, { state: "error", tools: [], toolInfos: [], error: message });
    try {
      run.child.kill();
    } catch {
      // 已退出
    }
  }

  private teardown(id: string, run: PluginRun): void {
    if (this.runs.get(id) === run) this.runs.delete(id);
    this.unregisterTools(run);
    for (const pending of run.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, content: "[插件已停止]" });
    }
    run.pending.clear();
    try {
      run.child.stdin.write(`${JSON.stringify({ type: "shutdown" } satisfies ParentToWorker)}\n`);
    } catch {
      // stdin 已关闭
    }
    setTimeout(() => {
      try {
        run.child.kill();
      } catch {
        // 已退出
      }
    }, 300).unref();
  }

  /** 精确注销本 run 注册过的工具（按名字，不误删其它插件的工具）。 */
  private unregisterTools(run: PluginRun): void {
    const hadTools = run.tools.length > 0;
    for (const toolName of run.tools) this.opts.registry.unregister(toolName);
    run.tools = [];
    run.toolInfos = [];
    if (hadTools) this.opts.onToolsChanged?.();
  }

  private setStatus(id: string, status: PluginRuntimeStatus): PluginRuntimeStatus {
    console.log(`[Loopsoar] 插件运行时 ${id}: ${status.state}${status.error ? `（${status.error}）` : ""}`);
    this.statusMap.set(id, status);
    this.opts.onUpdate?.(id, status);
    return status;
  }
}

/** 解析 pluginWorker.mjs 的绝对路径（开发态 src / 打包态 dist 两种目录深度）。 */
export function resolvePluginWorkerPath(baseDir: string): string {
  const candidates = [
    path.join(baseDir, "pluginWorker.mjs"),
    path.join(baseDir, "../src/main/pluginWorker.mjs"),
    path.join(baseDir, "../../src/main/pluginWorker.mjs"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}
