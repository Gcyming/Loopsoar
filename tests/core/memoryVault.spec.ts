/**
 * 记忆仓库 Markdown 编解码（Obsidian 风格）：round-trip、链接、兜底与容错。
 */
import { describe, expect, it } from "vitest";
import { createFact } from "../../packages/core/src/memory/fact.ts";
import {
  factToMarkdown,
  markdownToFact,
  renderVaultIndex,
  vaultFileName,
} from "../../packages/core/src/memory/vault.ts";

const NOW = 1_760_000_000_000;

function fact(partial: Partial<Parameters<typeof createFact>[0]> = {}) {
  return createFact({
    id: "m1",
    content: "记忆原点代表 Loopsoar 本体，第一层只放会话",
    category: "convention",
    workspaceId: "default",
    importance: 9,
    timestamp: NOW,
    lastAccessed: NOW,
    links: ["m2"],
    tags: ["design"],
    provenance: { sessionId: "s1", workspaceId: "default", trust: "user", capturedBy: "auto" },
    ...partial,
  });
}

describe("记忆仓库编解码（Obsidian 风格）", () => {
  it("frontmatter 是合法 YAML，正文是内容本身", () => {
    const md = factToMarkdown(fact());
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain("schema: 1");
    expect(md).toContain("id: m1");
    expect(md).toContain("workspace: default");
    expect(md).toContain('links: ["[[m2]]"]');
    expect(md.trimEnd().endsWith("记忆原点代表 Loopsoar 本体，第一层只放会话")).toBe(true);
  });

  it("round-trip 保住内容与结构化字段", () => {
    const original = fact({ invalidatedAt: NOW - 1000, supersededBy: "m2", mergeTrail: [{ mergedAt: NOW, reason: "重复" }] });
    const parsed = markdownToFact(factToMarkdown(original), "m1.md");
    expect(parsed).not.toBeNull();
    const restored = parsed!.fact;
    expect(restored.id).toBe("m1");
    expect(restored.content).toBe(original.content);
    expect(restored.category).toBe("convention");
    expect(restored.importance).toBe(9);
    expect(restored.links).toEqual(["m2"]);
    expect(restored.workspaceId).toBe("default");
    expect(restored.provenance?.trust).toBe("user");
    expect(restored.provenance?.sessionId).toBe("s1");
    expect(restored.invalidatedAt).toBe(NOW - 1000);
    expect(restored.supersededBy).toBe("m2");
    expect(restored.mergeTrail[0]?.reason).toBe("重复");
  });

  it("链接支持 [[id|标题]] 与纯 id 两种写法", () => {
    const md = factToMarkdown(fact({ links: [] })).replace("category: convention", "category: convention\nlinks:\n  - '[[m2|旧标题]]'\n  - m3");
    const parsed = markdownToFact(md, "m1.md");
    expect(parsed?.fact.links).toEqual(["m2", "m3"]);
  });

  it("缺 id 时用文件名兜底；缺正文/非法 YAML 返回 null", () => {
    const noId = factToMarkdown(fact()).replace(/^id: .*\n/m, "");
    expect(markdownToFact(noId, "m9.md")?.fact.id).toBe("m9");
    expect(markdownToFact("正文没有 frontmatter", "x.md")).toBeNull();
    expect(markdownToFact("---\n: : bad yaml\n---\n\n内容", "x.md")).toBeNull();
    expect(markdownToFact("---\nid: x\n---\n\n   ", "x.md")).toBeNull();
  });

  it("文件名安全化：路径分隔符不会逃出目录", () => {
    expect(vaultFileName("a/b:c")).toBe("a_b_c.md");
    expect(vaultFileName("")).toBe("memory.md");
  });

  it("索引笔记按工作区汇总并用 wikilink 指向条目", () => {
    const index = renderVaultIndex([fact(), fact({ id: "m2", workspaceId: "ws-a", content: "另一条" })], [], NOW);
    expect(index).toContain("# Loopsoar 记忆索引");
    expect(index).toContain("## default");
    expect(index).toContain("## ws-a");
    expect(index).toContain("[[m1|");
  });
});
