/**
 * Agent-Loop 运行时（ADR-0010 接线）：LoopRegistry + 内置 core-loop + 安全模式回退上报。
 *
 * 为什么放 shell 层：loop 是「策略层」（可插拔 + 回退），需要 push 事件和偏好持久化；
 * core 的 LoopRegistry 保持纯内核（不依赖 electron / 偏好文件），壳层负责把它接到 UI。
 *
 * 铁律（复用 core LoopRegistry 既有能力，不在壳层重造）：
 *   ① builtin core-loop 不可删改，是任何自定义 loop 的最后兜底；
 *   ② 自定义 loop 跑挂（静态校验失败/抛错/静默超时）→ 自动回退 builtin，同一 ctx 重跑；
 *   ③ 回退必须可见：push loop:fallback（UI 显著提示 + 诊断）。
 */
import { BUDGET_HARD } from "loopsoar-contracts/security-policy";
import { LoopRegistry, type LoopDefinition, type LoopRunContext } from "loopsoar-core/loop";
import { runToolLoop, type ToolLoopOpts, type ToolLoopOutcome } from "loopsoar-core/tool_loop";

/** 内置 loop id（builtin 不可删除/不可原位修改，永远最后兜底）。 */
export const CORE_LOOP_ID = "core-loop";

export interface LoopListEntry {
  id: string;
  name: string;
  builtin: boolean;
  active: boolean;
}

export interface LoopFallbackEntry {
  reason: string;
  at: number;
}

/** loop:list 返回结构（loops + 当前选择 + 回退记录）。 */
export interface LoopListPayload {
  loops: LoopListEntry[];
  activeId: string | null;
  fallbacks: LoopFallbackEntry[];
}

/** 运行输入：ToolLoopOpts（含事件 sink）+ 会话 id；可选 loopId（缺省=当前 active loop）。 */
export type LoopRunInput = ToolLoopOpts & { sessionId: string; loopId?: string };

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
}

export interface LoopRuntime {
  /** 底层注册表（后续自定义 loop 编辑器可直接 register/update/remove）。 */
  registry: LoopRegistry;
  /** 运行当前（或指定）loop；回退由 LoopRegistry 内部完成并推 loop:fallback。 */
  run(input: LoopRunInput): Promise<ToolLoopOutcome>;
  list(): LoopListPayload;
  /** 切换活动 loop：校验 → 持久化回调 → push loop:changed；未知 id 抛错（域层转 {ok:false}）。 */
  setActive(id: string): LoopListPayload;
}

/**
 * 从 LoopRunContext 还原 ToolLoopOpts（自定义 loop runner 也按此约定拿参数）。
 * ctx 由 run() 构造：sessionId + 完整 ToolLoopOpts；回退时 registry 会额外加 safeMode 标记。
 */
export function contextToToolLoopOpts(ctx: LoopRunContext): ToolLoopOpts {
  const { sessionId: _sessionId, safeMode: _safeMode, loopId: _loopId, ...rest } = ctx;
  return rest as unknown as ToolLoopOpts;
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

  // 恢复偏好里的选择：未知/已删除 id 不报错（fail-safe 保持 builtin，避免启动即失败）
  const persisted = options.getActiveId?.();
  if (persisted && persisted !== CORE_LOOP_ID) {
    try {
      registry.switchTo(persisted);
    } catch {
      // 偏好里是已删除/未知 loop：保持内置 loop
    }
  }

  const list = (): LoopListPayload => ({
    loops: registry.list().map((loop) => ({
      id: loop.id,
      name: loop.name,
      builtin: Boolean(loop.builtin),
      active: loop.id === registry.current(),
    })),
    activeId: registry.current(),
    fallbacks: registry.fallbackLog(),
  });

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
  };
}
