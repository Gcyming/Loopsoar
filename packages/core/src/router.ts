/**
 * 模型路由器（§4.1 router）
 * ModelPoolEntry 记录模型身份、优先级、角色、冷却；
 * ModelRouter 提供 pick（选最佳可用模型）、markCooldown（故障后冷却）、
 * fallbackChain（按优先级降级队列），保障多模型切换的可靠性。
 * 为什么：单模型故障不应导致整个任务失败，冷却机制防止重复调用不可用模型，降级链提供可测的备选路径。
 */

/**
 * 模型池条目：每个模型的身份、优先级、可胜任角色、冷却到期时间。
 */
export interface ModelPoolEntry {
  id: string;
  provider: string;
  priority: number;        // 数字越大优先级越高
  roles: string[];         // 该模型可胜任的角色标签
  cooldownUntilMs: number; // 冷却到期时间戳（ms），0 表示无冷却
}

/**
 * 路由选择结果（可选，为测试和监控提供可追溯的选择理由）。
 */
export interface RouterPick {
  entry: ModelPoolEntry;
  reason: string;
}

/**
 * 模型路由器：维护模型池，提供选择、冷却、降级链功能。
 */
export class ModelRouter {
  private pool: ModelPoolEntry[];

  constructor(pool: ModelPoolEntry[] = []) {
    this.pool = [...pool];
  }

  /**
   * 从可用模型中选出最适合指定角色的模型。
   * 过滤冷却中的条目；按 priority 降序排序，选第一个。
   * 为什么：冷却过滤防止重复选中故障模型；priority 降序保证高质量模型优先响应。
   */
  pick(roles: string | string[], now: number): ModelPoolEntry | null {
    const roleList = Array.isArray(roles) ? roles : [roles];

    const available = this.pool.filter(
      (entry) =>
        entry.cooldownUntilMs <= now &&
        roleList.some((r) => entry.roles.includes(r)),
    );

    if (available.length === 0) {
      return null;
    }

    available.sort((a, b) => b.priority - a.priority);
    return available[0];
  }

  /**
   * 标记模型冷却 ms 毫秒（用于调用失败或限流后的安全隔离）。
   * 为什么：避免在短时间内重复尝试已知不可用的模型，减少无效调用和安全风险。
   */
  markCooldown(id: string, ms: number, now: number): void {
    const entry = this.pool.find((e) => e.id === id);
    if (entry) {
      entry.cooldownUntilMs = now + ms;
    }
  }

  /**
   * 返回指定角色的有序降级队列（已过滤冷却条目，按 priority 降序）。
   * 为什么：当首选模型不可用时，提供可追踪的备选模型顺序，便于测试和调试。
   */
  fallbackChain(roles: string | string[], now: number): ModelPoolEntry[] {
    const roleList = Array.isArray(roles) ? roles : [roles];
    return this.pool
      .filter(
        (entry) =>
          entry.cooldownUntilMs <= now &&
          roleList.some((r) => entry.roles.includes(r)),
      )
      .sort((a, b) => b.priority - a.priority);
  }

  /**
   * 注册或替换一个模型条目（按 id 匹配，找不到则新增）。
   */
  upsert(entry: ModelPoolEntry): void {
    const idx = this.pool.findIndex((e) => e.id === entry.id);
    if (idx >= 0) {
      this.pool[idx] = entry;
    } else {
      this.pool.push(entry);
    }
  }

  /**
   * 移除一个模型条目（用于测试清理或模型下线）。
   */
  remove(id: string): boolean {
    const idx = this.pool.findIndex((e) => e.id === id);
    if (idx < 0) return false;
    this.pool.splice(idx, 1);
    return true;
  }

  /**
   * 获取当前池大小（用于监控和测试断言）。
   */
  size(): number {
    return this.pool.length;
  }
}
