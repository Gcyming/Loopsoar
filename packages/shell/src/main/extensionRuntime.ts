/**
 * 扩展运行时（壳层）：为每个启用的本地扩展拉起一个隔离的子进程 worker。
 *
 * 设计要点（AD第十条精神：扩展是第三方代码，不能污染主进程）：
 *   · 独立进程 + stdin/stdout 行分隔 JSON-RPC（见 core/extensionWorker）；
 *   · 工具桥接进 ToolRegistry：ext__<extId>__<toolName>，权限按扩展声明映射，仍走沙箱/确认；
 *   · 启动超时 8s、调用超时 20s；崩溃/退出 → 注销工具 + 标记 error，不影响其它扩展；
 *   · 工具名冲突 fail-closed（不覆盖已有工具），冲突原因写进状态 error 供 UI/诊断；
 *   · 子进程 env 走白名单（不继承 API key/token 等主进程机密）；
 *   · 运行状态只读暴露给 UI（state/tools/error），不提供任意代码执行通道。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { z } from "zod";
import {
  extensionToolRegistryName,
  parseWorkerLine,
  type ExtensionToolDef,
  type ParentToWorker,
} from "loopsoar-core/extensionWorker";
import type { ToolDefinition, ToolRegistry, ToolResult } from "loopsoar-core/tools/registry";
import type { ExtensionHost } from "./extensions.js";
import { resolveExtensionToolPermissions, type InstalledExtension } from "loopsoar-core/extension";

export type ExtensionRuntimeState = "idle" | "starting" | "ready" | "error";

export interface ExtensionRuntimeStatus {
  state: ExtensionRuntimeState;
  tools: string[];
  error?: string;
  /** 纯声明式扩展（无 main）：不起进程，只有贡献点。 */
  declarative?: boolean;
  /** worker 实际注册的事件（诊断用）。 */
  events?: string[];
  /** 已协商的 worker 协议版本。 */
  protocol?: number;
}

/** 子进程最小接口：测试可注入 fake spawn（PassThrough 流 + 手动触发 exit/error）。 */
export interface ExtensionChild {
  stdin: { write(chunk: string): unknown };
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals): boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export type ExtensionSpawn = (
  command: string,
  args: string[],
  options: {
    stdio: ["pipe", "pipe", "pipe"];
    env: NodeJS.ProcessEnv;
    windowsHide: boolean;
  },
) => ExtensionChild;

/**
 * worker 环境变量白名单（小写比较）：PATH/SystemRoot/TEMP 等启动必需项。
 * 为什么不直接继承 process.env：主进程环境里可能有 API key/token/代理凭据，
 * 第三方扩展代码不应因此拿到本机机密（fail-closed）。
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

export function buildExtensionWorkerEnv(extensionId: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (typeof value !== "string") continue;
    if (WORKER_ENV_ALLOWLIST.has(key.toLowerCase())) env[key] = value;
  }
  env.ELECTRON_RUN_AS_NODE = "1";
  env.LOOPSOAR_EXTENSION_ID = extensionId;
  return env;
}

interface PendingCall {
  resolve: (result: ToolResult) => void;
  timer: NodeJS.Timeout;
}

interface EventOutcome {
  allow?: boolean;
  reason?: string;
  result?: unknown;
  error?: string;
}

interface PendingEvent {
  resolve: (outcome: EventOutcome) => void;
  timer: NodeJS.Timeout;
}

interface ExtensionRun {
  extensionId: string;
  child: ExtensionChild;
  ready: boolean;
  tools: string[];
  nextId: number;
  pending: Map<number, PendingCall>;
  pendingEvents: Map<number, PendingEvent>;
  stderrRing: string[];
  /** fail-closed 跳过注册的工具名/原因（ready 后写入状态 error）。 */
  conflicts: string[];
  protocol: number;
  /** worker 实际注册的事件。 */
  events: string[];
  /** 宿主声明的事件（用于派发过滤）。 */
  declaredEvents: string[];
}

const START_TIMEOUT_MS = 8_000;
const CALL_TIMEOUT_MS = 20_000;

export class ExtensionRuntime {
  private runs = new Map<string, ExtensionRun>();
  private statusMap = new Map<string, ExtensionRuntimeStatus>();

  constructor(
    private opts: {
      extensions: ExtensionHost;
      registry: ToolRegistry;
      /** worker 脚本绝对路径（开发态 src，打包态 dist）。 */
      workerPath: string;
      onUpdate?: (id: string, status: ExtensionRuntimeStatus) => void;
      /** 工具集变化（注册/注销）后回调：壳层刷新沙箱已知工具。 */
      onToolsChanged?: () => void;
      /** 启动超时（默认 8000ms；测试可调小）。 */
      timeoutMs?: number;
      /** 调用超时（默认 20000ms；测试可调小）。 */
      callTimeoutMs?: number;
      /** 事件钩子超时（默认 5000ms；超时按 allow 处理，不阻塞主流程）。 */
      eventTimeoutMs?: number;
      /** 扩展 worker → 自身富 UI 视图的消息（按 extensionId/viewId 路由）。 */
      onViewMessage?: (id: string, viewId: string, message: unknown) => void;
      /** 测试注入（默认 node:child_process.spawn）。 */
      spawn?: ExtensionSpawn;
      /**
       * 崩溃/超时后自动重启（默认 true；测试可关）。最多连续 3 次，退避 1s/5s/15s；
       * 超过上限保持 error，交给用户手动重试，避免坏扩展无限拉起。
       */
      autoRestart?: boolean;
    },
  ) {}

  private restartTimers = new Map<string, NodeJS.Timeout>();
  /** 连续失败计数：5 分钟内累计，成功 ready 不清零（防「一启动就崩」无限重启）。 */
  private failures = new Map<string, { count: number; lastAt: number }>();

  status(id: string): ExtensionRuntimeStatus {
    const run = this.runs.get(id);
    if (run) {
      return {
        state: run.ready ? "ready" : "starting",
        tools: [...run.tools],
        ...(run.events.length > 0 ? { events: [...run.events] } : {}),
        protocol: run.protocol,
        // 冲突原因优先于最后一行日志：loadFailed 展示时用户才能知道「为什么少了工具」
        error: run.ready && run.conflicts.length > 0 ? `扩展工具未注册（fail-closed）：${run.conflicts.join("；")}` : run.stderrRing.at(-1),
      };
    }
    return this.statusMap.get(id) ?? { state: "idle", tools: [] };
  }

  statuses(): Record<string, ExtensionRuntimeStatus> {
    const out: Record<string, ExtensionRuntimeStatus> = {};
    for (const item of this.opts.extensions.list()) out[item.manifest.id] = this.status(item.manifest.id);
    return out;
  }

  /** 启动扩展（幂等：已启动先停）。返回最终状态。 */
  async start(id: string): Promise<ExtensionRuntimeStatus> {
    const item = this.opts.extensions.list().find((candidate) => candidate.manifest.id === id);
    if (!item) return this.setStatus(id, { state: "error", tools: [], error: `扩展不存在：${id}` });
    if (item.info?.certification === "blocked") {
      return this.setStatus(id, {
        state: "error",
        tools: [],
        error: `扩展认证未通过（${item.info.dependencies.issues[0] ?? item.info.compatibility.issues[0]?.message ?? "blocked"}）`,
      });
    }
    const main = item.manifest.main?.trim();
    if (!main) {
      // 纯声明式扩展：没有代码可跑，贡献点已经由 ExtensionContributions 注册。
      this.stop(id);
      return this.setStatus(id, { state: "ready", tools: [], declarative: true });
    }
    // 入口必须位于扩展目录内且真实存在：提前给出可读原因（worker 侧也有一层防线，这里避免盲起进程）
    const entryPath = path.resolve(item.dir, main);
    const dirPath = path.resolve(item.dir);
    if (entryPath !== dirPath && !entryPath.startsWith(dirPath + path.sep)) {
      return this.setStatus(id, { state: "error", tools: [], error: `扩展入口越界（必须在扩展目录内）：${main}` });
    }
    if (!fs.existsSync(entryPath)) {
      return this.setStatus(id, { state: "error", tools: [], error: `扩展入口不存在：${main}` });
    }
    if (!fs.existsSync(this.opts.workerPath)) {
      return this.setStatus(id, { state: "error", tools: [], error: `worker 脚本缺失：${this.opts.workerPath}` });
    }
    this.stop(id);
    const spawnImpl: ExtensionSpawn =
      this.opts.spawn ?? ((command, args, options) => spawn(command, args, options) as unknown as ExtensionChild);
    const child = spawnImpl(process.execPath, extensionSpawnArgs(item, this.opts.workerPath), {
      stdio: ["pipe", "pipe", "pipe"],
      env: buildExtensionWorkerEnv(id),
      windowsHide: true,
    });
    const run: ExtensionRun = {
      extensionId: id,
      child,
      ready: false,
      tools: [],
      nextId: 0,
      pending: new Map(),
      pendingEvents: new Map(),
      stderrRing: [],
      conflicts: [],
      protocol: 1,
      events: [],
      declaredEvents: [...(item.manifest.events ?? [])],
    };
    this.runs.set(id, run);
    this.setStatus(id, { state: "starting", tools: [] });

    return await new Promise<ExtensionRuntimeStatus>((resolve) => {
      let settled = false;
      const finish = (status: ExtensionRuntimeStatus): void => {
        if (settled) return;
        settled = true;
        clearTimeout(startTimer);
        resolve(this.setStatus(id, status));
      };
      const startTimer = setTimeout(() => {
        this.teardown(id, run);
        finish({ state: "error", tools: [], error: `扩展启动超时（${this.opts.timeoutMs ?? START_TIMEOUT_MS}ms）` });
      }, this.opts.timeoutMs ?? START_TIMEOUT_MS);

      readline.createInterface({ input: child.stdout }).on("line", (line) => {
        const message = parseWorkerLine(line);
        if (!message) return;
        if (message.type === "ready") {
          const protocol = message.protocol ?? 1;
          run.protocol = protocol;
          run.events = message.events ?? [];
          if (run.declaredEvents.length > 0 && protocol < 2) {
            this.teardown(id, run);
            finish({
              state: "error",
              tools: [],
              error: `扩展声明了 events，但 worker 协议为 ${protocol}（需要 2）；请升级扩展的 worker 模板`,
            });
            return;
          }
          const missingEvents = run.declaredEvents.filter((event) => !run.events.includes(event));
          if (missingEvents.length > 0) {
            this.teardown(id, run);
            finish({
              state: "error",
              tools: [],
              error: `worker 未注册 manifest 声明的事件：${missingEvents.join("、")}`,
            });
            return;
          }
          run.ready = true;
          this.registerTools(item, run, message.tools);
          finish({
            state: "ready",
            tools: [...run.tools],
            protocol,
            ...(run.events.length > 0 ? { events: [...run.events] } : {}),
            // 有冲突仍算 ready（其余工具可用），但必须让 UI 可见「被 fail-closed 跳过了什么」
            ...(run.conflicts.length > 0 ? { error: `扩展工具未注册（fail-closed）：${run.conflicts.join("；")}` } : {}),
          });
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
        if (message.type === "eventResult") {
          const pending = run.pendingEvents.get(message.id);
          if (!pending) return;
          run.pendingEvents.delete(message.id);
          clearTimeout(pending.timer);
          pending.resolve({
            ...(message.allow !== undefined ? { allow: message.allow } : {}),
            ...(message.reason ? { reason: message.reason } : {}),
            ...(message.result !== undefined ? { result: message.result } : {}),
            ...(message.ok ? {} : { error: message.error ?? "事件钩子失败" }),
          });
          return;
        }
        if (message.type === "viewMessage") {
          this.opts.onViewMessage?.(id, message.viewId, message.message);
          return;
        }
        if (message.type === "fatal") {
          run.stderrRing.push(message.message);
          if (!settled) {
            this.teardown(id, run);
            finish({ state: "error", tools: [], error: message.message });
          } else {
            this.failRun(id, run, message.message);
          }
          return;
        }
        if (message.type === "log") run.stderrRing.push(message.message);
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8").trim();
        if (text) run.stderrRing.push(text.slice(0, 500));
      });
      child.on("error", (err) => {
        const message = err instanceof Error ? err.message : String(err);
        run.stderrRing.push(message);
        if (!settled) {
          this.teardown(id, run);
          finish({ state: "error", tools: [], error: message });
        } else {
          this.failRun(id, run, message);
        }
      });
      child.on("exit", (code) => {
        if (this.runs.get(id) !== run) return; // 主动停止
        const message = `扩展进程退出（code=${code ?? "null"}）${run.stderrRing.at(-1) ? `：${run.stderrRing.at(-1)}` : ""}`;
        if (!settled) finish({ state: "error", tools: [], error: message });
        else this.failRun(id, run, message);
      });
    });
  }

  /** 停止扩展并注销其工具（幂等）。 */
  stop(id: string): ExtensionRuntimeStatus {
    const pendingRestart = this.restartTimers.get(id);
    if (pendingRestart) {
      clearTimeout(pendingRestart);
      this.restartTimers.delete(id);
    }
    this.failures.delete(id);
    const run = this.runs.get(id);
    if (run) this.teardown(id, run);
    if (this.statusMap.get(id)?.state !== "error") {
      this.setStatus(id, { state: "idle", tools: [] });
    }
    return this.status(id);
  }

  stopAll(): void {
    for (const id of new Set([...this.runs.keys(), ...this.restartTimers.keys()])) this.stop(id);
  }

  /** 启动所有已启用的扩展（启动失败互相隔离；纯声明式扩展只标记 ready）。 */
  async startEnabled(): Promise<void> {
    const items = this.opts.extensions.list().filter((item) => item.enabled);
    await Promise.all(items.map((item) => this.start(item.manifest.id).catch(() => undefined)));
  }

  private registerTools(item: InstalledExtension, run: ExtensionRun, defs: ExtensionToolDef[]): void {
    const seen = new Set<string>();
    for (const def of defs) {
      if (!def || typeof def.name !== "string" || !def.name.trim()) continue;
      const toolName = extensionToolRegistryName(item.manifest.id, def.name);
      if (seen.has(toolName)) {
        run.conflicts.push(`扩展内工具重名：${def.name}`);
        continue;
      }
      seen.add(toolName);
      if (this.opts.registry.has(toolName)) {
        // fail-closed：绝不静默覆盖已有工具（可能是另一个扩展/内置工具先注册）
        run.conflicts.push(`工具名已存在：${toolName}`);
        continue;
      }
      // 权限交集：manifest 授权 ∩ 工具声明；未声明/越权一律不注册。
      const resolved = resolveExtensionToolPermissions(item.manifest.permissions, def.permissions);
      if (resolved.errors.length > 0) {
        run.conflicts.push(`权限拒绝 ${def.name}：${resolved.errors.join("；")}`);
        continue;
      }
      const definition: ToolDefinition = {
        name: toolName,
        description: def.description ?? `扩展工具：${def.name}`,
        permissions: resolved.permissions,
        schema: z.any(),
        parameters: def.parameters,
        execute: async (ctx) => this.call(item.manifest.id, def.name, ctx.params),
      };
      try {
        this.opts.registry.register(definition);
        run.tools.push(toolName);
      } catch (err) {
        // 冲突/重复注册：跳过该工具，不影响其它工具；原因写进状态供 UI 诊断
        run.conflicts.push(`注册失败 ${toolName}：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.opts.onToolsChanged?.();
  }

  private call(id: string, tool: string, args: unknown): Promise<ToolResult> {
    const run = this.runs.get(id);
    if (!run || !run.ready) {
      return Promise.resolve({ ok: false, content: `[扩展未运行] ${id}` });
    }
    const callId = ++run.nextId;
    return new Promise<ToolResult>((resolve) => {
      const callTimeoutMs = this.opts.callTimeoutMs ?? CALL_TIMEOUT_MS;
      const timer = setTimeout(() => {
        run.pending.delete(callId);
        const message = `[扩展执行超时] ${tool} 超过 ${callTimeoutMs}ms`;
        // 超时不能只回一条错误：worker 可能已卡死，工具仍注册/状态仍 ready 会让后续调用
        // 继续排在同一死进程后面。首次超时即 failRun（注销工具 + kill），再走退避重启。
        this.failRun(id, run, message);
        resolve({ ok: false, content: message });
      }, callTimeoutMs);
      run.pending.set(callId, { resolve, timer });
      try {
        const message: ParentToWorker = { type: "call", id: callId, tool, args };
        run.child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (err) {
        clearTimeout(timer);
        run.pending.delete(callId);
        resolve({ ok: false, content: `[扩展通信失败] ${err instanceof Error ? err.message : String(err)}` });
      }
    });
  }

  /**
   * 向所有订阅该事件的已就绪扩展派发。返回聚合决策：
   *   · tool.before：任一扩展 allow=false 即否决（reason 取第一个否决者）；
   *   · 其它事件：只收集结果/错误，不影响主流程；
   *   · 超时/崩溃按 allow（fail-open）：事件钩子不是安全边界，安全靠工具权限/确认。
   */
  async dispatchEvent(
    event: string,
    payload: unknown,
  ): Promise<{ allow: boolean; reason?: string; results: Array<{ id: string; result?: unknown; error?: string }> }> {
    // turn.start/tool.before 在聊天关键路径上：超时要更短，坏扩展最多拖慢 2s；
    // turn.end/tool.after 是旁路，允许 5s 做日志/通知。
    const timeoutMs =
      this.opts.eventTimeoutMs ??
      (event === "turn.start" || event === "tool.before" ? 2_000 : 5_000);
    const targets = [...this.runs.values()].filter(
      (run) =>
        run.ready &&
        run.declaredEvents.includes(event) &&
        run.events.includes(event) &&
        this.opts.extensions.list().some((item) => item.manifest.id === run.extensionId && item.enabled),
    );
    let allow = true;
    let reason: string | undefined;
    const results = await Promise.all(
      targets.map(
        (run) =>
          new Promise<{ id: string; result?: unknown; error?: string }>((resolve) => {
            const eventId = ++run.nextId;
            const timer = setTimeout(() => {
              run.pendingEvents.delete(eventId);
              resolve({ id: run.extensionId, error: `事件 ${event} 超时（${timeoutMs}ms）` });
            }, timeoutMs);
            run.pendingEvents.set(eventId, {
              timer,
              resolve: (outcome) => {
                if (event === "tool.before" && outcome.allow === false) {
                  allow = false;
                  reason = reason ?? outcome.reason ?? `${run.extensionId} 否决了工具调用`;
                }
                resolve({
                  id: run.extensionId,
                  ...(outcome.result !== undefined ? { result: outcome.result } : {}),
                  ...(outcome.error ? { error: outcome.error } : {}),
                });
              },
            });
            try {
              const message: ParentToWorker = { type: "event", id: eventId, event, payload };
              run.child.stdin.write(`${JSON.stringify(message)}\n`);
            } catch (err) {
              clearTimeout(timer);
              run.pendingEvents.delete(eventId);
              resolve({ id: run.extensionId, error: err instanceof Error ? err.message : String(err) });
            }
          }),
      ),
    );
    return { allow, ...(reason ? { reason } : {}), results };
  }

  /** 应用 → 扩展富 UI 视图消息（worker 可选处理；纯声明式视图直接忽略）。 */
  sendViewMessage(id: string, viewId: string, message: unknown): boolean {
    const run = this.runs.get(id);
    if (!run?.ready) return false;
    try {
      run.child.stdin.write(`${JSON.stringify({ type: "viewMessage", viewId, message } satisfies ParentToWorker)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  private failRun(id: string, run: ExtensionRun, message: string): void {
    if (this.runs.get(id) !== run) return;
    this.unregisterTools(run);
    for (const pending of run.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, content: `[扩展已退出] ${message}` });
    }
    run.pending.clear();
    for (const pending of run.pendingEvents.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ error: `[扩展已退出] ${message}` });
    }
    run.pendingEvents.clear();
    this.runs.delete(id);
    this.setStatus(id, { state: "error", tools: [], error: message });
    try {
      run.child.kill();
    } catch {
      // 已退出
    }
    this.scheduleRestart(id);
  }

  /** 崩溃/超时后的有界退避重启；显式 stop 会清掉定时器。 */
  private scheduleRestart(id: string): void {
    if (this.opts.autoRestart === false) return;
    if (this.restartTimers.has(id)) return;
    const now = Date.now();
    const previous = this.failures.get(id);
    const count = previous && now - previous.lastAt < 5 * 60_000 ? previous.count + 1 : 1;
    this.failures.set(id, { count, lastAt: now });
    if (count > 3) return;
    const delay = [1_000, 5_000, 15_000][count - 1] ?? 15_000;
    const timer = setTimeout(() => {
      this.restartTimers.delete(id);
      const item = this.opts.extensions.list().find((candidate) => candidate.manifest.id === id);
      if (!item?.enabled) return;
      void this.start(id).catch(() => undefined);
    }, delay);
    timer.unref?.();
    this.restartTimers.set(id, timer);
  }

  private teardown(id: string, run: ExtensionRun): void {
    if (this.runs.get(id) === run) this.runs.delete(id);
    this.unregisterTools(run);
    for (const pending of run.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, content: "[扩展已停止]" });
    }
    run.pending.clear();
    for (const pending of run.pendingEvents.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ error: "扩展已停止" });
    }
    run.pendingEvents.clear();
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

  private unregisterTools(run: ExtensionRun): void {
    if (run.tools.length > 0) this.opts.onToolsChanged?.();
    for (const toolName of run.tools) this.opts.registry.unregister(toolName);
    run.tools = [];
  }

  private setStatus(id: string, status: ExtensionRuntimeStatus): ExtensionRuntimeStatus {
    console.log(`[Loopsoar] 扩展运行时 ${id}: ${status.state}${status.error ? `（${status.error}）` : ""}`);
    this.statusMap.set(id, status);
    this.opts.onUpdate?.(id, status);
    return status;
  }
}

/**
 * 生成 worker 启动参数（P1-8 第一步）：
 *   · 默认只传 worker/main，保持旧扩展完整 Node 权限；
 *   · `isolation:"node"` 时启用 Node permission model：只读扩展目录 + worker 目录，
 *     `write` 才允许写扩展目录，`terminal` 才允许子进程。
 * 不做的事：网络/环境变量/系统调用的完整沙箱、容器化、跨平台强制。
 */
export function extensionSpawnArgs(item: InstalledExtension, workerPath: string): string[] {
  const args: string[] = [];
  if (item.manifest.isolation === "node" || item.manifest.isolation === "strict") {
    const dir = path.resolve(item.dir);
    args.push(
      "--permission",
      `--allow-fs-read=${dir}`,
      `--allow-fs-read=${path.dirname(path.resolve(workerPath))}`,
    );
    if (item.manifest.isolation === "node" && item.manifest.permissions?.includes("write")) args.push(`--allow-fs-write=${dir}`);
    if (item.manifest.isolation === "node" && item.manifest.permissions?.includes("terminal")) args.push("--allow-child-process");
  }
  if (item.manifest.isolation === "strict") {
    // strict = 在上述权限面上去掉 write/child/worker/addons/inspector；
    // Node 的 permission model 不提供网络开关，因此网络仍需靠扩展代码审查/系统防火墙。
    args.push("--no-addons", "--no-warnings");
  }
  args.push(workerPath, item.dir, item.manifest.main?.trim() ?? "");
  return args;
}

export function resolveWorkerPath(baseDir: string): string {
  const candidates = [
    path.join(baseDir, "extensionWorker.mjs"),
    path.join(baseDir, "../src/main/extensionWorker.mjs"),
    path.join(baseDir, "../../src/main/extensionWorker.mjs"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}
