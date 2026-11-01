/**
 * 锁定最新（自动跟随）判据：滞回、内层滚动不打扰外层。
 */
import { describe, expect, it } from "vitest";
import { decideFollow, hasInnerScroller, FOLLOW_RELEASE_PX, FOLLOW_RESUME_PX } from "../../packages/ui/src/scrollFollow.ts";

const base = { top: 0, scrollHeight: 1000, clientHeight: 400, following: true };

describe("自动跟随判据", () => {
  it("贴底附近继续跟随；远离底部停止跟随", () => {
    expect(decideFollow({ ...base, top: 595, following: true })).toBe(true); // gap=5
    expect(decideFollow({ ...base, top: 520, following: true })).toBe(false); // gap=80
  });

  it("滞回区（8~48px）保持当前状态，避免边界抽搐", () => {
    const top = 1000 - 400 - 20; // gap=20，落在不动作区
    expect(decideFollow({ ...base, top, following: true })).toBe(true);
    expect(decideFollow({ ...base, top, following: false })).toBe(false);
    expect(FOLLOW_RESUME_PX).toBeLessThan(FOLLOW_RELEASE_PX);
  });

  it("内层可滚元素（代码块）自己滚动不算用户上翻", () => {
    expect(hasInnerScroller([{ scrollHeight: 300, clientHeight: 100, overflowY: "auto" }])).toBe(true);
    expect(hasInnerScroller([{ scrollHeight: 100, clientHeight: 100, overflowY: "auto" }])).toBe(false);
    expect(hasInnerScroller([{ scrollHeight: 300, clientHeight: 100, overflowY: "hidden" }])).toBe(false);
  });
});
