/**
 * 轻量 Markdown 渲染器（无第三方依赖）：代码块 + GFM 表格 + 列表 + 标题 + 引用 + 行内格式。
 *
 * 单一产地：正文、思考、工具输出里的 Markdown 都走这里（App 不再自带第二份渲染）。
 * 纯展示组件；链接点击在 Loopsoar 内新标签打开。
 */
import * as React from "react";
import { BRAND } from "./theme.js";

/** 代码块：带语言标签与「复制」按钮。 */
function CodeBlock({ code, lang }: { code: string; lang: string }): React.ReactElement {
  const [copied, setCopied] = React.useState(false);
  const copy = (): void => {
    void navigator.clipboard
      ?.writeText(code)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      })
      .catch(() => {});
  };
  return (
    <div style={styles.codeWrap}>
      <div style={styles.codeHead}>
        <span style={styles.codeLang}>{lang || "code"}</span>
        <button type="button" className="msg-action" title="复制代码" onClick={copy} style={styles.codeCopy}>
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre style={styles.codeBlock}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** 行内：行内代码 / 粗体 / 斜体 / 链接。 */
function inlineRich(text: string): React.ReactNode {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g);
  return parts.map((part, pi) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={pi} style={styles.inlineCode}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={pi}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return <em key={pi}>{part.slice(1, -1)}</em>;
    }
    const link = /^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/.exec(part);
    if (link) {
      return (
        <a
          key={pi}
          href={link[2]}
          rel="noreferrer"
          style={styles.richLink}
          onClick={(event) => {
            event.preventDefault();
            void window.loopsoarAPI?.browser.newTab({ url: link[2] }).catch(() => {});
          }}
        >
          {link[1]}
        </a>
      );
    }
    return <React.Fragment key={pi}>{part}</React.Fragment>;
  });
}

/** 行级渲染（支持 GFM 表格）。 */
function renderPlainLines(block: string, bi: number): React.ReactNode[] {
  const lines = block.split(/\n/);
  const nodes: React.ReactNode[] = [];
  let list: string[] = [];
  let listKey = 0;
  const splitRow = (line: string): string[] =>
    line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  const flushList = (): void => {
    if (list.length === 0) return;
    const items = list;
    list = [];
    nodes.push(
      <ul key={`ul-${bi}-${listKey++}`} style={styles.richList}>
        {items.map((item, ii) => (
          <li key={ii} style={styles.richListItem}>{inlineRich(item)}</li>
        ))}
      </ul>,
    );
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].replace(/\s+$/, "");
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      flushList();
      const header = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      nodes.push(
        <div key={`tbl-${bi}-${nodes.length}`} style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>{header.map((cell, ci) => <th key={ci} style={styles.th}>{inlineRich(cell)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri}>{row.map((cell, ci) => <td key={ci} style={styles.td}>{inlineRich(cell)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (bullet) {
      list.push(bullet[1]);
      i += 1;
      continue;
    }
    flushList();
    if (!line.trim()) {
      nodes.push(<div key={`gap-${bi}-${nodes.length}`} style={{ height: 6 }} />);
      i += 1;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      nodes.push(
        <div key={`h-${bi}-${nodes.length}`} style={{ ...styles.richHeading, fontSize: heading[1].length <= 2 ? 16 : 14, marginTop: 10 }}>
          {inlineRich(heading[2])}
        </div>,
      );
      i += 1;
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      nodes.push(<div key={`q-${bi}-${nodes.length}`} style={styles.richQuote}>{inlineRich(quote[1])}</div>);
      i += 1;
      continue;
    }
    nodes.push(<div key={`p-${bi}-${nodes.length}`} style={styles.richPara}>{inlineRich(line)}</div>);
    i += 1;
  }
  flushList();
  return nodes;
}

/** 富文本入口：代码块与行级内容分段渲染。 */
export function renderRich(text: string): React.ReactNode {
  if (!text) return null;
  const blocks = text.split(/(```[\s\S]*?```)/g);
  return blocks.map((block, bi) => {
    if (block.startsWith("```")) {
      const head = /^```([^\n]*)/.exec(block)?.[1]?.trim() ?? "";
      const body = block.replace(/^```[^\n]*\n?/, "").replace(/```$/, "");
      return <CodeBlock key={`code-${bi}`} code={body} lang={head} />;
    }
    return <React.Fragment key={`text-${bi}`}>{renderPlainLines(block, bi)}</React.Fragment>;
  });
}

const styles: Record<string, React.CSSProperties> = {
  codeWrap: {
    margin: "8px 0",
    border: `1px solid ${BRAND.border}`,
    borderRadius: 8,
    overflow: "hidden",
    background: BRAND.ink,
  },
  codeHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "4px 8px",
    borderBottom: `1px solid ${BRAND.border}`,
    background: "rgba(255,255,255,0.03)",
  },
  codeLang: { fontSize: 10.5, color: BRAND.linenFaint, letterSpacing: 0.4 },
  codeCopy: {
    background: "transparent",
    border: "none",
    color: BRAND.linenFaint,
    cursor: "pointer",
    fontSize: 10.5,
    padding: 0,
  },
  codeBlock: {
    margin: 0,
    padding: "8px 10px",
    overflowX: "auto",
    fontSize: 12,
    lineHeight: 1.6,
    color: BRAND.linen,
    fontFamily: "ui-monospace, Consolas, monospace",
  },
  richHeading: { fontSize: 15, fontWeight: 650, color: BRAND.linen, lineHeight: 1.5, marginTop: 8 },
  richQuote: {
    margin: "6px 0",
    padding: "2px 0 2px 10px",
    borderLeft: `2px solid ${BRAND.ochre}`,
    color: BRAND.linenMuted,
    fontSize: 13,
  },
  richPara: { margin: "3px 0", whiteSpace: "pre-wrap" },
  richList: { margin: "4px 0", paddingLeft: 20 },
  richListItem: { margin: "2px 0" },
  inlineCode: {
    padding: "1px 4px",
    borderRadius: 4,
    background: "rgba(255,255,255,0.08)",
    fontSize: "0.92em",
    fontFamily: "ui-monospace, Consolas, monospace",
  },
  richLink: { color: BRAND.ochreHover, textDecoration: "none" },
  tableWrap: { overflowX: "auto", margin: "8px 0", border: `1px solid ${BRAND.border}`, borderRadius: 8 },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 12 },
  th: {
    textAlign: "left",
    padding: "6px 9px",
    background: "rgba(255,255,255,0.04)",
    borderBottom: `1px solid ${BRAND.border}`,
    color: BRAND.linen,
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  td: { padding: "6px 9px", borderBottom: `1px solid ${BRAND.border}`, color: BRAND.linenMuted, verticalAlign: "top" },
};
