import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { extractXlsxText, registerDocumentTools } from "../../packages/shell/src/main/documentTools.ts";

interface Entry {
  name: string;
  data: Buffer;
}

/** 构造最小 store ZIP（多条目），用于验证 XLSX 解包。 */
function zipStore(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const local = Buffer.alloc(30 + name.length + entry.data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    entry.data.copy(local, 30 + name.length);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

describe("XLSX 文本读取（P1-6）", () => {
  it("共享字符串/内联字符串/空列按引用对齐", () => {
    const shared = "<sst><si><t>姓名</t></si><si><t>年龄</t></si></sst>";
    const sheet =
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2"><v>1</v></c><c r="C2" t="inlineStr"><is><t>备注</t></is></c></row></sheetData></worksheet>';
    const buffer = zipStore([
      { name: "xl/sharedStrings.xml", data: Buffer.from(shared, "utf8") },
      { name: "xl/worksheets/sheet1.xml", data: Buffer.from(sheet, "utf8") },
    ]);
    expect(extractXlsxText(buffer)).toBe("姓名\t年龄\n1\t\t备注");
  });

  it("xlsx_read 真实落盘读取", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-xlsx-"));
    try {
      const file = path.join(root, "表.xlsx");
      fs.writeFileSync(
        file,
        zipStore([
          { name: "xl/sharedStrings.xml", data: Buffer.from("<sst><si><t>单元格</t></si></sst>", "utf8") },
          {
            name: "xl/worksheets/sheet1.xml",
            data: Buffer.from('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>', "utf8"),
          },
        ]),
      );
      const registry = new ToolRegistry();
      registerDocumentTools(registry);
      const result = await registry.get("xlsx_read")!.execute({
        agentId: "test",
        sessionId: "s1",
        params: { path: file },
        platform: {},
      });
      expect(result.ok).toBe(true);
      expect(result.content).toBe("单元格");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("按 workbook/rels 读取指定工作表或全部工作表", () => {
    const workbookXml =
      '<workbook><sheets><sheet name="第一张" sheetId="1" r:id="rId1"/><sheet name="第二张" sheetId="2" r:id="rId2"/></sheets></workbook>';
    const relsXml =
      '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="worksheet" Target="worksheets/sheet2.xml"/></Relationships>';
    const sheet1 = '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>甲</t></is></c></row></sheetData></worksheet>';
    const sheet2 = '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>乙</t></is></c></row></sheetData></worksheet>';
    const buffer = zipStore([
      { name: "xl/workbook.xml", data: Buffer.from(workbookXml, "utf8") },
      { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(relsXml, "utf8") },
      { name: "xl/worksheets/sheet1.xml", data: Buffer.from(sheet1, "utf8") },
      { name: "xl/worksheets/sheet2.xml", data: Buffer.from(sheet2, "utf8") },
    ]);
    expect(extractXlsxText(buffer)).toBe("甲");
    expect(extractXlsxText(buffer, { sheet: "第二张" })).toBe("乙");
    expect(extractXlsxText(buffer, { allSheets: true })).toContain("## Sheet: 第二张\n乙");
  });
});
