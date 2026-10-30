/**
 * ToolCard —— 工具调用卡（对齐 slime 会话里的工具/终端/网址卡片样式）。
 *
 * 展示：工具名 + 关键参数摘要 + 状态；可展开查看完整参数与输出（等宽、可复制、可滚动）。
 * 特殊渲染：输出里出现 http(s) 链接 → 可点击链接卡；URL/标题行 → 浏览器快照摘要。
 * 纯展示组件（无 IPC）。
 */
import * as React from "react";
import { BRAND } from "./theme.js";

export interface ToolCardData {
  id: string;
  name: string;
  args?: unknown;
  result?: { ok?: boolean; content?: string; error?: string } | null;
  state: "running" | "done" | "error";
}

function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  const preferred = ["url", "target", "selector", "query", "path", "text", "command", "direction"];
  for (const key of preferred) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.length > 60 ? `${value.slice(0, 60)}…` : value;
    }
  }
  const json = JSON.stringify(args);
  return json === "{}" ? "" : json.length > 60 ? `${json.slice(0, 60)}…` : json;
}

function extractUrls(content: string): string[] {
  const matches = content.match(/https?:\/\/[^\s"'<>)\]]+/g) ?? [];
  return [...new Set(matches)].slice(0, 4);
}

export default function ToolCard({ tool }: { tool: ToolCardData }): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false);
  const resultText = tool.result?.content ?? tool.result?.error ?? "";
  const ok = tool.result?.ok !== false;
  const stateText = tool.state === "running" ? "进行中" : tool.state === "error" ? "失败" : ok ? "完成" : "失败";
  const stateColor = tool.state === "running" ? BRAND.ochreHover : tool.state === "error" || !ok ? "#f87171" : "#4ade80";
  const urls = tool.state !== "running" ? extractUrls(resultText) : [];
  const summary = summarizeArgs(tool.args);
  const isBrowserSnapshot = tool.name === "browser_snapshot" && resultText.includes("URL:");
  const preview = isBrowserSnapshot
    ? resultText.split("\n").slice(0, 3).join("\n")
    : resultText.replace(/\s+/g, " ").slice(0, 120);

  return (
    <div style={styles.card} className="tool-card">
      <button type="button" style={styles.head} onClick={() => setExpanded((v) => !v)} title={expanded ? "收起工具详情" : "展开工具详情"}>
        <span style={styles.icon}>
          <IconGlyph name={tool.name} />
        </span>
        <span style={styles.name}>{tool.name}</span>
        {summary ? <span style={styles.args} title={JSON.stringify(tool.args)}>{summary}</span> : null}
        <span style={{ ...styles.state, color: stateColor, borderColor: `${stateColor}55` }}>{stateText}</span>
        <span style={{ ...styles.chevron, transform: expanded ? "rotate(-90deg)" : "rotate(90deg)" }}>›</span>
      </button>
      {!expanded && preview ? <div style={styles.preview}>{preview}</div> : null}
      {urls.length > 0 && !expanded ? (
        <div style={styles.links}>
          {urls.map((url) => (
            <a
              key={url}
              href={url}
              style={styles.link}
              title={url}
              onClick={(event) => {
                event.preventDefault();
                void window.loopsoarAPI?.browser.newTab({ url }).catch(() => {});
              }}
            >
              🔗 {url.replace(/^https?:\/\//, "").slice(0, 56)}
            </a>
          ))}
        </div>
      ) : null}
      <div style={{ ...styles.body, ...(expanded ? styles.bodyOpen : styles.bodyClosed) }}>
        {tool.args !== undefined ? (
          <>
            <div style={styles.sectionLabel}>参数</div>
            <pre style={styles.pre}>{JSON.stringify(tool.args, null, 2)}</pre>
          </>
        ) : null}
        {resultText ? (
          <>
            <div style={styles.sectionLabel}>输出</div>
            <pre style={styles.pre}>{resultText.slice(0, 6000)}{resultText.length > 6000 ? "\n…（已截断）" : ""}</pre>
          </>
        ) : null}
        {urls.length > 0 ? (
          <div style={styles.links}>
            {urls.map((url) => (
              <a
                key={url}
                href={url}
                style={styles.link}
                onClick={(event) => {
                  event.preventDefault();
                  void window.loopsoarAPI?.browser.newTab({ url }).catch(() => {});
                }}
              >
                🔗 {url}
              </a>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function IconGlyph({ name }: { name: string }): React.ReactElement {
  const label = name.includes("browser")
    ? "🌐"
    : name.includes("fetch") || name.includes("http")
      ? "⇣"
      : name.includes("file")
        ? "📄"
        : name.includes("mcp")
          ? "🧩"
          : "⚙";
  return <span style={{ fontSize: 11 }}>{label}</span>;
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    margin: "4px 0 6px",
    border: `1px solid ${BRAND.border}`,
    borderRadius: 9,
    background: "rgba(17, 19, 24, 0.6)",
    overflow: "hidden",
    transition: "border-color 140ms ease, background 140ms ease",
  },
  head: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    width: "100%",
    padding: "6px 9px",
    border: "none",
    background: "transparent",
    color: BRAND.linen,
    cursor: "pointer",
    textAlign: "left",
    fontSize: 11.5,
  },
  icon: { flex: "none", opacity: 0.9 },
  name: { fontWeight: 600, flex: "none", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  args: { color: BRAND.linenFaint, fontSize: 10.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 },
  state: { flex: "none", fontSize: 9.5, padding: "0 5px", borderRadius: 999, border: "1px solid" },
  chevron: { flex: "none", color: BRAND.linenFaint, fontSize: 12, transition: "transform 140ms ease" },
  preview: {
    padding: "0 10px 6px 28px",
    fontSize: 10.5,
    color: BRAND.linenMuted,
    whiteSpace: "pre-wrap",
    maxHeight: 44,
    overflow: "hidden",
    lineHeight: 1.5,
  },
  links: { display: "flex", flexWrap: "wrap", gap: 5, padding: "0 10px 7px 28px" },
  link: {
    fontSize: 10.5,
    color: BRAND.ochreHover,
    background: BRAND.ochreSoft,
    border: `1px solid ${BRAND.border}`,
    borderRadius: 6,
    padding: "2px 7px",
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    textDecoration: "none",
  },
  body: { overflow: "hidden", padding: "0 10px" },
  bodyOpen: { maxHeight: 520, overflowY: "auto", paddingBottom: 8, transition: "max-height 220ms ease, padding 220ms ease" },
  bodyClosed: { maxHeight: 0, transition: "max-height 180ms ease, padding 180ms ease" },
  sectionLabel: { fontSize: 9.5, color: BRAND.linenFaint, margin: "6px 0 2px", letterSpacing: 0.5 },
  pre: {
    margin: 0,
    padding: 8,
    borderRadius: 6,
    background: BRAND.ink,
    border: `1px solid ${BRAND.border}`,
    fontSize: 10.5,
    lineHeight: 1.55,
    color: BRAND.linenMuted,
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    fontFamily: "ui-monospace, Consolas, monospace",
    maxHeight: 240,
    overflowY: "auto",
  },
};
