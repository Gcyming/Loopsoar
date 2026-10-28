import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";

// React 19 + ReactDOM 客户端渲染入口，挂载到 index.html 的 #root。
// 严格模式开启，便于在占位阶段提前暴露副作用与生命周期问题。
const root = createRoot(document.getElementById("root") as HTMLElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);