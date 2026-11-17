/**
 * 文档读取工具（P1-6 第一步）：DOCX 原生文本抽取。
 *
 * 为什么不用第三方库：DOCX 只是 ZIP + XML，自己解包可以避免把 pdfjs/mammoth
 * 这类大依赖塞进 Electron 主包；解析失败时返回可读错误，不抛异常。
 * 限制：只取 word/document.xml 的可见文本，不保留样式/表格布局；图片与批注不读。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { z } from "zod";
import type { ToolRegistry, ToolResult } from "loopsoar-core/tools/registry";

const MAX_DOCX_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_CHARS = 20_000;

/** 在 ZIP 中定位指定条目并解压（只支持 store/deflate，DOCX 足够）。 */
function readZipEntry(zip: Buffer, wanted: string): Buffer | null {
  // EOCD 可能带最长 64KB 注释；从尾部向前找签名。
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const entries = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== 0x02014b50) return null;
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (name === wanted) {
      if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== 0x04034b50) return null;
      const localName = zip.readUInt16LE(localOffset + 26);
      const localExtra = zip.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localName + localExtra;
      const data = zip.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return zlib.inflateRawSync(data);
      return null;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** DOCX 的 document.xml → 可读纯文本。段落/换行/制表符保留，其余标签剥掉。 */
export function docxXmlToText(xml: string): string {
  return decodeXmlEntities(
    xml
      .replace(/<w:tab\b[^>]*\/>/g, "\t")
      .replace(/<w:br\b[^>]*\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<\/w:tr>/g, "\n")
      .replace(/<\/w:tc>/g, "\t")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractDocxText(buffer: Buffer): string {
  const document = readZipEntry(buffer, "word/document.xml");
  if (!document) throw new Error("不是有效的 DOCX：找不到 word/document.xml");
  return docxXmlToText(document.toString("utf8"));
}

export function registerDocumentTools(registry: ToolRegistry): void {
  registry.register({
    name: "docx_read",
    description:
      "读取 DOCX（Word）文档的纯文本：解包 word/document.xml，保留段落/换行/制表符，去掉样式；适合读需求文档、会议纪要。PDF 请继续用 pdf 工具/外部转换。",
    permissions: { read: true },
    schema: z.object({
      path: z.string().min(1).max(1000),
      maxChars: z.number().int().min(500).max(MAX_TEXT_CHARS).optional(),
    }),
    execute: async (ctx): Promise<ToolResult> => {
      const params = ctx.params as { path: string; maxChars?: number };
      try {
        const file = path.resolve(params.path);
        if (path.extname(file).toLowerCase() !== ".docx") {
          return { ok: false, content: "[错误] 只支持 .docx（旧版 .doc 请先另存为 .docx）" };
        }
        let stat: fs.Stats;
        try {
          stat = fs.statSync(file);
        } catch {
          return { ok: false, content: `[错误] 文件不存在：${file}` };
        }
        if (!stat.isFile()) return { ok: false, content: `[错误] 不是文件：${file}` };
        if (stat.size > MAX_DOCX_BYTES) {
          return { ok: false, content: `[错误] DOCX 过大（${stat.size} 字节，上限 ${MAX_DOCX_BYTES}）` };
        }
        const text = extractDocxText(fs.readFileSync(file));
        const limit = params.maxChars ?? MAX_TEXT_CHARS;
        const clipped = text.length > limit ? `${text.slice(0, limit)}\n…（已截断，全文 ${text.length} 字符）` : text;
        return { ok: true, content: clipped || "[空文档] 未找到可见文本" };
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });
}
