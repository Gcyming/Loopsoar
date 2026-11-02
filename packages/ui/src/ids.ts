/**
 * 会话内实体 ID（消息 / 工具节点 / 会话占位）：时间戳 + 随机后缀。
 *
 * 为什么单独成模块：App（发送、回滚、恢复历史）与事件钩子（流式增量、工具节点）
 * 都需要同一个生成器，放两处必然出现两套格式；这里保持"单一产地"。
 */
export function nextId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
