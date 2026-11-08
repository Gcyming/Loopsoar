/**
 * 待发指令（steer）队列 —— 纯函数层（slime instructionQueue 的 Loopsoar 精简移植）。
 *
 * 语义（对齐 slime ChatPanel 的「引导 / 待发」行为）：
 *   · Enter 在 Agent 运行中 = 先入待发队列，再立即投递给主进程 steer 缓冲（绝不打断当前输出）；
 *   · 等待期间卡片显示「待发」；主进程在轮次边界注入后回执 chat:steer:applied，
 *     卡片撤掉、文案折进当轮 assistant 的「引导」时间线卡（TimelineView 已有渲染）；
 *   · 本轮结束仍未被注入（投递失败 / 本轮已到收尾）→ 自动续发为下一轮；
 *   · 上限与 core/steerBus 的 STEER_MAX_PENDING 保持一致。
 *
 * 本模块只做状态计算，不发请求、不碰 React —— 便于单测覆盖。
 */

/** 待发队列上限（与 packages/core/src/steerBus.ts 的 STEER_MAX_PENDING 对齐）。 */
export const PENDING_STEER_MAX = 8;

/**
 * queued：已入队、尚未送达（本轮结束后自动续发/可手动立即并入）；
 * delivered：已送达主进程 steer 缓冲，等轮次边界注入后回执；
 * failed：投递失败（可重试或撤销）。
 */
export type PendingSteerStatus = "queued" | "delivered" | "failed";

export interface PendingSteer {
  id: string;
  text: string;
  createdAt: number;
  status: PendingSteerStatus;
  /** 投递失败/被拒的原因（如队列已满），仅 UI 展示用。 */
  error?: string;
}

/** 入队：满员时原样返回（调用方负责提示），空文本不入队。 */
export function enqueuePending(list: PendingSteer[], item: PendingSteer): PendingSteer[] {
  if (!item.text.trim()) return list;
  if (list.length >= PENDING_STEER_MAX) return list;
  return [...list, item];
}

/** 更新单条状态（找不到时原样返回）。 */
export function setPendingStatus(
  list: PendingSteer[],
  id: string,
  status: PendingSteerStatus,
  error?: string,
): PendingSteer[] {
  return list.map((item) =>
    item.id === id ? { ...item, status, ...(error ? { error } : { error: undefined }) } : item,
  );
}

/** 按 id 删除（撤销 / 修改取回 / 注入回执后移除）。 */
export function removePending(list: PendingSteer[], id: string): PendingSteer[] {
  return list.filter((item) => item.id !== id);
}

/** 下一条可自动续发的指令：优先 failed，其次 queued；delivered 不参与。 */
export function nextResendable(list: PendingSteer[]): PendingSteer | undefined {
  return list.find((item) => item.status === "failed") ?? list.find((item) => item.status === "queued");
}

/** 本轮结束：仍处于 delivered（未收到注入回执）的指令改回 queued，避免静默丢失。 */
export function requeueUndelivered(list: PendingSteer[]): PendingSteer[] {
  return list.map((item) => (item.status === "delivered" ? { ...item, status: "queued" } : item));
}

/** 注入成功回执：移除对应条目，返回 { next, deliveredTexts }（文案按入队顺序折进时间线）。 */
export function mergeDelivered(
  list: PendingSteer[],
  delivered: ReadonlyArray<{ id: string; text: string }>,
): { next: PendingSteer[]; deliveredTexts: string[] } {
  if (delivered.length === 0) return { next: list, deliveredTexts: [] };
  const ids = new Set(delivered.map((item) => item.id));
  const deliveredTexts = list.filter((item) => ids.has(item.id)).map((item) => item.text.trim()).filter(Boolean);
  return { next: list.filter((item) => !ids.has(item.id)), deliveredTexts };
}
