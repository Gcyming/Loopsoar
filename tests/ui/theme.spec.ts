/**
 * 品牌色板（ui/theme.ts）用例：
 *   - 三品牌色锁定（深墨 #111318 / 亚麻白 #f4efe6 / 赭石 #c8763c，S4-UI风格 色板）；
 *   - 色值格式合法且无重复（同一份色板不该有两个同值 key）；
 *   - 正文可读性：linen 在 ink 上、ink 在 linen 上都要达到 WCAG AA 以上对比度；
 *   - 强调色/危险色在深色底上仍可读（≥4.5，小字徽标依赖这个）；
 *   - 自定义标题栏拖动区域常量形状正确。
 */
import { describe, expect, it } from "vitest";
import {
  BADGE,
  BRAND,
  DRAG_REGION,
  NO_DRAG_REGION,
} from "../../packages/ui/src/theme.ts";

type Rgb = { r: number; g: number; b: number };

/** #rrggbb → 线性化的 sRGB 分量（0..1）。 */
function hexToLinearRgb(hex: string): Rgb {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`不是 6 位十六进制色值：${hex}`);
  const value = match[1];
  const toLinear = (channel: number): number => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return {
    r: toLinear(parseInt(value.slice(0, 2), 16)),
    g: toLinear(parseInt(value.slice(2, 4), 16)),
    b: toLinear(parseInt(value.slice(4, 6), 16)),
  };
}

/** WCAG 相对亮度。 */
function luminance(hex: string): number {
  const { r, g, b } = hexToLinearRgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 对比度（1~21）。 */
function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [light, dark] = la >= lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

const SOLID_COLOR_KEYS = [
  "ink",
  "inkRaised",
  "inkPanel",
  "inkHover",
  "border",
  "borderStrong",
  "linen",
  "linenMuted",
  "linenFaint",
  "ochre",
  "ochreHover",
  "teal",
  "danger",
] as const;

describe("品牌色板（BRAND）", () => {
  it("三个品牌色值与 S4 规格一致", () => {
    expect(BRAND.ink.toUpperCase()).toBe("#111318");
    expect(BRAND.linen.toUpperCase()).toBe("#F4EFE6");
    expect(BRAND.ochre.toUpperCase()).toBe("#C8763C");
  });

  it("所有实色都是合法 #rrggbb，半透明只允许 rgba()", () => {
    for (const key of SOLID_COLOR_KEYS) {
      expect(BRAND[key], `${key} 必须是 #rrggbb`).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(BRAND.ochreSoft).toMatch(/^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*[\d.]+\s*\)$/);
  });

  it("色板无重复色值（避免改一处漏一处）", () => {
    const values = Object.values(BRAND);
    expect(new Set(values).size).toBe(values.length);
  });

  it("正文对比度达到 WCAG AA/AAA：ink ↔ linen ≥ 7，ink ↔ linenMuted ≥ 4.5", () => {
    expect(contrastRatio(BRAND.ink, BRAND.linen)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(BRAND.linen, BRAND.ink)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(BRAND.ink, BRAND.linenMuted)).toBeGreaterThanOrEqual(4.5);
  });

  it("强调色/危险色在深墨底上仍可读（≥4.5）", () => {
    expect(contrastRatio(BRAND.ink, BRAND.ochre)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(BRAND.ink, BRAND.ochreHover)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(BRAND.ink, BRAND.danger)).toBeGreaterThanOrEqual(4.5);
  });

  it("徽标三级样式齐全且各自带排版字段", () => {
    expect(Object.keys(BADGE).sort()).toEqual(["neutral", "ok", "warn"]);
    for (const level of ["ok", "warn", "neutral"] as const) {
      expect(typeof BADGE[level].fontSize).toBe("number");
      expect(BADGE[level].fontSize as number).toBeGreaterThan(0);
      expect(typeof BADGE[level].borderRadius).toBe("number");
      expect(typeof BADGE[level].padding).toBe("string");
    }
  });

  it("自定义标题栏拖动区域常量形状正确", () => {
    const drag = DRAG_REGION as unknown as Record<string, unknown>;
    const noDrag = NO_DRAG_REGION as unknown as Record<string, unknown>;
    expect(drag.WebkitAppRegion).toBe("drag");
    expect(noDrag.WebkitAppRegion).toBe("no-drag");
  });
});
