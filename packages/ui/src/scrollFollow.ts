/**
 * 自动跟随（"锁定最新"）的判据 —— 纯函数，可单测。
 *
 * 从 slime 的踩坑结论移植：
 *   · 用户滚轮上滚是最早、最可靠的"别跟了"信号（scrollTop 会被程序贴底抵消，判反）；
 *   · 距离判据用**滞回**（>48px 松开、≤8px 恢复），避免在边界抖动；
 *   · 内层可滚元素（代码块 pre 等）自己滚，不应解除外层跟随。
 */
export const FOLLOW_RELEASE_PX = 48;
export const FOLLOW_RESUME_PX = 8;

export interface ScrollMetrics {
  top: number;
  scrollHeight: number;
  clientHeight: number;
  following: boolean;
}

/** 根据当前距离与滞回决定是否继续自动跟随。 */
export function decideFollow(metrics: ScrollMetrics): boolean {
  const gap = metrics.scrollHeight - metrics.top - metrics.clientHeight;
  if (gap <= FOLLOW_RESUME_PX) return true;
  if (gap > FOLLOW_RELEASE_PX) return false;
  return metrics.following;
}

export interface ScrollBox {
  scrollHeight: number;
  clientHeight: number;
  overflowY: string;
}

/** 事件目标到滚动容器之间是否有"自己也在滚"的元素（有则不打扰外层跟随）。 */
export function hasInnerScroller(ancestors: readonly ScrollBox[]): boolean {
  return ancestors.some(
    (box) => box.scrollHeight > box.clientHeight + 1 && (box.overflowY === "auto" || box.overflowY === "scroll"),
  );
}
