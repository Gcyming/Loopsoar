/**
 * 侧栏宽度契约（ADR-0037 + ADR-0072）：用户要求「把当前左右栏比例固定为侧栏的最小窄度」，
 * 同时全屏时仍必须能拖动调整（用户 m05586），Vibecoding 模式使用独立的窄区间。
 *
 * 语义：
 *   · 标准下限 = 窗口宽度 × SIDEBAR_MIN_WIDTH_RATIO，夹在 [FLOOR, MAX]；
 *   · 全屏/超宽屏下若比例下限顶到 MAX（min === max 拖不动），把 min 压到 max 之下至少
 *     SIDEBAR_MIN_DRAG_RANGE 像素（但绝不低于 FLOOR）；
 *   · 标准上限 = min(MAX, 窗口宽度 - BROWSER_COLUMN_MIN_WIDTH)，且永不小于下限；
 *   · Vibecoding：min = 标准最小宽度 × 0.5、max = 标准最小宽度 × 0.6（用户 m05586），
 *     并保证 min ≥ VIBE_MIN_WIDTH_FLOOR、max ≥ min。
 */
import { describe, expect, it } from "vitest";
import {
  LAYOUT,
  computeSidebarMaxWidth,
  computeSidebarMinWidth,
  computeVibeSidebarBounds,
} from "../../packages/contracts/src/layout.ts";

describe("computeSidebarMinWidth：比例下限 + 全屏可拖拽区间", () => {
  it("2048 宽窗口：比例下限 717 但保留至少 200px 拖拽区间 → 可拖到 520", () => {
    expect(computeSidebarMinWidth(2048)).toBe(720 - LAYOUT.SIDEBAR_MIN_DRAG_RANGE);
    expect(computeSidebarMaxWidth(2048) - computeSidebarMinWidth(2048)).toBeGreaterThanOrEqual(
      LAYOUT.SIDEBAR_MIN_DRAG_RANGE,
    );
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

  it("全屏/超宽屏不再被比例下限锁死：2560/3840 都有 ≥200px 调节区间", () => {
    for (const width of [1920, 2560, 3840]) {
      const min = computeSidebarMinWidth(width);
      const max = computeSidebarMaxWidth(width);
      expect(max - min).toBeGreaterThanOrEqual(LAYOUT.SIDEBAR_MIN_DRAG_RANGE);
      expect(min).toBeLessThanOrEqual(LAYOUT.SIDEBAR_MAX_WIDTH);
      expect(max).toBe(LAYOUT.SIDEBAR_MAX_WIDTH);
    }
  });
});

describe("computeSidebarMaxWidth：与比例下限协同", () => {
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

describe("computeVibeSidebarBounds：Vibecoding 窄区间", () => {
  it("下限 = 标准最小宽度 × 0.5，上限 = 标准最小宽度 × 0.6（用户要求 3/5）", () => {
    const normal = computeSidebarMinWidth(2048);
    const vibe = computeVibeSidebarBounds(2048);
    expect(vibe.normalMin).toBe(normal);
    expect(vibe.min).toBe(Math.round(normal * LAYOUT.SIDEBAR_VIBE_MIN_RATIO));
    expect(vibe.max).toBe(Math.round(normal * LAYOUT.SIDEBAR_VIBE_MAX_RATIO));
    expect(vibe.max).toBeGreaterThanOrEqual(vibe.min);
    expect(vibe.max).toBeLessThan(normal); // 始终比标准模式窄
  });

  it("全屏（2560）下 vibe 区间约为 260~312，会话列表空间明显收窄", () => {
    const vibe = computeVibeSidebarBounds(2560);
    expect(vibe.min).toBe(260);
    expect(vibe.max).toBe(312);
  });

  it("小窗口仍有绝对下限 120，且 max ≥ min", () => {
    const vibe = computeVibeSidebarBounds(500);
    expect(vibe.min).toBe(LAYOUT.SIDEBAR_VIBE_MIN_WIDTH_FLOOR);
    expect(vibe.max).toBeGreaterThanOrEqual(vibe.min);
  });
});
