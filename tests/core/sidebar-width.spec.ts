/**
 * 侧栏宽度契约（ADR-0037）：用户要求「把当前左右栏比例固定为侧栏的最小窄度」。
 *
 * 为什么单独一个文件：侧栏最小/最大宽度由 UI 的拖拽夹紧、窗口 resize 夹紧、启动水合夹紧
 * 三处共用，任何一处各算各的都会出现「拖得动/拖不动不一致」；这里锚定契约函数的语义：
 *   · 下限 = 窗口宽度 × SIDEBAR_MIN_WIDTH_RATIO，夹在 [FLOOR, MAX] 之间；
 *   · 上限 = min(MAX, 窗口宽度 - BROWSER_COLUMN_MIN_WIDTH)，且永不小于下限；
 *   · 当前实测布局（侧栏 720 / 窗口 2048）下可调区间为 [717, 720] —— 侧栏无法再被拖窄。
 */
import { describe, expect, it } from "vitest";
import {
  LAYOUT,
  computeSidebarMaxWidth,
  computeSidebarMinWidth,
} from "../../packages/contracts/src/layout.ts";

describe("computeSidebarMinWidth：比例下限", () => {
  it("2048 宽窗口：下限 = round(2048 × 0.35) = 717（实测当前 720/2048 ≈ 35.2%，取整差 3px）", () => {
    expect(computeSidebarMinWidth(2048)).toBe(717);
    expect(computeSidebarMinWidth(2048) / 2048).toBeCloseTo(LAYOUT.SIDEBAR_MIN_WIDTH_RATIO, 2);
  });

  it("随窗口等比缩放：1280 → 448，1024 → 358，800 → 280", () => {
    expect(computeSidebarMinWidth(1280)).toBe(448);
    expect(computeSidebarMinWidth(1024)).toBe(358);
    expect(computeSidebarMinWidth(800)).toBe(280);
  });

  it("绝对下限 240 兜底：极窄窗口不出现负区间（NaN/负数按 0 处理）", () => {
    expect(computeSidebarMinWidth(500)).toBe(240);
    expect(computeSidebarMinWidth(0)).toBe(240);
    expect(computeSidebarMinWidth(Number.NaN)).toBe(240);
    expect(computeSidebarMinWidth(-100)).toBe(240);
  });

  it("绝对上限 720 截住比例下限：2560 宽屏不再随窗口增长", () => {
    expect(computeSidebarMinWidth(2560)).toBe(LAYOUT.SIDEBAR_MAX_WIDTH);
    expect(computeSidebarMinWidth(1920)).toBe(Math.round(1920 * LAYOUT.SIDEBAR_MIN_WIDTH_RATIO));
  });
});

describe("computeSidebarMaxWidth：与比例下限协同（三处夹紧共用同一对契约函数）", () => {
  it("当前 2048 窗口：可调区间 [717, 720] → 侧栏无法被拖窄到当前宽度以下", () => {
    expect(computeSidebarMinWidth(2048)).toBe(717);
    expect(computeSidebarMaxWidth(2048)).toBe(720);
  });

  it("上限 = min(720, 窗口宽 - 320)：1280 → 720，1000 → 680，700 → 380", () => {
    expect(computeSidebarMaxWidth(1280)).toBe(720);
    expect(computeSidebarMaxWidth(1000)).toBe(680);
    expect(computeSidebarMaxWidth(700)).toBe(380);
  });

  it("任何视口下 max ≥ min（极窄窗口也不会出现夹取区间倒挂）", () => {
    for (const width of [200, 400, 480, 560, 700, 1000, 1280, 2048, 2560, 4000]) {
      expect(computeSidebarMaxWidth(width)).toBeGreaterThanOrEqual(computeSidebarMinWidth(width));
    }
  });
});
