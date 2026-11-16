/**
 * Agent-Loop 运行时（ADR-0010 接线）：builtin + L2 声明式 + L3 脚本 + 安全模式回退上报。
 *
 * 为什么放 shell 层：loop 是「策略层」（可插拔 + 回退），需要扫描数据目录、push 事件和偏好持久化；
 * core 的 LoopRegistry 保持纯内核（不依赖 fs / electron / 偏好文件），壳层负责把它接到 UI。
 *
 * 铁律（复用 core LoopRegistry 既有能力，不在壳层重造）：
 *   ① builtin core-loop 不可删改，是任何自定义 loop 的最后兜底；
 *   ② 自定义 loop（L2/L3）跑挂（静态校验失败/抛错/静默超时/worker 崩溃）→ 自动回退 builtin，同一 ctx 重跑；
 *   ③ 回退必须可见：push loop:fallback（UI 显著提示 + 诊断）。
 *
 * 三档来源：
 *   · builtin      —— 内核 core-loop（runToolLoop 原样）；
 *   · declarative  —— `<dataDir>/loops/*.json`（L2）：在 builtin 之上注入额外提示 + 收紧 limits + 工具白名单；
 *   · script       —— `<dataDir>/loops/<id>/loop.json` + 脚本（L3）：子进程 JSON-RPC，代理 LLM 与工具执行。
 */
import fs from "node:fs";
import path from "node:path";
import { BUDGET_HARD } from "loopsoar-contracts/security-policy";
import { LoopRegistry, type LoopDefinition, type LoopRunContext } from "loopsoar-core/loop";
import {
  runToolLoop,
  type ToolExecutor,
  type ToolLoopOpts,
  type ToolLoopOutcome,
} from "loopsoar-core/tool_loop";
import { scanLoopDefs, type DeclarativeLoopDef, type LoopDefError, type ScriptLoopDef } from "./loopDefs.js";
import {
  runScriptLoop,
  type ScriptHostOptions,
  type ScriptRunInput,
} from "./scriptLoopHost.js";

/** 内置 loop id（builtin 不可删除/不可原位修改，永远最后兜底）。 */
export const CORE_LOOP_ID = "core-loop";

/** loop 来源：内置 / L2 声明式 / L3 脚本。 */
export type LoopKind = "builtin" | "declarative" | "script";

export interface LoopListEntry {
  id: string;
  name: string;
  kind: LoopKind;
  builtin: boolean;
  active: boolean;
  /** 定义是否可用于运行（坏文件以 valid:false + error 出现在列表里，便于用户修正）。 */
  valid: boolean;
  description?: string;
  error?: string;
}

export interface LoopFallbackEntry {
  reason: string;
  at: number;
}

/** loop:list 返回结构（loops + 当前选择 + 回退记录 + 定义错误）。 */
export interface LoopListPayload {
  loops: LoopListEntry[];
  activeId: string | null;
  fallbacks: LoopFallbackEntry[];
  /** 扫描期错误（坏 JSON / 校验失败 / 脚本缺失等），不会阻断启动。 */
  errors: LoopDefError[];
}

/** 运行输入：ToolLoopOpts（含事件 sink）+ 会话 id；可选 loopId（缺省=当前 active loop）。 */
export type LoopRunInput = ToolLoopOpts & { sessionId: string; loopId?: string };

/** L2 声明式 loop 的可执行配置（由 loopDefs 扫描结果投影而来，也可手工构造）。 */
export interface DeclarativeLoopRuntimeConfig {
  id: string;
  name: string;
  description?: string;
  /** 追加为本 loop 运行时的额外用户消息（volatile；不污染 stable 系统提示）。 */
  systemPromptAppend?: string;
  /** 只能收紧：与调用方 limits 及 BUDGET_HARD 取 min。 */
  maxRounds?: number;
  maxToolCalls?: number;
  /** 工具白名单（省略/空 = 不限制）：既过滤给模型的工具清单，也拦截执行。 */
  allowedTools?: string[];
  /** 采样温度（0~2）：当前 LlmRequest 尚无 temperature 字段，先校验留存（见报告"风险"）。 */
  temperature?: number;
}

export interface LoopRuntimeOptions {
  /** 事件推送（loop:changed / loop:fallback；事件名不带 loopsoar: 前缀，由渲染层桥接加）。 */
  push: (event: string, payload: unknown) => void;
  /** 读取持久化的活动 loop id（偏好 loopId）；未知 id 会安全回落到 builtin。 */
  getActiveId?: () => string | undefined;
  /** 活动 loop 变更后持久化（写偏好）；回写失败不影响本次切换。 */
  onActiveChanged?: (id: string) => void;
  /**
   * LoopRegistry 静默超时（默认 BUDGET_HARD.maxWallClockMs）。
   * 为什么不用 LOOP_HEALTH.silentTimeoutMs（90s）：那是给自定义 loop 心跳判死用的；
   * 内置 core-loop 是长任务工具循环（自身有预算墙钟 3h 兜底），90s 会被误判成静默并触发回退。
   */
  silentTimeoutMs?: number;
  /** 数据目录（启用 L2/L3 扫描：`<dataDir>/loops`）；不传 = 只注册 builtin（兼容旧装配/测试）。 */
  dataDir?: string;
  /** 首次创建 loops 目录时生成 example.json 模板（默认 true）。 */
  seedExample?: boolean;
  /** L3 脚本 host 配置（workerPath / 各阶段超时 / 测试注入）。 */
  scriptHost?: ScriptHostOptions;
}

export interface LoopRuntime {
  /** 底层注册表（自定义 loop 编辑器可直接 register/update/remove）。 */
  registry: LoopRegistry;
  /** 运行当前（或指定）loop；回退由 LoopRegistry 内部完成并推 loop:fallback。 */
  run(input: LoopRunInput): Promise<ToolLoopOutcome>;
  list(): LoopListPayload;
  /** 切换活动 loop：校验 → 持久化回调 → push loop:changed；未知 id 抛错（域层转 {ok:false}）。 */
  setActive(id: string): LoopListPayload;
  /** 重新扫描 `<dataDir>/loops`（L2/L3 增删改即时生效）→ push loop:changed；返回最新列表。 */
  reload(): LoopListPayload;
}

/**
 * 从 LoopRunContext 还原 ToolLoopOpts（自定义 loop runner 也按此约定拿参数）。
 * ctx 由 run() 构造：sessionId + 完整 ToolLoopOpts；回退时 registry 会额外加 safeMode 标记。
 */
export function contextToToolLoopOpts(ctx: LoopRunContext): ToolLoopOpts {
  const { sessionId: _sessionId, safeMode: _safeMode, loopId: _loopId, ...rest } = ctx;
  return rest as unknown as ToolLoopOpts;
}

/**
 * 把 L2 声明应用到 ToolLoopOpts（纯函数，便于单测）：
 *   ① 提示注入：systemPromptAppend 作为**额外 user 消息**追加在末尾（不动 system/历史，保 KV 前缀缓存）；
 *   ② limits 收紧：声明值只能比调用方/硬上限更小（min），不能放宽；
 *   ③ 工具白名单：过滤给模型的 tools()，并在执行器入口二次拦截（纵深防御）。
 */
export function applyDeclarativeLoop(
  config: DeclarativeLoopRuntimeConfig,
  opts: ToolLoopOpts,
): ToolLoopOpts {
  const append = config.systemPromptAppend?.trim();
  const messages = opts.messages ? [...opts.messages] : [];
  if (append) {
    messages.push({
      role: "user",
      content: `【Loop 指令：${config.name}】\n${append}`,
    });
  }

  const limits: ToolLoopOpts["limits"] = { ...opts.limits };
  if (config.maxRounds !== undefined) {
    limits.maxRounds = Math.min(opts.limits.maxRounds ?? BUDGET_HARD.maxRounds, config.maxRounds);
  }
  if (config.maxToolCalls !== undefined) {
    limits.maxToolCalls = Math.min(opts.limits.maxToolCalls ?? BUDGET_HARD.maxToolCalls, config.maxToolCalls);
  }

  const allowed =
    config.allowedTools && config.allowedTools.length > 0
      ? new Set(config.allowedTools)
      : null;
  const baseTools = opts.tools;
  const baseExecutor = opts.executeTool;

  const gatedExecutor: ToolExecutor = {
    invoke: async (toolCall) => {
      if (allowed && !allowed.has(toolCall.name)) {
        return {
          ok: false,
          content: `[Loop 限制] 工具 ${toolCall.name} 不在「${config.name}」的 allowedTools 内`,
          error: "loop-tool-denied",
        };
      }
      return baseExecutor.invoke(toolCall);
    },
  };

  return {
    ...opts,
    ...(messages.length > 0 ? { messages } : {}),
    limits,
    tools: allowed ? () => baseTools().filter((tool) => allowed.has(tool.name)) : baseTools,
    executeTool: gatedExecutor,
  };
}

/** 扫描结果 → L2 运行配置。 */
function toDeclarativeConfig(def: DeclarativeLoopDef): DeclarativeLoopRuntimeConfig {
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    systemPromptAppend: def.config.systemPromptAppend,
    maxRounds: def.config.maxRounds,
    maxToolCalls: def.config.maxToolCalls,
    allowedTools: def.config.allowedTools,
    temperature: def.config.temperature,
  };
}

export function createLoopRuntime(options: LoopRuntimeOptions): LoopRuntime {
  const registry = new LoopRegistry({
    // 回退必须可见（铁律③）：UI 收到 loop:fallback 后做显著提示
    onFallback: (reason) => options.push("loop:fallback", { reason, at: Date.now() }),
    silentTimeoutMs: options.silentTimeoutMs ?? BUDGET_HARD.maxWallClockMs,
  });

  const builtin: LoopDefinition = {
    id: CORE_LOOP_ID,
    name: "核心工具循环",
    // builtin 的 runner 就是平台内置工具循环：自定义 loop 跑挂时用同一 ctx 回退到这里，任务继续
    runner: (ctx) => runToolLoop(contextToToolLoopOpts(ctx)),
  };
  registry.registerBuiltin(builtin);

  /** 扫描注册的 loop（id → kind/描述）；builtin 与手工 register 的 loop 不进这些表。 */
  const scannedKinds = new Map<string, LoopKind>();
  const scannedDescriptions = new Map<string, string | undefined>();
  let scanErrors: LoopDefError[] = [];
  const scriptHost: ScriptHostOptions = options.scriptHost ?? {};

  /** L3 预算护栏输入：脚本自己编排，但四闸必须由宿主封顶（只能收紧，不得越过 BUDGET_HARD）。 */
  const clampScriptLimits = (limits: ToolLoopOpts["limits"] | undefined): Required<NonNullable<ToolLoopOpts["limits"]>> => {
    const source = limits ?? {};
    return {
      maxRounds: Math.min(source.maxRounds ?? BUDGET_HARD.maxRounds, BUDGET_HARD.maxRounds),
      maxToolCalls: Math.min(source.maxToolCalls ?? BUDGET_HARD.maxToolCalls, BUDGET_HARD.maxToolCalls),
      maxTotalTokens: Math.min(source.maxTotalTokens ?? BUDGET_HARD.maxTotalTokens, BUDGET_HARD.maxTotalTokens),
      maxWallClockMs: Math.min(source.maxWallClockMs ?? BUDGET_HARD.maxWallClockMs, BUDGET_HARD.maxWallClockMs),
    };
  };

  /** L3 runner：交给 script host（真实子进程或测试替身），失败会让 LoopRegistry 回退 builtin。 */
  const runScript = (def: ScriptLoopDef, ctx: LoopRunContext): Promise<ToolLoopOutcome> => {
    const opts = contextToToolLoopOpts(ctx);
    const input: ScriptRunInput = {
      loopId: def.id,
      loopDir: def.loopDir,
      script: def.script,
      llm: opts.llm,
      executeTool: opts.executeTool,
      tools: opts.tools,
      messages: opts.messages,
      limits: clampScriptLimits(opts.limits),
      signal: opts.signal,
      sink: opts.sink,
      workerPath: scriptHost.workerPath,
      startTimeoutMs: scriptHost.startTimeoutMs,
      callTimeoutMs: scriptHost.callTimeoutMs,
      totalTimeoutMs: scriptHost.totalTimeoutMs,
    };
    return (scriptHost.run ?? runScriptLoop)(input);
  };

  /**
   * 扫描并（重）注册 L2/L3 loop：
   * 先摘掉上一轮扫描注册的 loop（builtin / 手工注册的保留），再按最新文件重建。
   * 坏文件只进 scanErrors，不影响 builtin 可用——安全模式底线。
   */
  const scan = (seedExample: boolean): void => {
    // 记住当前选择：remove() 会把 currentId 重置为 builtin，注册完必须还原，
    // 否则「重新扫描」（设置页按钮）会把用户选中的自定义 loop 静默切回 core-loop。
    const activeBefore = registry.current();
    for (const id of [...scannedKinds.keys()]) {
      try {
        registry.remove(id);
      } catch {
        // builtin 保护 / 已被手工删除：忽略
      }
    }
    scannedKinds.clear();
    scannedDescriptions.clear();
    scanErrors = [];
    if (!options.dataDir) return;

    const result = scanLoopDefs(options.dataDir, { seedExample });
    scanErrors = result.errors;
    for (const def of result.loops) {
      const definition: LoopDefinition =
        def.kind === "declarative"
          ? {
              id: def.id,
              name: def.name,
              // 校验已在扫描期完成；预算字段在 applyDeclarativeLoop 内再与硬上限取 min
              validate: () => [],
              runner: (ctx) =>
                runToolLoop(applyDeclarativeLoop(toDeclarativeConfig(def), contextToToolLoopOpts(ctx))),
            }
          : {
              id: def.id,
              name: def.name,
              // 脚本可能被删/改名：运行前静态校验，失败直接回退 builtin（不启动子进程）
              validate: () => (fs.existsSync(def.scriptPath) ? [] : [`脚本不存在：${def.script}`]),
              runner: (ctx) => runScript(def, ctx),
            };
      try {
        registry.register(definition);
        scannedKinds.set(def.id, def.kind);
        scannedDescriptions.set(def.id, def.description);
      } catch (err) {
        scanErrors.push({
          path: def.filePath,
          id: def.id,
          error: `注册失败：${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // 还原选择：目标 loop 仍存在才切回；已被删除则安全回落 builtin（fail-safe）。
    if (activeBefore && activeBefore !== registry.current()) {
      try {
        registry.switchTo(activeBefore);
      } catch {
        // 该 loop 已被删除：保持 builtin
      }
    }
  };

  // 启动：先扫描（自定义 id 才存在），再恢复偏好里的选择（未知/已删除 id 安全回落 builtin）。
  scan(options.seedExample !== false);
  const persisted = options.getActiveId?.();
  if (persisted && persisted !== CORE_LOOP_ID) {
    try {
      registry.switchTo(persisted);
    } catch {
      // 偏好里是已删除/未知 loop：保持内置 loop
    }
  }

  const list = (): LoopListPayload => {
    const entries: LoopListEntry[] = registry.list().map((loop) => {
      const kind: LoopKind = loop.builtin ? "builtin" : (scannedKinds.get(loop.id) ?? "declarative");
      const description = scannedDescriptions.get(loop.id);
      return {
        id: loop.id,
        name: loop.name,
        kind,
        builtin: Boolean(loop.builtin),
        active: loop.id === registry.current(),
        valid: true,
        ...(description ? { description } : {}),
      };
    });

    // 坏定义也列出来（valid:false + error）：用户能看到「有这个文件但坏了、原因是什么」。
    const listed = new Set(entries.map((entry) => entry.id));
    for (const scanError of scanErrors) {
      const guessId =
        scanError.id ??
        path.basename(scanError.path).replace(/\.json$/i, "").toLowerCase();
      if (!guessId || listed.has(guessId)) continue;
      listed.add(guessId);
      entries.push({
        id: guessId,
        name: guessId,
        kind: path.extname(scanError.path) ? "declarative" : "script",
        builtin: false,
        active: false,
        valid: false,
        error: scanError.error,
      });
    }

    // 内置永远排第一，其余按名称；UI 列表顺序稳定。
    entries.sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name));
    return {
      loops: entries,
      activeId: registry.current(),
      fallbacks: registry.fallbackLog(),
      errors: [...scanErrors],
    };
  };

  return {
    registry,
    run: async (input: LoopRunInput): Promise<ToolLoopOutcome> => {
      const { sessionId, loopId, ...loopOpts } = input;
      // 回退要求「同一 ctx 重跑」：ctx 里放着完整 ToolLoopOpts（含 sink、tools、executeTool），
      // 回退到 builtin 时任务上下文不丢（会话与工具结果继续，而不是从头重来）。
      const ctx: LoopRunContext = { ...(loopOpts as unknown as Record<string, unknown>), sessionId };
      // loopId 缺省 → LoopRegistry 用 currentId（setActive 后即时生效）
      return registry.run(loopId, ctx);
    },
    list,
    setActive: (id: string): LoopListPayload => {
      registry.switchTo(id); // 未知 id → throw，由域层转成可读错误（不崩溃）
      try {
        options.onActiveChanged?.(id);
      } catch (err) {
        // 持久化失败不能阻断本次切换（本次运行仍按新 loop 走），但要留诊断
        console.warn("[Loopsoar] loop 选择持久化失败（本次切换仍生效）：", err);
      }
      const payload = list();
      options.push("loop:changed", { activeId: payload.activeId, loops: payload.loops });
      return payload;
    },
    reload: (): LoopListPayload => {
      scan(true);
      const payload = list();
      options.push("loop:changed", { activeId: payload.activeId, loops: payload.loops });
      return payload;
    },
  };
}
