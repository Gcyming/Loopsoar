/**
 * 品牌色板 / 主题 token 用例（第 6 轮 soft/classic 双主题后重写）：
 *   - BRAND 全部颜色改为 CSS 变量引用（`var(--ls-…, fallback)`），fallback 仍是 S4 规格的品牌色；
 *   - index.html 的 `:root` 定义 soft 主题 token，`html[data-theme="classic"]` 覆盖为旧观感；
 *   - 两套主题的正文/强调色对比度都达到 WCAG AA（正文 ≥7 / 次要 ≥4.5 / 强调 ≥4.5）；
 *   - 变量引用格式合法、token 无重复、classic 覆盖不缺失关键 token；
 *   - 徽标与拖动区域常量形状不变。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { BADGE, BRAND, DRAG_REGION, NO_DRAG_REGION } from "../../packages/ui/src/theme.ts";

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

function luminance(hex: string): number {
  const { r, g, b } = hexToLinearRgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [light, dark] = la >= lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

/** 从 `var(--token, fallback)` 中拆出 token 与 fallback。 */
function parseVarRef(value: string): { token: string; fallback: string } {
  const m = /^var\(\s*--([a-z0-9-]+)\s*,\s*(.+?)\s*\)$/i.exec(value.trim());
  if (!m) throw new Error(`不是 CSS 变量引用：${value}`);
  return { token: `--${m[1]}`, fallback: m[2] };
}

const HTML = readFileSync(path.join(process.cwd(), "packages/ui/index.html"), "utf8");

/** 提取某个 CSS 块里的 `--ls-*` token 值（只取第一处匹配块）。 */
function extractTokens(blockPattern: RegExp): Map<string, string> {
  const block = blockPattern.exec(HTML)?.[0] ?? "";
  const tokens = new Map<string, string>();
  for (const m of block.matchAll(/--ls-([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    tokens.set(`--ls-${m[1]}`, m[2].trim());
  }
  return tokens;
}

const SOFT = extractTokens(/:root\s*\{[^}]*\}/i);
const CLASSIC = extractTokens(/html\[data-theme="classic"\]\s*\{[^}]*\}/i);

describe("品牌色板（BRAND）与主题 token", () => {
  it("BRAND 全部是 CSS 变量引用，fallback 保留 S4 品牌色", () => {
    const ink = parseVarRef(BRAND.ink);
    const linen = parseVarRef(BRAND.linen);
    const ochre = parseVarRef(BRAND.ochre);
    expect(ink.fallback.toUpperCase()).toBe("#111318");
    expect(linen.fallback.toUpperCase()).toBe("#F4EFE6");
    expect(ochre.fallback.toUpperCase()).toBe("#C8763C");
  });

  it("所有颜色都是合法 var(...)，half-transparent 也走变量", () => {
    for (const [key, value] of Object.entries(BRAND)) {
      const { token, fallback } = parseVarRef(value);
      expect(token, `${key} token 命名`).toMatch(/^--ls-[a-z0-9-]+$/);
      expect(
        /^#[0-9a-f]{6}$/i.test(fallback) ||
          /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*[\d.]+\s*\)$/i.test(fallback),
        `${key} fallback 必须是 hex 或 rgba()：${fallback}`,
      ).toBe(true);
    }
  });

  it("token 无重复（同一份色板不该有两个键指向同一变量）", () => {
    const tokens = Object.values(BRAND).map((value) => parseVarRef(value).token);
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it("index.html 定义 soft 默认 token，且 classic 覆盖回旧观感", () => {
    expect(SOFT.size).toBeGreaterThanOrEqual(20);
    for (const token of ["--ls-bg", "--ls-surface", "--ls-text", "--ls-accent", "--ls-border"]) {
      expect(SOFT.has(token), `soft 缺少 ${token}`).toBe(true);
    }
    expect(SOFT.get("--ls-bg")?.toUpperCase()).toBe("#0A0C10");
    expect(CLASSIC.get("--ls-bg")?.toUpperCase()).toBe("#111318");
    expect(CLASSIC.get("--ls-border")?.toUpperCase()).toBe("#262A31");
    // BRAND 引用到的每个 token 必须在前景（soft 或 classic）有定义
    for (const value of Object.values(BRAND)) {
      const { token } = parseVarRef(value);
      expect(SOFT.has(token) || CLASSIC.has(token), `未定义 token：${token}`).toBe(true);
    }
  });

  it("soft 主题对比度：正文 ≥7，次要/强调/危险 ≥4.5", () => {
    const bg = SOFT.get("--ls-bg") as string;
    const text = SOFT.get("--ls-text") as string;
    const muted = SOFT.get("--ls-text-muted") as string;
    const accent = SOFT.get("--ls-accent") as string;
    const danger = SOFT.get("--ls-danger") as string;
    expect(contrastRatio(bg, text)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(bg, muted)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(bg, accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(bg, danger)).toBeGreaterThanOrEqual(4.5);
  });

  it("classic 主题对比度：正文 ≥7，次要/强调/危险 ≥4.5（旧观感仍可读）", () => {
    const bg = CLASSIC.get("--ls-bg") as string;
    const text = CLASSIC.get("--ls-text") as string;
    const muted = CLASSIC.get("--ls-text-muted") as string;
    const accent = CLASSIC.get("--ls-accent") as string;
    const danger = CLASSIC.get("--ls-danger") as string;
    expect(contrastRatio(bg, text)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(bg, muted)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(bg, accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(bg, danger)).toBeGreaterThanOrEqual(4.5);
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
