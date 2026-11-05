/**
 * 底部状态栏（从 App 抽出）：shell 启动状态 / Agent 名 / 供应商-模型 / 当前地址 / 终端开关。
 *
 * 纯展示：数据全部由 App 传入；终端按钮只回调开合，面板与高度持久化由 App 负责。
 * 高度取契约常量 LAYOUT.STATUS_BAR_HEIGHT（UI 不硬编码尺寸）。
 */
import * as React from "react";
import { LAYOUT } from "loopsoar-contracts/layout";
import { BRAND } from "./theme.js";
import { Icon } from "./Icon.js";
import { useT } from "./i18n.js";

export interface StatusBarProps {
  /** shell 启动状态（boot?.status）；未取到前为 undefined。 */
  shellStatus?: string;
  agentLabel: string;
  providerLabel: string;
  currentUrl: string;
  terminalOpen: boolean;
  onToggleTerminal: () => void;
}

export default function StatusBar({
  shellStatus,
  agentLabel,
  providerLabel,
  currentUrl,
  terminalOpen,
  onToggleTerminal,
}: StatusBarProps): React.JSX.Element {
  const tr = useT();
  return (
    <footer style={{ ...styles.statusBar, height: LAYOUT.STATUS_BAR_HEIGHT }}>
      <span style={styles.statusItem}>
        <span className="live-dot" style={styles.liveDot} />
        shell: {shellStatus ?? "—"}
      </span>
      <span style={styles.statusItem}>agent: {agentLabel}</span>
      <span style={styles.statusItem}>{providerLabel}</span>
      <span style={{ ...styles.statusItem, ...styles.statusUrl }}>{currentUrl || "about:start"}</span>
      <button
        type="button"
        className="chip"
        style={{ ...styles.chip, ...styles.terminalToggle, ...(terminalOpen ? styles.terminalToggleOpen : {}) }}
        title={terminalOpen ? tr("browser.terminalToggleOpen") : tr("browser.terminalToggleClose")}
        aria-label={terminalOpen ? tr("browser.terminalToggleAriaOpen") : tr("browser.terminalToggleAriaClose")}
        aria-pressed={terminalOpen}
        onClick={onToggleTerminal}
      >
        <Icon name="terminal" size={12} />
        {tr("browser.terminalToggleLabel")}
      </button>
    </footer>
  );
}

const styles: Record<string, React.CSSProperties> = {
  statusBar: {
    display: "flex",
    alignItems: "center",
    gap: 18,
    padding: "0 12px",
    // 底栏与工具条/会话栏使用同一块抬高面：页框下方的外框一直延伸到底，
    // 不再用分隔线切断（用户反馈「条框的影子」）。
    background: BRAND.inkRaised,
    fontSize: 11,
    color: BRAND.linenFaint,
    flexShrink: 0,
  },
  statusItem: { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  liveDot: { marginRight: 6, verticalAlign: "1px" },
  statusUrl: { marginLeft: "auto", fontFamily: "ui-monospace, Consolas, monospace", color: BRAND.linenFaint },
  /** 与 Agent 侧栏 chip 共用底样式（高度/字号单独收窄）。 */
  chip: {
    display: "inline-flex",
    alignItems: "center",
    height: 24,
    padding: "0 8px",
    borderRadius: 12,
    border: `1px solid ${BRAND.border}`,
    background: "transparent",
    color: BRAND.linenMuted,
    fontSize: 11,
    cursor: "pointer",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  /** 状态栏「终端」按钮：打开时用品牌赭石强调。 */
  terminalToggle: {
    height: 22,
    gap: 4,
    padding: "0 8px",
    flexShrink: 0,
    fontSize: 10.5,
  },
  terminalToggleOpen: {
    background: BRAND.ochreSoft,
    borderColor: "rgba(var(--ls-accent-rgb, 200, 118, 60),0.55)",
    color: BRAND.ochreHover,
  },
};
