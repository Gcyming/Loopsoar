import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import {
  detectOfficeKind,
  extractDelimitedText,
  extractOdfText,
  extractPptxText,
  extractRtfText,
  registerOfficeTools,
} from "../../packages/shell/src/main/officeTools.ts";
import { zipFixture } from "./zipFixture.ts";

function pptxFixture(): Buffer {
  return zipFixture([
    {
      name: "ppt/presentation.xml",
      data: Buffer.from(
        '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst></p:presentation>',
      ),
    },
    {
      name: "ppt/_rels/presentation.xml.rels",
      data: Buffer.from(
        '<Relationships><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
      ),
    },
    {
      name: "ppt/slides/slide1.xml",
      data: Buffer.from('<p:sld><a:p><a:t>第一页</a:t></a:p></p:sld>'),
    },
    {
      name: "ppt/slides/slide2.xml",
      data: Buffer.from('<p:sld><a:p><a:t>Second</a:t></a:p><a:p><a:t>Line</a:t></a:p></p:sld>'),
    },
  ]);
}

describe("统一办公文档读取（P1-6 增强）", () => {
  it("PPTX 按 presentation rels 顺序取幻灯片文本", () => {
    const text = extractPptxText(pptxFixture());
    expect(text).toContain("## Slide 1\nSecond\nLine");
    expect(text).toContain("## Slide 2\n第一页");
    expect(text.indexOf("Second")).toBeLessThan(text.indexOf("第一页"));
  });

  it("ODT/ODS 的 content.xml 转文本", () => {
    const odt = zipFixture([
      {
        name: "content.xml",
        data: Buffer.from(
          '<office:document-content><office:body><office:text><text:h>标题</text:h><text:p>正文 &amp; 更多</text:p></office:text></office:body></office:document-content>',
        ),
      },
    ]);
    expect(extractOdfText(odt, ".odt")).toBe("标题\n正文 & 更多");
  });

  it("RTF 保留段落/制表符并解码 GBK 与 Unicode", () => {
    const rtf = Buffer.from(
      "{\\rtf1\\ansi\\ansicpg936{\\fonttbl{\\f0 Arial;}}\\f0 Hello\\par \\'c4\\'e3\\'ba\\'c3\\tab End\\u20013?}",
      "latin1",
    );
    const text = extractRtfText(rtf);
    expect(text).toContain("Hello");
    expect(text).toContain("你好\tEnd");
    expect(text).toContain("中");
  });

  it("CSV 处理 BOM、引号、逗号与转义引号", () => {
    const csv = Buffer.from('\uFEFF姓名,备注\r\n"张,三","他说""好"""\r\n', "utf8");
    expect(extractDelimitedText(csv, ".csv")).toBe('姓名\t备注\n张,三\t他说"好"');
  });

  it("按内容识别格式；office_read 返回可读错误而非抛异常", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-office-"));
    try {
      const csvFile = path.join(root, "表.csv");
      fs.writeFileSync(csvFile, "a,b\n1,2\n");
      expect(detectOfficeKind(fs.readFileSync(csvFile), csvFile)).toBe("delimited");
      const registry = new ToolRegistry();
      registerOfficeTools(registry);
      const result = await registry.get("office_read")!.execute({
        agentId: "test",
        sessionId: "s1",
        params: { path: csvFile },
        platform: {},
      });
      expect(result.ok).toBe(true);
      expect(result.content).toBe("a\tb\n1\t2");

      const docFile = path.join(root, "旧版.doc");
      fs.writeFileSync(docFile, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]));
      const legacy = await registry.get("office_read")!.execute({
        agentId: "test",
        sessionId: "s1",
        params: { path: docFile },
        platform: {},
      });
      expect(legacy.ok).toBe(false);
      expect(legacy.content).toContain("旧版二进制");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
