/**
 * 浏览器区起始页（从 App 抽出）：原生 WebContentsView 未显示时铺满左侧面板的占位内容。
 *
 * 纯展示：只读 `currentUrl` 决定文案（打开页面后作为品牌页，未打开时为"新建标签页"引导）。
 * 真正的网页由主进程的 WebContentsView 覆盖在同一区域，本组件不参与原生视图布局。
 */
import * as React from "react";
import { LAYOUT } from "loopsoar-contracts/layout";
import { BRAND } from "./theme.js";
import { Icon } from "./Icon.js";
import { useT } from "./i18n.js";

export interface StartPageProps {
  /** 当前活动标签的 URL；空串 = 新建标签页。 */
  currentUrl: string;
}

export default function StartPage({ currentUrl }: StartPageProps): React.JSX.Element {
  const tr = useT();
  return (
    <section style={styles.browserPane}>
      <div style={styles.startPage}>
        <div style={styles.startMark}>
          <img src="./logo.png" alt="Loopsoar" width={64} height={64} />
        </div>
        <div style={styles.startTitle}>{currentUrl ? "Loopsoar" : tr("browser.startNewTabTitle")}</div>
        <div style={styles.startSubtitle}>
          {currentUrl ? tr("browser.tagline") : tr("browser.startSubtitle")}
        </div>
        <div style={styles.startHints}>
          <div style={styles.hintRow}>
            <Icon name="arrow-go" size={14} style={styles.hintIcon} />
            <span>{tr("browser.startHintNavigate")}</span>
          </div>
          <div style={styles.hintRow}>
            <Icon name="agent" size={14} style={styles.hintIcon} />
            <span>{tr("browser.startHintAgent")}</span>
          </div>
          <div style={styles.hintRow}>
            <Icon name="capture" size={14} style={styles.hintIcon} />
            <span>{tr("browser.startHintNative")}</span>
          </div>
        </div>
        <div style={styles.startUrl}>
          {currentUrl ? tr("browser.currentPage", { url: currentUrl }) : tr("browser.noPageOpen")}
        </div>
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
    // 网页面板：四边留白 + 圆角 + 裁切，与原生 WebContentsView 的 inset/圆角共用同一契约值，
    // 页面不再顶到窗口边缘（用户反馈的「硬朗直角」）。
    margin: LAYOUT.BROWSER_VIEW_INSET,
    borderRadius: LAYOUT.BROWSER_VIEW_RADIUS,
    overflow: "hidden",
    boxSizing: "border-box",
    background: `radial-gradient(circle at 28% 18%, rgba(var(--ls-accent-rgb, 200, 118, 60),0.10) 0%, ${BRAND.ink} 58%)`,
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
