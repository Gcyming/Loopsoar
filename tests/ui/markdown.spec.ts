/**
 * Markdown 渲染（纯展示逻辑）：段落软换行合并、分隔线、列表、标题、表格。
 */
import { describe, expect, it } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderRich } from "../../packages/ui/src/Markdown.tsx";

function html(markdown: string, compact = false): string {
  return renderToStaticMarkup(React.createElement(React.Fragment, null, renderRich(markdown, { compact })));
}

describe("Markdown 渲染", () => {
  it("连续普通行合并为同一段（软换行不强制断行）", () => {
    const out = html("第一行文字\n第二行文字\n\n新的段落");
    // 两行在同一段内，用空格连接
    expect(out).toContain("第一行文字 第二行文字");
    expect(out).toContain("新的段落");
    // 不会出现每个源行一个段落块
    expect(out.match(/<div/g)?.length ?? 0).toBeLessThanOrEqual(3);
  });

  it("--- / *** / ___ 渲染为分隔线，而不是段落或列表", () => {
    const out = html("上文\n\n---\n\n下文\n\n***\n\n___");
    expect(out.match(/<hr/g)?.length).toBe(3);
    expect(out).not.toContain("&lt;hr");
  });

  it("无序 / 有序列表分别渲染 ul / ol，并支持 +、* 前缀", () => {
    const unordered = html("- 甲\n- 乙\n* 丙\n+ 丁");
    expect(unordered).toContain("<ul");
    expect(unordered.match(/<li/g)?.length).toBe(4);
    const ordered = html("1. 第一\n2. 第二\n3) 第三");
    expect(ordered).toContain("<ol");
    expect(ordered.match(/<li/g)?.length).toBe(3);
  });

  it("标题、引用、表格仍然正常", () => {
    const heading = html("## 小标题");
    expect(heading).toContain("小标题");
    expect(heading).toContain("font-size");
    const quote = html("> 引用一句");
    expect(quote).toContain("引用一句");
    const table = html("| 列A | 列B |\n| --- | --- |\n| 1 | 2 |");
    expect(table).toContain("<table");
    expect(table).toContain("列A");
    expect(table).toContain("列B");
  });

  it("compact 模式与普通模式输出结构一致（仅样式不同）", () => {
    const normal = html("第一行\n第二行\n\n---");
    const compact = html("第一行\n第二行\n\n---", true);
    expect(compact).toContain("<hr");
    expect(compact).toContain("第一行 第二行");
    expect(normal).toContain("第一行 第二行");
  });
});
