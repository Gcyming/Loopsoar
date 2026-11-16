/**
 * 记忆 Markdown 导出：稳定排序、单行化、失效/归档标注。
 */
import { describe, expect, it } from "vitest";
import { createFact } from "../../packages/core/src/memory/fact.ts";
import { renderMemoryMarkdown } from "../../packages/core/src/memory/markdown.ts";

const NOW = 1_760_000_000_000;
const DAY = 86_400_000;

function fact(id: string, opts: { workspaceId?: string; category?: string; archivedAt?: number; invalidatedAt?: number; importance?: number } = {}) {
  return createFact({
    id,
    content: id,
    category: opts.category ?? "fact",
    importance: opts.importance ?? 5,
    timestamp: NOW - DAY,
    lastAccessed: NOW,
    workspaceId: opts.workspaceId ?? "default",
    archivedAt: opts.archivedAt,
    invalidatedAt: opts.invalidatedAt,
    provenance: { workspaceId: opts.workspaceId ?? "default", trust: "user", capturedBy: "auto" },
  });
}

describe("记忆 Markdown 导出（只读投影）", () => {
  it("按工作区与分类分组，条目带日期与 id", () => {
    const md = renderMemoryMarkdown([fact("f1", { category: "convention" }), fact("f2", { workspaceId: "ws-a" })], { generatedAt: NOW });
    expect(md).toContain("## default");
    expect(md).toContain("## ws-a");
    expect(md).toContain("### convention (1)");
    expect(md).toMatch(/\[\d{4}-\d{2}-\d{2}\] f1 — 重要度 5 · 信任 user · id f1/);
  });

  it("正文里的换行被压成单行，保证一条记忆占一行", () => {
    const messy = createFact({ id: "m", content: "第一行\n第二行\t第三行", category: "fact", workspaceId: "default" });
    const md = renderMemoryMarkdown([messy], { generatedAt: NOW });
    expect(md).toContain("- [");
    expect(md).toContain("第一行 第二行 第三行");
    expect(md.split("\n").filter((line) => line.includes("第一行"))).toHaveLength(1);
  });

  it("失效与归档各有标记，归档单独成段", () => {
    const md = renderMemoryMarkdown(
      [
        fact("live"),
        fact("gone", { invalidatedAt: NOW - DAY }),
        fact("old", { archivedAt: NOW - 2 * DAY }),
      ],
      { generatedAt: NOW },
    );
    expect(md).toContain("已于");
    expect(md).toContain("失效");
    expect(md).toContain("归档");
    expect(md).toContain("### 归档 (1)");
    expect(md).toContain("失效 1 · 归档 1");
  });

  it("空库给出明确说明而不是空文件", () => {
    expect(renderMemoryMarkdown([], { generatedAt: NOW })).toContain("（还没有记忆）");
  });

  it("同一份数据两次导出逐字节一致（可进 git diff）", () => {
    const facts = [fact("b", { importance: 3 }), fact("a", { importance: 9 })];
    expect(renderMemoryMarkdown(facts, { generatedAt: NOW })).toBe(renderMemoryMarkdown(facts, { generatedAt: NOW }));
  });
});
