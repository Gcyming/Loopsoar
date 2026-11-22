import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { officeDocumentTitle, officeFileFromUrl, prepareOfficePreview } from "../../packages/shell/src/main/officePreview.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-office-preview-"));
}

describe("Office/PDF 本地预览", () => {
  it("识别 file:// 拖拽地址并拒绝普通网页地址", () => {
    const url = new URL("file:///C:/Users/test/第五章%20基带信号.ppt").href;
    expect(officeFileFromUrl(url)).toBe("C:\\Users\\test\\第五章 基带信号.ppt");
    expect(officeFileFromUrl("https://example.com/a.ppt")).toBeNull();
    expect(officeFileFromUrl("file:///C:/Users/test/readme.txt")).toBeNull();
  });

  it("标签页标题使用原文件名并去掉扩展名", () => {
    expect(officeDocumentTitle("C:/docs/课程/第五章 基带数字信号的表示和传输.ppt")).toBe("第五章 基带数字信号的表示和传输");
    expect(officeDocumentTitle("C:/docs/a.docx")).toBe("a");
  });

  it("PDF 不做 LibreOffice 转换，直接缓存；同一文件第二次命中缓存", async () => {
    const dir = tempDir();
    const source = path.join(dir, "示例.pdf");
    fs.writeFileSync(source, "%PDF-1.4\n%%EOF\n");
    const cacheDir = path.join(dir, "cache");
    const first = await prepareOfficePreview(source, { cacheDir });
    expect(first.converted).toBe(false);
    expect(fs.existsSync(first.pdf)).toBe(true);
    expect(fs.readFileSync(first.pdf, "utf8")).toBe("%PDF-1.4\n%%EOF\n");
    const second = await prepareOfficePreview(source, { cacheDir });
    expect(second.converted).toBe(false);
    expect(second.pdf).toBe(first.pdf);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("拒绝不支持的扩展名", async () => {
    const dir = tempDir();
    const source = path.join(dir, "notes.txt");
    fs.writeFileSync(source, "hello");
    await expect(prepareOfficePreview(source, { cacheDir: path.join(dir, "cache") })).rejects.toThrow(/只支持 Office/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
