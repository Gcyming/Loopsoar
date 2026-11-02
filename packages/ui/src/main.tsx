import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import PopoverApp from "./PopoverApp.js";
import type { ChromePopoverKind } from "./types.js";

// React 19 + ReactDOM 客户端渲染入口，挂载到 index.html 的 #root。
// 严格模式开启，便于在占位阶段提前暴露副作用与生命周期问题。
const root = createRoot(document.getElementById("root") as HTMLElement);
// 独立浮层窗口：?popover=<kind> 时只渲染轻量菜单（由主进程子窗口加载）
const popoverKind = new URLSearchParams(location.search).get("popover");
root.render(
  <React.StrictMode>
    {popoverKind ? <PopoverApp kind={popoverKind as ChromePopoverKind} /> : <App />}
  </React.StrictMode>
);