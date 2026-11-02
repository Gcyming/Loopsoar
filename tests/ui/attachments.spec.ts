/**
 * 附件文本协议：`【附件】<path>` 解析（展示层与发送层共用同一份解析）。
 */
import { describe, expect, it } from "vitest";
import { splitAttachments, baseName } from "../../packages/ui/src/attachments.ts";

describe("附件文本协议", () => {
  it("拆分正文与附件路径", () => {
    const { body, docs } = splitAttachments("帮我看看这个\n【附件】C:\\work\\a.md\n【附件】docs/b.ts");
    expect(docs).toEqual(["C:\\work\\a.md", "docs/b.ts"]);
    expect(body).toBe("帮我看看这个");
  });

  it("无附件时正文原样保留", () => {
    const { body, docs } = splitAttachments("纯文本消息");
    expect(docs).toEqual([]);
    expect(body).toBe("纯文本消息");
  });

  it("空路径/只有标记时不产生附件", () => {
    const { docs } = splitAttachments("【附件】   \n正文");
    expect(docs).toEqual([]);
  });

  it("多个附件 + 正文换行保留", () => {
    const { body, docs } = splitAttachments("第一行\n第二行\n【附件】a.txt");
    expect(docs).toEqual(["a.txt"]);
    expect(body).toContain("第一行");
    expect(body).toContain("第二行");
  });

  it("baseName 兼容 Windows 与 POSIX 分隔符", () => {
    expect(baseName("C:\\work\\a.md")).toBe("a.md");
    expect(baseName("docs/b.ts")).toBe("b.ts");
    expect(baseName("plain.txt")).toBe("plain.txt");
  });
});
