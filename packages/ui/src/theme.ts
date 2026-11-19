/**
 * 品牌色板 + 主题 token（UI 单一来源）。
 *
 * 双主题：`soft`（默认，柔和无框）/ `classic`（旧观感，保留）。
 * 所有颜色都是 CSS 变量引用（带原值 fallback）：
 *   · index.html 的 `:root` 定义 soft 值；
 *   · `html[data-theme="classic"]` 覆盖回旧值；
 * 因此组件内联样式 `BRAND.ink` 自动跟随主题，组件本身无需感知主题切换。
 *
 * 用法：`applyTheme("classic")` 切主题（加 200ms 颜色过渡 class）；设置面板/Settings 由 App 接线。
 */
import { LAYOUT } from "loopsoar-contracts/layout";

const cssVar = (token: string, fallback: string): string => `var(--${token}, ${fallback})`;
const sidebarMs = `${LAYOUT.SIDEBAR_MOTION_MS}ms`;

export type ThemeName = "soft" | "classic";
export const DEFAULT_THEME: ThemeName = "soft";
export const THEMES: readonly ThemeName[] = ["soft", "classic"];

export const BRAND = {
  ink: cssVar("ls-bg", "#111318"),
  inkRaised: cssVar("ls-surface-raised", "#17191e"),
  inkPanel: cssVar("ls-surface", "#15171c"),
  inkHover: cssVar("ls-surface-hover", "#1e2127"),
  border: cssVar("ls-border", "#262a31"),
  borderStrong: cssVar("ls-border-strong", "#333842"),
  linen: cssVar("ls-text", "#f4efe6"),
  linenMuted: cssVar("ls-text-muted", "#a8a29a"),
  linenFaint: cssVar("ls-text-faint", "#6f6a63"),
  ochre: cssVar("ls-accent", "#c8763c"),
  ochreHover: cssVar("ls-accent-hover", "#d98a4f"),
  ochreSoft: cssVar("ls-accent-soft", "rgba(200,118,60,0.16)"),
  teal: cssVar("ls-teal", "#5eead4"),
  tealSoft: cssVar("ls-teal-soft", "rgba(94,234,212,0.14)"),
  danger: cssVar("ls-danger", "#f87171"),
  dangerSoft: cssVar("ls-danger-soft", "rgba(248,113,113,0.14)"),
} as const;

/** 圆角 token：soft 主题在 index.html 里给更大值；classic 保持旧观感。 */
export const RADIUS = {
  sm: cssVar("ls-radius-sm", "8px"),
  md: cssVar("ls-radius-md", "12px"),
  lg: cssVar("ls-radius-lg", "16px"),
  pill: "999px",
} as const;

/** 阴影 token：soft 主题用柔和投影代替描边建立层级。 */
export const SHADOW = {
  card: cssVar("ls-shadow-card", "0 8px 32px rgba(0,0,0,0.35)"),
  float: cssVar("ls-shadow-float", "0 24px 64px rgba(0,0,0,0.55)"),
  none: "none",
} as const;

/** 动效 token：交互 120/80ms、主题 200ms、侧栏 320ms、终端 240ms（与设计规范一致）。 */
export const MOTION = {
  fast: "120ms",
  active: "80ms",
  themeSwitch: "200ms",
  sidebarDuration: sidebarMs,
  terminalDuration: "240ms",
  popoverDuration: "140ms",
  ease: "cubic-bezier(0.2, 0, 0.2, 1)",
  easeOut: "ease-out",
  /** 通用 hover/active 过渡（只变色，不位移）。 */
  hover: "background-color 120ms ease-out, border-color 120ms ease-out, color 120ms ease-out",
  /** 侧栏 collapsed/float：宽度与透明度同步过渡。 */
  sidebar:
    `width ${sidebarMs} cubic-bezier(0.2, 0, 0.2, 1), opacity ${sidebarMs} cubic-bezier(0.2, 0, 0.2, 1), margin ${sidebarMs} cubic-bezier(0.2, 0, 0.2, 1), border-radius ${sidebarMs} cubic-bezier(0.2, 0, 0.2, 1)`,
  /** 终端面板拉起/收起：高度过渡。 */
  terminal: `height 240ms cubic-bezier(0.2, 0, 0.2, 1), border-radius 240ms cubic-bezier(0.2, 0, 0.2, 1)`,
} as const;

/** Electron 自定义标题栏拖动区域（非标准 CSS 属性，需断言类型）。 */
export const DRAG_REGION = { WebkitAppRegion: "drag" } as unknown as React.CSSProperties;
export const NO_DRAG_REGION = { WebkitAppRegion: "no-drag" } as unknown as React.CSSProperties;

/** 小徽标样式（设置面板等复用）：soft 主题下自动换成低对比底 + 柔和投影。 */
export const BADGE: Record<"ok" | "warn" | "neutral", React.CSSProperties> = {
  ok: {
    fontSize: 10.5,
    padding: "2px 7px",
    borderRadius: 999,
    background: BRAND.tealSoft,
    color: BRAND.teal,
  },
  warn: {
    fontSize: 10.5,
    padding: "2px 7px",
    borderRadius: 999,
    background: BRAND.ochreSoft,
    color: BRAND.ochreHover,
  },
  neutral: {
    fontSize: 10,
    padding: "1px 6px",
    borderRadius: 999,
    background: BRAND.ink,
    border: `1px solid ${BRAND.border}`,
    color: BRAND.linenMuted,
  },
};

/* ------------------------------ 主题切换 ------------------------------ */

const THEME_SWITCH_CLASS = "theme-switching";
const THEME_SWITCH_MS = 240;

/** 当前主题（未设置时按默认 soft）。 */
export function getTheme(): ThemeName {
  if (typeof document === "undefined") return DEFAULT_THEME;
  return document.documentElement.dataset.theme === "classic" ? "classic" : DEFAULT_THEME;
}

/**
 * 应用主题：写 `html[data-theme]`，并在切换瞬间挂 `.theme-switching`，
 * 让全局 CSS 的 200ms 颜色过渡只作用于切换过程（不影响 hover/布局动画）。
 * `prefers-reduced-motion` 下不挂过渡 class。
 */
export function applyTheme(theme: ThemeName): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (root.dataset.theme === theme) return;
  const reduceMotion =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false;
  root.dataset.theme = theme;
  if (reduceMotion) return;
  root.classList.add(THEME_SWITCH_CLASS);
  if (typeof window !== "undefined") {
    window.setTimeout(() => root.classList.remove(THEME_SWITCH_CLASS), THEME_SWITCH_MS);
  }
}
