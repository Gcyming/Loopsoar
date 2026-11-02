/**
 * 浏览器区起始页（从 App 抽出）：原生 WebContentsView 未显示时铺满左侧面板的占位内容。
 *
 * 纯展示：只读 `currentUrl` 决定文案（打开页面后作为品牌页，未打开时为"新建标签页"引导）。
 * 真正的网页由主进程的 WebContentsView 覆盖在同一区域，本组件不参与原生视图布局。
 */
import * as React from "react";
import { BRAND } from "./theme.js";
import { Icon } from "./Icon.js";

export interface StartPageProps {
  /** 当前活动标签的 URL；空串 = 新建标签页。 */
  currentUrl: string;
}

export default function StartPage({ currentUrl }: StartPageProps): React.JSX.Element {
  return (
    <section style={styles.browserPane}>
      <div style={styles.startPage}>
        <div style={styles.startMark}>
          <img src="./logo.png" alt="Loopsoar" width={64} height={64} />
        </div>
        <div style={styles.startTitle}>{currentUrl ? "Loopsoar" : "新建标签页"}</div>
        <div style={styles.startSubtitle}>
          {currentUrl ? "浏览器优先的本地 AI Agent" : "在顶部输入网址或搜索内容，回车开始"}
        </div>
        <div style={styles.startHints}>
          <div style={styles.hintRow}>
            <Icon name="arrow-go" size={14} style={styles.hintIcon} />
            <span>在顶部输入网址或搜索内容，回车打开页面</span>
          </div>
          <div style={styles.hintRow}>
            <Icon name="agent" size={14} style={styles.hintIcon} />
            <span>右侧与 Agent 对话：授权范围内读写文件、执行命令、操控网页</span>
          </div>
          <div style={styles.hintRow}>
            <Icon name="capture" size={14} style={styles.hintIcon} />
            <span>原生浏览器视图会覆盖此区域（WebContentsView · D0 已验证）</span>
          </div>
        </div>
        <div style={styles.startUrl}>{currentUrl ? `当前页面：${currentUrl}` : "尚未打开网页"}</div>
      </div>
    </section>
  );
}

const styles: Record<string, React.CSSProperties> = {
  browserPane: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: `radial-gradient(circle at 28% 18%, rgba(200,118,60,0.10) 0%, ${BRAND.ink} 58%)`,
  },
  startPage: { maxWidth: 520, padding: 28, textAlign: "left" },
  startMark: { marginBottom: 18, opacity: 0.95 },
  startTitle: { fontSize: 32, fontWeight: 800, letterSpacing: 0.4, color: BRAND.linen },
  startSubtitle: { marginTop: 6, fontSize: 13.5, color: BRAND.ochreHover, letterSpacing: 0.2 },
  startHints: { marginTop: 20, display: "grid", gap: 9 },
  hintRow: { display: "flex", alignItems: "flex-start", gap: 8, color: BRAND.linenMuted, fontSize: 12.5, lineHeight: 1.6 },
  hintIcon: { marginTop: 3, color: BRAND.ochre, opacity: 0.9 },
  startUrl: { marginTop: 20, fontSize: 11.5, color: BRAND.linenFaint },
};
