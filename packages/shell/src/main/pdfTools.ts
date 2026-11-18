/**
 * PDF 文本读取（P1-6）：pdfjs-dist 的 Node/legacy 构建，懒加载，不进启动路径。
 *
 * 边界：
 *   · 只抽文本层，不渲染版面、不做 OCR；扫描件会返回空文本提示；
 *   · 30MB / 200 页 / 20k 字符上限，防止大 PDF 把主进程内存和上下文打满；
 *   · 解析失败返回可读错误，不向调用方抛异常。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { z } from "zod";
import type { ToolRegistry, ToolResult } from "loopsoar-core/tools/registry";

const MAX_PDF_BYTES = 30 * 1024 * 1024;
const MAX_PAGES = 200;
const MAX_TEXT_CHARS = 20_000;
const requireFromHere = createRequire(import.meta.url);

/** pdfjs 的 standard_fonts 资源目录；打包/测试路径不同，解析失败时退回 undefined（只影响字体警告）。 */
function pdfResourceDir(name: string): string | undefined {
  try {
    const pkg = requireFromHere.resolve("pdfjs-dist/package.json");
    return `${path.join(path.dirname(pkg), name).replace(/\\/g, "/")}/`;
  } catch {
    return undefined;
  }
}

export interface PdfTextResult {
  text: string;
  pages: number;
  parsedPages: number;
  truncated: boolean;
}

interface PdfTextItem {
  str: string;
  transform?: number[];
  width?: number;
}

/** 按 y 聚合文本项、按 x 排序；用字宽估算词间距，避免把同一行拆成 "HelloWorld"。 */
function pageLines(items: ReadonlyArray<unknown>): string[] {
  const lines: Array<{ y: number; parts: Array<{ x: number; width: number; text: string }> }> = [];
  for (const raw of items) {
    const item = raw as PdfTextItem;
    if (typeof item.str !== "string" || !item.str) continue;
    const x = Array.isArray(item.transform) ? Number(item.transform[4]) : 0;
    const y = Array.isArray(item.transform) ? Number(item.transform[5]) : 0;
    const width = Number(item.width ?? 0);
    let line = lines.find((candidate) => Math.abs(candidate.y - y) <= 2);
    if (!line) {
      line = { y, parts: [] };
      lines.push(line);
    }
    line.parts.push({ x, width, text: item.str });
  }
  lines.sort((a, b) => b.y - a.y);
  return lines
    .map((line) => {
      line.parts.sort((a, b) => a.x - b.x);
      let text = "";
      let previousEnd = Number.NaN;
      for (const part of line.parts) {
        if (text && Number.isFinite(previousEnd) && part.x - previousEnd > 1.5 && !text.endsWith(" ")) text += " ";
        text += part.text;
        previousEnd = part.x + part.width;
      }
      return text.trim();
    })
    .filter(Boolean);
}

/**
 * PDF.js 的文本项：不同页面可能把同一行拆成多个 item；用 transform[5] 的 y 坐标
 * 判断换行，比只依赖 hasEOL 更稳（很多生成器不写 hasEOL）。
 */
export async function extractPdfText(buffer: Buffer, maxPages = MAX_PAGES): Promise<PdfTextResult> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: false,
    disableFontFace: true,
    useWorkerFetch: false,
    standardFontDataUrl: pdfResourceDir("standard_fonts"),
  });
  const doc = await loadingTask.promise;
  try {
    const pageLimit = Math.min(doc.numPages, Math.max(1, maxPages));
    const chunks: string[] = [];
    let parsedPages = 0;
    let totalChars = 0;
    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = pageLines(content.items).join("\n");
      if (pageText) {
        chunks.push(pageText);
        totalChars += pageText.length + 2;
      }
      page.cleanup();
      parsedPages = pageNumber;
      // 大 PDF 逐页解析也会占用主进程事件循环；每页让出一次，避免窗口假死。
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (totalChars >= MAX_TEXT_CHARS) break;
    }
    const joined = chunks.join("\n\n").trim();
    const charsTruncated = joined.length > MAX_TEXT_CHARS;
    return {
      text: charsTruncated ? `${joined.slice(0, MAX_TEXT_CHARS)}\n…（已截断，全文 ${joined.length} 字符）` : joined,
      pages: doc.numPages,
      parsedPages,
      truncated: charsTruncated || parsedPages < doc.numPages,
    };
  } finally {
    await loadingTask.destroy();
  }
}

export function registerPdfTools(registry: ToolRegistry): void {
  registry.register({
    name: "pdf_read",
    description:
      "读取 PDF 的文本层（pdfjs，懒加载）：按页保留换行，适合读文档/论文；只抽文本，不渲染版面、不做 OCR，扫描件会提示无文本。默认最多 200 页、20k 字符。",
    permissions: { read: true },
    schema: z.object({
      path: z.string().min(1).max(1000),
      maxPages: z.number().int().min(1).max(500).optional(),
      maxChars: z.number().int().min(500).max(MAX_TEXT_CHARS).optional(),
    }),
    execute: async (ctx): Promise<ToolResult> => {
      const params = ctx.params as { path: string; maxPages?: number; maxChars?: number };
      try {
        const file = path.resolve(params.path);
        if (path.extname(file).toLowerCase() !== ".pdf") return { ok: false, content: "[错误] 只支持 .pdf" };
        let stat: fs.Stats;
        try {
          stat = fs.statSync(file);
        } catch {
          return { ok: false, content: `[错误] 文件不存在：${file}` };
        }
        if (!stat.isFile()) return { ok: false, content: `[错误] 不是文件：${file}` };
        if (stat.size > MAX_PDF_BYTES) {
          return { ok: false, content: `[错误] PDF 过大（${stat.size} 字节，上限 ${MAX_PDF_BYTES}）` };
        }
        const result = await extractPdfText(fs.readFileSync(file), params.maxPages);
        const limit = params.maxChars ?? MAX_TEXT_CHARS;
        let text = result.text;
        if (text.length > limit) text = `${text.slice(0, limit)}\n…（已截断，全文 ${text.length} 字符）`;
        const note =
          result.parsedPages < result.pages ? `\n（已解析前 ${result.parsedPages}/${result.pages} 页）` : "";
        return {
          ok: true,
          content: text ? `${text}${note}` : `[空文本] PDF 共 ${result.pages} 页，未找到文本层（可能是扫描件，需要 OCR）${note}`,
        };
      } catch (err) {
        return { ok: false, content: `[错误] PDF 解析失败：${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });
}
