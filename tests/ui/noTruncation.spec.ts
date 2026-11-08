/**
 * UI 侧「截断根除」守卫（用户 m02515：从方方面面彻底根除截断，不只是长回复）。
 *
 * 覆盖四类回归：
 *   1. 消息正文权威来源：必须是 ChatMessage.text（timeline 的 body 分片只用于思考历程展示）；
 *   2. CSS 不得裁剪正文：.msg-body-text / .body-step-text 不允许 line-clamp/max-height/ellipsis，
 *      代码块/表格允许自身滚动（overflowX:auto）但不能无提示裁掉；
 *   3. 复制/导出必须完整：消息复制、整段会话导出、代码块复制不得用 preview/截断字段；
 *   4. 渲染级验证：用 react-dom/server 真实渲染 Markdown，断言长段落/长代码/表格内容逐字存在。
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderRich } from "../../packages/ui/src/Markdown.tsx";
import { conversationToMarkdown } from "../../packages/ui/src/AgentSidebar.tsx";
import { stripDiffMarkers } from "../../packages/ui/src/artifacts.ts";
import { splitAttachments } from "../../packages/ui/src/attachments.ts";
import type { ChatMessage } from "../../packages/ui/src/chatStreamState.ts";

const ROOT = process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** 取出 CSS 类定义块（第一个 `{...}`）。 */
function cssBlock(css: string, selector: string): string {
  const index = css.indexOf(`${selector} {`);
  expect(index, `index.html 缺少 ${selector}`).toBeGreaterThan(-1);
  const end = css.indexOf("}", index);
  return css.slice(index, end + 1);
}

const LONG_PARAGRAPH = "这是一段很长的中文正文，用来验证渲染层不会把段落截断。".repeat(40);
const LONG_WORD = `https://example.com/${"a".repeat(400)}`;

describe("消息正文权威来源（ChatMessage.text）", () => {
  const chat = read("packages/ui/src/ChatMessageView.tsx");

  it("正文来自 text 的权威字段，timeline body 只走时间线展示", () => {
    expect(chat).toContain("const displayText = stripDiffMarkers(m.text)");
    expect(chat).toContain("renderRich(displayText)");
    // 不允许把 timeline 的 body 分片当正文来源
    expect(chat).not.toMatch(/step\.kind\s*===\s*"body"/);
    // 唯一允许的 .slice 是右侧卷轴导航的短标签（data-rail-label），正文/复制不得截断
    const textSlices = chat.match(/(m\.text|displayText)\.slice\(/g) ?? [];
    expect(textSlices.length).toBe(1);
    expect(chat).toMatch(/data-rail-label=\{tr\("chat\.railUser", \{ text: m\.text\.slice\(0, 24\) \}\)\}/);
  });

  it("有错误横幅时仍完整渲染已有正文（不能因状态吞掉内容）", () => {
    expect(chat).not.toMatch(/m\.errorText\s*\?\s*null\s*:\s*streaming/);
    expect(chat).toContain("renderRich(displayText)");
  });

  it("复制按钮复制完整文本：助手用 displayText（text 去内部标记），用户用原始 m.text", () => {
    expect(chat).toMatch(/writeText\(displayText\)/);
    expect(chat).toMatch(/writeText\(m\.text\)/);
  });
});

describe("Markdown 渲染不丢内容（react-dom/server 真实渲染）", () => {
  const text = [
    "## 标题与长正文",
    LONG_PARAGRAPH,
    "",
    `长单词：${LONG_WORD}`,
    "",
    "- 列表项甲".repeat(1),
    "- 列表项乙：".concat("内容".repeat(300)),
    "",
    "```ts",
    `const value = "${"x".repeat(800)}";`,
    "```",
    "",
    "| 列A | 列B |",
    "| --- | --- |",
    `| ${"单元格".repeat(60)} | B值 |`,
  ].join("\n");

  const html = renderToStaticMarkup(React.createElement("div", null, renderRich(text)));

  it("长段落/长单词/列表完整出现", () => {
    expect(html).toContain(LONG_PARAGRAPH);
    expect(html).toContain(LONG_WORD);
    expect(html).toContain("列表项乙");
    expect(html).toContain("内容".repeat(300));
  });

  it("代码块内容逐字完整（800 字符常量都在）", () => {
    expect(html).toContain("x".repeat(800));
  });

  it("表格单元格完整（不按列宽截断）", () => {
    expect(html).toContain("单元格".repeat(60));
    expect(html).toContain("B值");
  });

  it("代码块/表格用横向滚动容器承载，不静默裁切", () => {
    const markdown = read("packages/ui/src/Markdown.tsx");
    expect(markdown).toContain('overflowX: "auto"');
    expect((markdown.match(/overflowX: "auto"/g) ?? []).length).toBeGreaterThanOrEqual(2); // codeBlock + tableWrap
    expect(markdown).toMatch(/writeText\(code\)/); // 代码块复制完整 code，而非 preview
  });
});

describe("CSS 不裁剪消息正文", () => {
  const css = read("packages/ui/index.html");

  it("全仓不使用 line-clamp", () => {
    expect(css).not.toContain("line-clamp");
  });

  it(".msg-body-text 无 clamp/max-height/overflow-hidden/ellipsis，长词可换行", () => {
    const block = cssBlock(css, ".msg-body-text");
    expect(block).not.toMatch(/max-height/);
    expect(block).not.toMatch(/overflow:\s*hidden/);
    expect(block).not.toMatch(/text-overflow/);
    expect(block).not.toMatch(/white-space:\s*nowrap/);
    expect(block).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("时间线 body 步骤（穿插正文）不被 think-step-text 的 320px 滚动区裁半句", () => {
    const block = cssBlock(css, ".body-step-text");
    expect(block).toMatch(/max-height:\s*none/);
    expect(block).toMatch(/overflow:\s*visible/);
    // 时间线渲染确实同时挂了 think-step-text + body-step-text 两个类
    expect(read("packages/ui/src/TimelineView.tsx")).toContain('className="think-step-text body-step-text"');
  });

  it("消息滚动容器只负责滚动，不对正文做单行省略", () => {
    const messageList = read("packages/ui/src/MessageList.tsx");
    expect(messageList).toContain("overflowY: \"auto\"");
    expect(messageList).not.toMatch(/textOverflow:\s*"ellipsis"/);
  });
});

describe("复制/导出完整性（纯函数）", () => {
  it("stripDiffMarkers 只移除内部 diff 载荷，保留全部正文", () => {
    const before = `${"A".repeat(3000)}[__loops_diff__]base64payload[/__loops_diff__]${"B".repeat(3000)}`;
    const after = stripDiffMarkers(before);
    expect(after).toContain("A".repeat(3000));
    expect(after).toContain("B".repeat(3000));
    expect(after).not.toContain("base64payload");
  });

  it("splitAttachments 只剥离【附件】行，保留完整正文", () => {
    const body = `${"长正文".repeat(800)}\n【附件】D:/very/long/path/file.txt`;
    const { body: plain, docs } = splitAttachments(body);
    expect(plain).toContain("长正文".repeat(800));
    expect(docs).toEqual(["D:/very/long/path/file.txt"]);
  });

  it("整段会话导出使用 m.text 全文（不含任何 preview/截断字段）", () => {
    const tr = (key: string, params?: Record<string, string | number>): string =>
      String(params?.text ?? key);
    const userText = `用户长消息${"u".repeat(2000)}`;
    const assistantText = `${"助手长回复".repeat(500)}`;
    const messages = [
      { id: "u1", role: "user", text: userText },
      { id: "a1", role: "assistant", text: assistantText },
    ] as unknown as ChatMessage[];
    const markdown = conversationToMarkdown(messages, tr);
    expect(markdown).toContain(userText);
    expect(markdown).toContain(assistantText);
    // 导出函数内部不得对消息文本做 slice 截断
    const source = read("packages/ui/src/AgentSidebar.tsx");
    const start = source.indexOf("export function conversationToMarkdown");
    const end = source.indexOf("\n}", start);
    expect(start).toBeGreaterThan(-1);
    expect(source.slice(start, end)).not.toContain(".slice(");
  });
});

describe("时间线工具结果展示不静默截断", () => {
  const timeline = read("packages/ui/src/TimelineView.tsx");

  it("普通工具结果渲染完整文本（放在可滚动详情框里）", () => {
    expect(timeline).not.toContain("resultText.slice(0, 600)");
    expect(timeline).toContain("{resultText}");
  });

  it("终端结果若限制长度必须明示「已截断 + 总字符数」", () => {
    expect(timeline).toContain("已截断：共");
    expect(timeline).toContain("resultText.length");
  });

  it("工具详情行截断时保留 title 全量文本（悬停可看全文）", () => {
    expect(timeline).toMatch(/think-tool-detail" title=\{step\.detail\}/);
  });
});
