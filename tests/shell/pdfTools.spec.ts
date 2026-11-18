import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { extractPdfText, registerPdfTools } from "../../packages/shell/src/main/pdfTools.ts";

/** 构造一个最小、合法的单页 PDF（Helvetica + 文本层）。 */
function makePdf(lines: string[]): Buffer {
  const escape = (value: string) => value.replace(/[\\()]/g, (ch) => `\\${ch}`);
  const content = `BT /F1 18 Tf 72 720 Td ${lines
    .map((line, index) => `${index === 0 ? "" : "0 -24 Td "}(${escape(line)}) Tj`)
    .join(" ")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
  ];
  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  const offsets: number[] = [];
  let size = chunks[0].length;
  objects.forEach((body, index) => {
    offsets.push(size);
    const chunk = Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`, "latin1");
    chunks.push(chunk);
    size += chunk.length;
  });
  const xref = size;
  let trailer = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) trailer += `${String(offset).padStart(10, "0")} 00000 n \n`;
  trailer += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  chunks.push(Buffer.from(trailer, "latin1"));
  return Buffer.concat(chunks);
}

describe("PDF 文本读取（P1-6）", () => {
  it("抽取文本层并保留换行", async () => {
    const result = await extractPdfText(makePdf(["Hello PDF", "Second line"]));
    expect(result.pages).toBe(1);
    expect(result.parsedPages).toBe(1);
    expect(result.text).toContain("Hello PDF");
    expect(result.text).toContain("Second line");
  });

  it("pdf_read 真实落盘读取；损坏文件返回可读错误", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-pdf-"));
    try {
      const file = path.join(root, "doc.pdf");
      fs.writeFileSync(file, makePdf(["Loopsoar PDF"]));
      const registry = new ToolRegistry();
      registerPdfTools(registry);
      const result = await registry.get("pdf_read")!.execute({
        agentId: "test",
        sessionId: "s1",
        params: { path: file },
        platform: {},
      });
      expect(result.ok).toBe(true);
      expect(result.content).toContain("Loopsoar PDF");

      const broken = path.join(root, "broken.pdf");
      fs.writeFileSync(broken, "%PDF-1.4\nnot a real pdf");
      const failed = await registry.get("pdf_read")!.execute({
        agentId: "test",
        sessionId: "s1",
        params: { path: broken },
        platform: {},
      });
      expect(failed.ok).toBe(false);
      expect(failed.content).toContain("PDF 解析失败");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
