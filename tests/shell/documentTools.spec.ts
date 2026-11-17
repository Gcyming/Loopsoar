import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { docxXmlToText, extractDocxText, registerDocumentTools } from "../../packages/shell/src/main/documentTools.ts";

/** 构造只含一个 store 条目的最小 ZIP，足够验证 DOCX 解包路径。 */
function zipStore(name: string, data: Buffer): Buffer {
  const nameBuf = Buffer.from(name, "utf8");
  const local = Buffer.alloc(30 + nameBuf.length + data.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0, 12);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  nameBuf.copy(local, 30);
  data.copy(local, 30 + nameBuf.length);

  const central = Buffer.alloc(46 + nameBuf.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0, 14);
  central.writeUInt32LE(0, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42);
  nameBuf.copy(central, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, eocd]);
}

describe("DOCX 文本读取（P1-6）", () => {
  it("解包 document.xml，保留段落/换行/制表符并去标签", () => {
    const xml = "<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>World</w:t></w:r></w:p><w:p><w:r><w:t>第二段 &amp; 结束</w:t></w:r></w:p></w:body></w:document>";
    expect(docxXmlToText(xml)).toContain("Hello\tWorld");
    expect(docxXmlToText(xml)).toContain("第二段 & 结束");
    const buffer = zipStore("word/document.xml", Buffer.from(xml, "utf8"));
    expect(extractDocxText(buffer)).toContain("Hello\tWorld");
  });

  it("docx_read 真实落盘读取并返回文本", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-docx-"));
    try {
      const file = path.join(root, "需求.docx");
      const xml = "<w:document><w:body><w:p><w:r><w:t>需求正文</w:t></w:r></w:p></w:body></w:document>";
      fs.writeFileSync(file, zipStore("word/document.xml", Buffer.from(xml, "utf8")));
      const registry = new ToolRegistry();
      registerDocumentTools(registry);
      const result = await registry.get("docx_read")!.execute({
        agentId: "test",
        sessionId: "s1",
        params: { path: file },
        platform: {},
      });
      expect(result.ok).toBe(true);
      expect(result.content).toContain("需求正文");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
