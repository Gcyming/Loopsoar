import React from "react";
import { createRoot } from "react-dom/client";
import type { ChromePopoverKind } from "./types.js";
import ErrorBoundary from "./ErrorBoundary.js";

// React 19 + ReactDOM 客户端渲染入口，挂载到 index.html 的 #root。
// 严格模式开启，便于在占位阶段提前暴露副作用与生命周期问题。
const root = createRoot(document.getElementById("root") as HTMLElement);
// 独立浮层窗口：?popover=<kind> 时只渲染轻量菜单（由主进程子窗口加载）
const popoverKind = new URLSearchParams(location.search).get("popover");
// 只有主窗口需要启动加载面板。所有窗口共用 index.html，静态启动页必须在浮层/独立小窗
// 的入口处立刻移除，否则每个弹窗都会被「正在启动…」盖住且点不动（用户实测回归）。
const isMiniWindow = new URLSearchParams(location.search).get("mini") === "1";
if (popoverKind || isMiniWindow) {
  document.getElementById("boot-splash")?.remove();
} else {
  // 主窗口兜底：启动面板正常由 App 的启动门接管；数据异常时也不能让静态页永久挡住界面。
  window.setTimeout(() => document.getElementById("boot-splash")?.remove(), 8000);
}

// 全局兜底：渲染错误由 ErrorBoundary 接住；异步异常至少留下控制台线索。
window.addEventListener("error", (event) => {
  console.error("[Loopsoar] window error:", event.error ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  console.error("[Loopsoar] unhandled rejection:", event.reason);
});

/** 分片加载失败时也不能黑屏：给一个可操作的重载页。 */
function renderLoadError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  root.render(
    <React.StrictMode>
      <div style={loadErrorStyles.page}>
        <div style={loadErrorStyles.card}>
          <div style={loadErrorStyles.title}>界面加载失败</div>
          <div style={loadErrorStyles.message}>{message}</div>
          <button type="button" style={loadErrorStyles.button} onClick={() => window.location.reload()}>
            重新加载
          </button>
        </div>
      </div>
    </React.StrictMode>,
  );
}

// 关键：App 与 PopoverApp 必须拆成两个 chunk（动态 import）。
// 工具栏浮层每次打开都要冷启动一个渲染进程；如果入口静态 import App，浮层也要解析/执行
// 整个应用（含设置、ChromePage 等）才能画出 300×400 的菜单，表现为「每次都要等半天」。
if (popoverKind) {
  void import("./PopoverApp.js")
    .then(({ default: PopoverApp }) => {
      root.render(
        <React.StrictMode>
          <ErrorBoundary>
            <PopoverApp kind={popoverKind as ChromePopoverKind} />
          </ErrorBoundary>
        </React.StrictMode>,
      );
    })
    .catch(renderLoadError);
} else {
  void import("./App.js")
    .then(({ default: App }) => {
      root.render(
        <React.StrictMode>
          <ErrorBoundary>
            <App />
          </ErrorBoundary>
        </React.StrictMode>,
      );
    })
    .catch(renderLoadError);
}

const loadErrorStyles: Record<string, React.CSSProperties> = {
  page: {
    position: "fixed",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#111318",
    color: "#f3efe6",
    font: "13px/1.7 system-ui, 'Segoe UI', sans-serif",
    padding: 24,
  },
  card: {
    maxWidth: 560,
    width: "100%",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 12,
    padding: "20px 22px",
    background: "rgba(255,255,255,0.04)",
  },
  title: { fontSize: 15, fontWeight: 600, marginBottom: 8 },
  message: { color: "rgba(243,239,230,0.72)", whiteSpace: "pre-wrap", wordBreak: "break-word", marginBottom: 16 },
  button: {
    border: "1px solid rgba(255,255,255,0.18)",
    borderRadius: 8,
    background: "rgba(255,255,255,0.08)",
    color: "#f3efe6",
    padding: "7px 16px",
    cursor: "pointer",
  },
};
