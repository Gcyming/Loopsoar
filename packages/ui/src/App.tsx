import React, { useEffect, useState } from "react";
import type { LoopsoarAPI } from "./types.js";

// ui 包占位主窗口（§8 S7）。
// 布局：顶部地址与搜索一体框 | 中部浏览器视图占位区 + 右侧 Agent 对话占位面板 | 底部状态条。
// 当前阶段仅为可渲染的占位框，全部交互逻辑标注为后续阶段接入（D0 BrowserAdapter、shell preload 等）。

const TOP_BAR_HEIGHT = 48;
const SIDEBAR_WIDTH = 320;
const STATUS_BAR_HEIGHT = 32;

export default function App(): React.JSX.Element {
  const [bootStatus, setBootStatus] = useState<string>("加载中…");

  // 挂载时尝试调用 shell preload 暴露的 window.loopsoarAPI.runtime.bootStatus()。
  // 若不在 Electron shell 中运行（window.loopsoarAPI 不存在），显示「未在 shell 中运行」。
  useEffect(() => {
    const api = (window as unknown as { loopsoarAPI?: LoopsoarAPI }).loopsoarAPI;
    if (!api?.runtime?.bootStatus) {
      setBootStatus("未在 shell 中运行");
      return;
    }
    api.runtime
      .bootStatus()
      .then((result) => {
        setBootStatus(
          typeof result === "string" ? result : JSON.stringify(result ?? {})
        );
      })
      .catch(() => {
        setBootStatus("bootStatus 调用失败");
      });
  }, []);

  return (
    <div style={appContainerStyle}>
      {/* 顶部：地址与搜索一体框占位（输入框，暂无逻辑） */}
      <header style={topBarStyle}>
        <input
          type="text"
          placeholder="输入地址或搜索内容…"
          style={addressBarStyle}
          title="地址与搜索一体框占位，后续阶段接入浏览器导航与搜索逻辑"
        />
      </header>

      <div style={bodyStyle}>
        {/* 中部：浏览器视图占位区，D0 后接 BrowserAdapter */}
        <section style={browserViewStyle}>
          <div style={browserPlaceholderStyle}>
            浏览器视图占位区
            <br />
            <span style={hintStyle}>D0 后接 BrowserAdapter</span>
          </div>
        </section>

        {/* 右侧：Agent 对话占位面板 */}
        <aside style={sidebarStyle}>
          <div style={sidebarHeaderStyle}>Agent 对话</div>
          <div style={sidebarBodyStyle}>
            对话占位面板
            <br />
            <span style={hintStyle}>后续阶段接入 chat:* / perm:* 通道</span>
          </div>
        </aside>
      </div>

      {/* 底部：状态条，显示 boot:status 结果 */}
      <footer style={statusBarStyle}>
        <span style={statusLabelStyle}>boot:status</span>
        <span style={statusValueStyle}>{bootStatus}</span>
      </footer>
    </div>
  );
}

// ---------- 以下为占位阶段的内联样式（保持文件自包含，后续阶段可迁出 CSS 模块） ----------

const appContainerStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100vh",
  margin: 0,
  fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  background: "#0b1021",
  color: "#e8eaed",
  boxSizing: "border-box"
};

const topBarStyle: React.CSSProperties = {
  height: TOP_BAR_HEIGHT,
  background: "#151b2b",
  borderBottom: "1px solid #2a334d",
  display: "flex",
  alignItems: "center",
  padding: "0 16px",
  boxSizing: "border-box",
  flexShrink: 0
};

const addressBarStyle: React.CSSProperties = {
  flex: 1,
  height: 32,
  padding: "0 12px",
  border: "1px solid #2a334d",
  borderRadius: 6,
  background: "#0b1021",
  color: "#e8eaed",
  fontSize: 14,
  outline: "none",
};

const bodyStyle: React.CSSProperties = {
  display: "flex",
  flex: 1,
  minHeight: 0,
  overflow: "hidden"
};

const browserViewStyle: React.CSSProperties = {
  flex: 1,
  borderRight: "1px solid #2a334d",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "#0f1526",
  minWidth: 0
};

const browserPlaceholderStyle: React.CSSProperties = {
  color: "#6b7280",
  fontSize: 16,
  textAlign: "center",
  lineHeight: 1.5
};

const hintStyle: React.CSSProperties = {
  color: "#9ca3af",
  fontSize: 13,
  marginTop: 6,
  display: "block"
};

const sidebarStyle: React.CSSProperties = {
  width: SIDEBAR_WIDTH,
  borderLeft: "1px solid #2a334d",
  background: "#151b2b",
  display: "flex",
  flexDirection: "column",
  flexShrink: 0
};

const sidebarHeaderStyle: React.CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid #2a334d",
  fontWeight: 600,
  fontSize: 15,
  color: "#e8eaed"
};

const sidebarBodyStyle: React.CSSProperties = {
  padding: 16,
  color: "#9ca3af",
  fontSize: 14,
  lineHeight: 1.5,
  flex: 1
};

const statusBarStyle: React.CSSProperties = {
  height: STATUS_BAR_HEIGHT,
  background: "#151b2b",
  borderTop: "1px solid #2a334d",
  display: "flex",
  alignItems: "center",
  padding: "0 16px",
  boxSizing: "border-box",
  flexShrink: 0,
  fontSize: 13,
  color: "#9ca3af"
};

const statusLabelStyle: React.CSSProperties = {
  marginRight: 10,
  fontWeight: 600,
  color: "#cbd5e1"
};

const statusValueStyle: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace"
};