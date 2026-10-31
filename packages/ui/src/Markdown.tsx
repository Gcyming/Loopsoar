/**
 * 轻量 Markdown 渲染器（无第三方依赖）：代码块 + GFM 表格 + 列表 + 标题 + 引用 + 行内格式。
 *
 * 单一产地：正文、思考、工具输出里的 Markdown 都走这里（App 不再自带第二份渲染）。
 * 纯展示组件；链接点击在 Loopsoar 内新标签打开。
 */
import * as React from "react";
import { BRAND } from "./theme.js";

/** 代码块：带语言标签与「复制」按钮。 */
function CodeBlock({ code, lang, compact = false }: { code: string; lang: string; compact?: boolean }): React.ReactElement {
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
      <pre style={{ ...styles.codeBlock, ...(compact ? styles.codeBlockCompact : null) }}>
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

/** 行级渲染（GFM 表格 / 列表 / 标题 / 引用 / 分隔线 / 段落）。 */
function renderPlainLines(block: string, bi: number, compact = false): React.ReactNode[] {
  const lines = block.split(/\n/);
  const nodes: React.ReactNode[] = [];
  let list: string[] = [];
  let listOrdered = false;
  let listKey = 0;
  /** 段落缓冲：连续的普通文本行按 Markdown 软换行合并成一段，而不是每行一个 div。 */
  let paragraph: string[] = [];
  const splitRow = (line: string): string[] =>
    line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    const text = paragraph.join(" ").replace(/\s+/g, " ").trim();
    paragraph = [];
    if (!text) return;
    nodes.push(
      <div key={`p-${bi}-${nodes.length}`} style={{ ...styles.richPara, ...(compact ? styles.compactPara : null) }}>
        {inlineRich(text)}
      </div>,
    );
  };
  const flushList = (): void => {
    if (list.length === 0) return;
    const items = list;
    const ordered = listOrdered;
    list = [];
    listOrdered = false;
    const listStyle = { ...styles.richList, ...(compact ? styles.compactList : null) };
    nodes.push(
      ordered ? (
        <ol key={`ol-${bi}-${listKey++}`} style={listStyle}>
          {items.map((item, ii) => (
            <li key={ii} style={styles.richListItem}>{inlineRich(item)}</li>
          ))}
        </ol>
      ) : (
        <ul key={`ul-${bi}-${listKey++}`} style={listStyle}>
          {items.map((item, ii) => (
            <li key={ii} style={styles.richListItem}>{inlineRich(item)}</li>
          ))}
        </ul>
      ),
    );
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].replace(/\s+$/, "");

    // 表格：| a | b |  +  分隔行
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      flushParagraph();
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
          <table style={{ ...styles.table, ...(compact ? styles.compactTable : null) }}>
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

    // 水平分隔线：--- / *** / ___（必须在列表之前判断，否则会被当成列表项）
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      flushParagraph();
      flushList();
      nodes.push(<hr key={`hr-${bi}-${nodes.length}`} style={{ ...styles.rule, ...(compact ? styles.compactRule : null) }} />);
      i += 1;
      continue;
    }

    // 无序列表
    const bullet = /^\s*[-*+•]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      if (list.length > 0 && listOrdered) flushList();
      listOrdered = false;
      list.push(bullet[1]);
      i += 1;
      continue;
    }

    // 有序列表
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      flushParagraph();
      if (list.length > 0 && !listOrdered) flushList();
      listOrdered = true;
      list.push(ordered[1]);
      i += 1;
      continue;
    }

    flushList();
    if (!line.trim()) {
      flushParagraph();
      i += 1;
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      nodes.push(
        <div
          key={`h-${bi}-${nodes.length}`}
          style={{
            ...styles.richHeading,
            ...(compact ? styles.compactHeading : null),
            fontSize: heading[1].length <= 2 ? (compact ? 13.5 : 16) : compact ? 12.5 : 14,
            marginTop: compact ? 7 : 10,
          }}
        >
          {inlineRich(heading[2])}
        </div>,
      );
      i += 1;
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      nodes.push(<div key={`q-${bi}-${nodes.length}`} style={{ ...styles.richQuote, ...(compact ? styles.compactQuote : null) }}>{inlineRich(quote[1])}</div>);
      i += 1;
      continue;
    }

    // 普通文本：进入段落缓冲，连续行合并为一段（软换行）
    paragraph.push(line);
    i += 1;
  }
  flushParagraph();
  flushList();
  return nodes;
}

/** 富文本入口：代码块与行级内容分段渲染。 */
export function renderRich(text: string, options: { compact?: boolean } = {}): React.ReactNode {
  if (!text) return null;
  const blocks = text.split(/(```[\s\S]*?```)/g);
  return blocks.map((block, bi) => {
    if (block.startsWith("```")) {
      const head = /^```([^\n]*)/.exec(block)?.[1]?.trim() ?? "";
      const body = block.replace(/^```[^\n]*\n?/, "").replace(/```$/, "");
      return <CodeBlock key={`code-${bi}`} code={body} lang={head} compact={options.compact} />;
    }
    return <React.Fragment key={`text-${bi}`}>{renderPlainLines(block, bi, options.compact)}</React.Fragment>;
  });
}

const styles: Record<string, React.CSSProperties> = {
  codeBlockCompact: { fontSize: 11, lineHeight: 1.55, padding: "6px 8px" },
  compactHeading: { color: BRAND.linenMuted, fontWeight: 500 },
  compactQuote: { fontSize: 12, borderLeftColor: BRAND.border },
  compactPara: { fontSize: 12.5, lineHeight: 1.75, margin: "0.45em 0" },
  compactList: { margin: "0.45em 0", paddingLeft: 18, fontSize: 12.5 },
  compactTable: { fontSize: 11 },
  rule: { border: "none", borderTop: "1px solid rgba(255,255,255,0.14)", margin: "10px 0" },
  compactRule: { margin: "7px 0" },
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
  richPara: { margin: "3px 0" },
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
