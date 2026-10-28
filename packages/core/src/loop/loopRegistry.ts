/**
 * Agent-Loop 注册表（ADR-0010）：可插拔 loop + 安全模式后备。
 * 铁律：
 *   ① builtin loop 不可删除、不可原位修改——只能「复制为新 loop 再改」，原件永远是最后兜底；
 *   ② 任何自定义 loop 跑挂（静态校验失败 / 抛错 / 静默超时）→ 自动回退 builtin，用同一 ctx 重跑，
 *      且 ctx 保持不变（会话与工具结果不丢，任务继续而不是重来）；
 *   ③ 回退必须可见：onFallback 回调上报原因（界面显著提示 + 诊断）。
 */
import { LOOP_HEALTH } from "loopsoar-contracts/security-policy";
import type { ToolLoopOutcome } from "../tool_loop.js";

/** loop 运行上下文：会被原样透传给 runner（回退时同一对象重跑）。 */
export interface LoopRunContext {
  sessionId: string;
  /** 回退标记：safeMode=true 表示这是安全模式下的兜底运行。 */
  safeMode?: boolean;
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
   * ② runner 抛错 / 静默超时 → 回退 builtin 用同一 ctx 重跑（safeMode=true）；
   * ③ 回退不丢 ctx；回退原因进 fallbackLog + onFallback。
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
    try {
      return await this.withTimeout(def, { ...ctx, safeMode: false });
    } catch (err) {
      return this.fallbackFrom(def, ctx, err instanceof Error ? err.message : String(err));
    }
  }

  private withTimeout(def: LoopDefinition, ctx: LoopRunContext): Promise<ToolLoopOutcome> {
    const timeoutMs = this.opts.silentTimeoutMs ?? LOOP_HEALTH.silentTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<ToolLoopOutcome>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`静默超时 ${timeoutMs}ms（心跳缺失/判死 → 安全模式条件）`)),
        timeoutMs,
      );
    });
    return Promise.race([def.runner(ctx), timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
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
