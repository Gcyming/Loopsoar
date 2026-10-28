/**
 * 转向总线（§4.1 steerBus）
 * SteerBus 提供短文本指令队列，用于向模型注入轮次边界提醒（如「开始收束」或「已收集足够信息」）。
 * 为什么：纯逻辑的转向注入机制让上层服务可以在关键轮次边界向模型发送安全提示，而不修改系统提示（stable 段）。
 */

// 转向总线：最多保留 8 条指令，每条最长截断至 2000 字。
export class SteerBus {
  private items: string[] = [];

  /**
   * 推入一条转向文本。超过 8 条时移除最旧的（FIFO）；每条截断至 2000 字，防止超长文本稀释注意力。
   */
  push(text: string): void {
    const trimmed = text.slice(0, 2000);
    this.items.push(trimmed);
    if (this.items.length > 8) {
      this.items.shift();
    }
  }

  /**
   * 取出并清空所有转向文本，返回有序数组（按推入顺序）。
   * 为什么：每轮边界 drain 一次，避免重复注入同一条转向，保持转向的新鲜度。
   */
  drain(): string[] {
    const result = [...this.items];
    this.items = [];
    return result;
  }

  /**
   * 当前队列长度（用于测试断言和监控）。
   */
  size(): number {
    return this.items.length;
  }
}
