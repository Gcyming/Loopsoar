/**
 * 品牌色板（UI 单一来源）：来自官方图标三色。
 * 为什么单独成文件：设置面板、主界面、后续所有界面共用同一份色值，
 * 避免「这里改一下、那里漏一个」的漂移。
 */
export const BRAND = {
  ink: "#111318",
  inkRaised: "#17191e",
  inkPanel: "#15171c",
  inkHover: "#1e2127",
  border: "#262a31",
  borderStrong: "#333842",
  linen: "#f4efe6",
  linenMuted: "#a8a29a",
  linenFaint: "#6f6a63",
  ochre: "#c8763c",
  ochreHover: "#d98a4f",
  ochreSoft: "rgba(200,118,60,0.16)",
  teal: "#5eead4",
  danger: "#f87171",
} as const;

/** Electron 自定义标题栏拖动区域（非标准 CSS 属性，需断言类型）。 */
export const DRAG_REGION = { WebkitAppRegion: "drag" } as unknown as React.CSSProperties;
export const NO_DRAG_REGION = { WebkitAppRegion: "no-drag" } as unknown as React.CSSProperties;

/** 小徽标样式（设置面板等复用）。 */
export const BADGE: Record<"ok" | "warn" | "neutral", React.CSSProperties> = {
  ok: {
    fontSize: 10.5,
    padding: "2px 7px",
    borderRadius: 999,
    background: "rgba(94,234,212,0.14)",
    color: "#5eead4",
  },
  warn: {
    fontSize: 10.5,
    padding: "2px 7px",
    borderRadius: 999,
    background: "rgba(200,118,60,0.18)",
    color: "#d98a4f",
  },
  neutral: {
    fontSize: 10,
    padding: "1px 6px",
    borderRadius: 999,
    background: "#111318",
    border: "1px solid #262a31",
    color: "#a8a29a",
  },
};
