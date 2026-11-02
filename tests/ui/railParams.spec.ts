/**
 * 卷轴参数归一化：数值范围夹紧、布尔保留、非法输入回退默认（不抛错）。
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_CHAT_RAIL, normalizeRailParams } from "../../packages/ui/src/railParams.ts";

describe("卷轴参数归一化", () => {
  it("空/非法输入回退默认值", () => {
    expect(normalizeRailParams(null)).toEqual(DEFAULT_CHAT_RAIL);
    expect(normalizeRailParams("bad")).toEqual(DEFAULT_CHAT_RAIL);
    expect(normalizeRailParams(undefined)).toEqual(DEFAULT_CHAT_RAIL);
  });

  it("数值夹紧到契约范围", () => {
    const out = normalizeRailParams({ w: 999, amp: -5, lam0: 1, spd: 100, tap: 999 });
    expect(out.w).toBe(32);
    expect(out.amp).toBe(0);
    expect(out.lam0).toBe(8);
    expect(out.spd).toBe(4);
    expect(out.tap).toBe(400);
  });

  it("布尔项保留，NaN/非数值被忽略（保持 base）", () => {
    const out = normalizeRailParams({ flip: true, pause: false, w: Number.NaN, spd: "1" });
    expect(out.flip).toBe(true);
    expect(out.pause).toBe(false);
    expect(out.w).toBe(DEFAULT_CHAT_RAIL.w);
    expect(out.spd).toBe(DEFAULT_CHAT_RAIL.spd);
  });

  it("支持自定义 base（设置页以当前值为基准合并）", () => {
    const base = { ...DEFAULT_CHAT_RAIL, w: 20, flip: true };
    const out = normalizeRailParams({ amp: 60 }, base);
    expect(out.w).toBe(20);
    expect(out.flip).toBe(true);
    expect(out.amp).toBe(60);
  });
});
