/**
 * Agent-Loop 注册表（ADR-0010）：可插拔 loop + 安全模式后备。
 * 铁律：
 *   ① builtin loop 不可删除、不可原位修改——只能「复制为新 loop 再改」，原件永远是最后兜底；
 *   ② 自定义 loop 跑挂时，只有**尚未执行任何工具**才自动回退 builtin；已执行工具则停止并显式报错，
 *      避免把 file_write / terminal_run / 浏览器点击等副作用重放一遍；
 *   ③ 回退必须可见：onFallback 回调上报原因（界面显著提示 + 诊断）。
 */
import { LOOP_HEALTH } from "loopsoar-contracts/security-policy";
import type { ToolLoopOutcome, ToolExecutor } from "../tool_loop.js";

/** loop 运行上下文：会被原样透传给 runner（回退时同一对象重跑）。 */
export interface LoopRunContext {
  sessionId: string;
  /** 回退标记：safeMode=true 表示这是安全模式下的兜底运行。 */
  safeMode?: boolean;
  /** 心跳：runner 有进展时调用，重置静默看门狗（自定义 loop 必须定期调用）。 */
  heartbeat?: () => void;
  [key: string]: unknown;
}

export type LoopRunner = (ctx: LoopRunContext) => Promise<ToolLoopOutcome>;

export interface LoopDefinition {
  id: string;
  name: string;
  builtin?: boolean;
  /** 静态校验：返回错误列表（空=通过）。运行前必跑一次。 */
  validate?: () => string[];
  runner: LoopRunner;
}

export interface LoopRegistryOptions {
  /** 回退上报（界面提示 / 日志 / 诊断）。 */
  onFallback?: (reason: string) => void;
  /** 静默超时（默认取契约 LOOP_HEALTH.silentTimeoutMs）。 */
  silentTimeoutMs?: number;
}

export class LoopRegistry {
  private loops = new Map<string, LoopDefinition>();
  private currentId: string | null = null;
  private builtinId: string | null = null;
  private fallbacks: { reason: string; at: number }[] = [];

  constructor(private opts: LoopRegistryOptions = {}) {}

  /** 注册内置初始 loop（唯一允许设置 builtin 标记的入口）。 */
  registerBuiltin(def: LoopDefinition): void {
    if (this.loops.has(def.id)) throw new Error(`loop ${def.id} 已存在`);
    const builtin: LoopDefinition = { ...def, builtin: true };
    this.loops.set(builtin.id, builtin);
    this.builtinId = builtin.id;
    if (!this.currentId) this.currentId = builtin.id;
  }

  /** 注册自定义 loop：id 冲突拒绝；静态校验失败拒绝（fail-closed）。 */
  register(def: LoopDefinition): void {
    if (this.loops.has(def.id)) throw new Error(`loop ${def.id} 已存在（builtin 不可覆盖）`);
    const errors = def.validate?.() ?? [];
    if (errors.length > 0) throw new Error(`loop ${def.id} 静态校验失败：${errors.join("；")}`);
    this.loops.set(def.id, { ...def, builtin: false });
  }

  /** 复制为新 loop 再改（builtin 的正确改法）。 */
  copyForEdit(sourceId: string, newId: string, patch: Partial<Omit<LoopDefinition, "id" | "builtin">> = {}): LoopDefinition {
    const src = this.loops.get(sourceId);
    if (!src) throw new Error(`loop ${sourceId} 不存在`);
    const copy: LoopDefinition = {
      id: newId,
      name: patch.name ?? `${src.name}（副本）`,
      validate: patch.validate ?? src.validate,
      runner: patch.runner ?? src.runner,
    };
    this.register(copy);
    return this.loops.get(newId)!;
  }

  /** 修改自定义 loop；builtin 一律拒绝（ADR-0010）。 */
  update(id: string, patch: Partial<Omit<LoopDefinition, "id" | "builtin">>): void {
    const def = this.loops.get(id);
    if (!def) throw new Error(`loop ${id} 不存在`);
    if (def.builtin) throw new Error(`loop ${id} 是 builtin，不可原位修改（请复制后修改副本）`);
    if (patch.validate) {
      const errors = patch.validate();
      if (errors.length > 0) throw new Error(`loop ${id} 静态校验失败：${errors.join("；")}`);
    }
    this.loops.set(id, { ...def, ...patch });
  }

  /** 删除自定义 loop；builtin 一律拒绝。 */
  remove(id: string): void {
    const def = this.loops.get(id);
    if (!def) throw new Error(`loop ${id} 不存在`);
    if (def.builtin) throw new Error(`loop ${id} 是 builtin，不可删除`);
    this.loops.delete(id);
    if (this.currentId === id) this.currentId = this.builtinId;
  }

  current(): string | null {
    return this.currentId;
  }

  builtinId_(): string | null {
    return this.builtinId;
  }

  /** 切换当前 loop（不存在拒绝）。 */
  switchTo(id: string): void {
    if (!this.loops.has(id)) throw new Error(`loop ${id} 不存在`);
    this.currentId = id;
  }

  list(): LoopDefinition[] {
    return [...this.loops.values()];
  }

  /** 回退事件记录（诊断/界面提示用）。 */
  fallbackLog(): { reason: string; at: number }[] {
    return [...this.fallbacks];
  }

  /**
   * 运行 loop（安全模式后备在这里）：
   * ① 未知 id / 静态校验失败 → 回退 builtin；
   * ② runner 抛错 / 静默超时 → 先 abort；未执行过工具才回退 builtin，已执行过工具则停止并报错；
   * ③ 外部中止 → 直接返回 aborted，绝不触发回退；
   * ④ 回退不丢 ctx；回退原因进 fallbackLog + onFallback。
   */
  async run(id: string | undefined, ctx: LoopRunContext): Promise<ToolLoopOutcome> {
    const targetId = id ?? this.currentId;
    if (!targetId) throw new Error("没有可运行的 loop（未注册任何 loop）");
    const def = this.loops.get(targetId);
    if (!def) {
      return this.fallbackFrom(null, ctx, `loop ${targetId} 不存在`);
    }
    const staticErrors = def.validate?.() ?? [];
    if (staticErrors.length > 0) {
      return this.fallbackFrom(def, ctx, `静态校验失败：${staticErrors.join("；")}`);
    }

    const parentSignal = ctx.signal as AbortSignal | undefined;
    if (parentSignal?.aborted) return this.abortedOutcome(0);

    const controller = new AbortController();
    const unlink = this.linkAbort(parentSignal, controller);
    let toolCalls = 0;
    // 静默看门狗按「进展」计时：工具调用会心跳，runner 也可主动调 ctx.heartbeat()。
    // 固定总时长会把健康但耗时长的自定义 loop 误杀；无心跳才是真正的死循环/卡死。
    const timeoutMs = this.opts.silentTimeoutMs ?? LOOP_HEALTH.silentTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat = (): void => undefined;
    const timeout = new Promise<never>((_, reject) => {
      heartbeat = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          reject(new Error(`静默超时 ${timeoutMs}ms（心跳缺失/判死 → 安全模式条件）`));
          controller.abort();
        }, timeoutMs);
      };
      heartbeat();
    });
    const baseExecutor = ctx.executeTool as ToolExecutor | undefined;
    const runCtx: LoopRunContext = {
      ...ctx,
      safeMode: false,
      signal: controller.signal,
      heartbeat,
      ...(baseExecutor
        ? {
            executeTool: {
              invoke: async (toolCall) => {
                toolCalls += 1;
                heartbeat();
                return baseExecutor.invoke(toolCall);
              },
            } satisfies ToolExecutor,
          }
        : {}),
    };
    const runner = Promise.resolve().then(() => def.runner(runCtx));
    try {
      return await Promise.race([runner, timeout]);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      controller.abort();
      await this.settle(runner);
      // 用户主动停止：不是 loop 故障，绝不能回退重跑。
      if (parentSignal?.aborted) return this.abortedOutcome(toolCalls);
      // 已经产生工具副作用：回退会让 builtin 从原始消息重放一遍；停止比“假装继续”安全。
      if (toolCalls > 0 && !def.builtin) return this.sideEffectStop(reason, toolCalls);
      return this.fallbackFrom(def, ctx, reason);
    } finally {
      if (timer) clearTimeout(timer);
      unlink();
    }
  }

  /** 外部中止信号联到本次运行的内部 controller；返回解绑函数。 */
  private linkAbort(parent: AbortSignal | undefined, controller: AbortController): () => void {
    if (!parent) return () => undefined;
    if (parent.aborted) {
      controller.abort();
      return () => undefined;
    }
    const onAbort = (): void => controller.abort();
    parent.addEventListener("abort", onAbort, { once: true });
    return () => parent.removeEventListener("abort", onAbort);
  }

  /** 失败后最多再等 250ms，给收到 abort 的 runner 一点收尾时间；不阻塞主流程。 */
  private async settle(runner: Promise<unknown>): Promise<void> {
    await Promise.race([
      runner.catch(() => undefined),
      new Promise<void>((resolve) => {
        setTimeout(resolve, 250);
      }),
    ]);
  }

  private abortedOutcome(toolCalls: number): ToolLoopOutcome {
    return {
      status: "aborted",
      reason: "用户已停止本轮生成",
      finalText: "",
      usage: { rounds: 0, toolCalls, totalTokens: 0, wallClockMs: 0 },
    };
  }

  /** 已产生副作用后的“安全停止”：不回退、不假装成功，把原因交给 ChatService 呈现。 */
  private sideEffectStop(reason: string, toolCalls: number): ToolLoopOutcome {
    return {
      status: "error",
      reason: `自定义 loop 失败且已执行 ${toolCalls} 个工具；为避免重复副作用，未自动回退内置 loop。请重试或切回内置 loop（原因：${reason}）`,
      finalText: "",
      usage: { rounds: 0, toolCalls, totalTokens: 0, wallClockMs: 0 },
    };
  }

  private async fallbackFrom(
    failed: LoopDefinition | null,
    ctx: LoopRunContext,
    reason: string,
  ): Promise<ToolLoopOutcome> {
    const builtinId = this.builtinId;
    if (!builtinId || !this.loops.has(builtinId)) {
      throw new Error(`loop ${failed?.id ?? "?"} 失败且无可回退 builtin：${reason}`);
    }
    if (failed?.builtin) {
      // builtin 自己失败：没有更底层的兜底，如实抛出（绝不假成功）
      throw new Error(`builtin loop 失败（无兜底）：${reason}`);
    }
    this.fallbacks.push({ reason, at: Date.now() });
    try {
      this.opts.onFallback?.(reason);
    } catch {
      // 上报回调异常不影响回退本身
    }
    const builtin = this.loops.get(builtinId)!;
    return builtin.runner({ ...ctx, safeMode: true });
  }
}
