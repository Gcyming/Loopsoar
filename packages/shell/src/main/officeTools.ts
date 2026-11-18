/**
 * 统一办公文档读取（P1-6 增强）：OOXML（Word/Excel/PowerPoint）、OpenDocument
 * （ODT/ODS/ODP 及 flat XML）、RTF、CSV/TSV、PDF 文本层。
 *
 * 设计原则：
 *   · 按文件内容+扩展名分派，错误返回可读文案，绝不把解析异常抛给工具循环；
 *   · 所有格式只抽可见文本，不还原版面/样式/图片；旧版二进制（.doc/.xls/.ppt）明确提示另存；
 *   · 复用 officeZip 的条目上限/加密/zip bomb 防护，不新增解析依赖。
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ToolRegistry, ToolResult } from "loopsoar-core/tools/registry";
import { extractDocxText, extractXlsxText } from "./documentTools.js";
import { decodeXmlEntities, normalizeOfficeText } from "./officeXml.js";
import { MAX_OFFICE_BYTES, OfficeZipError, hasZipMagic, readZipEntry } from "./officeZip.js";
import { extractPdfText } from "./pdfTools.js";

const MAX_TEXT_CHARS = 20_000;
const MAX_SLIDES = 200;
const MAX_CSV_ROWS = 10_000;
const MAX_PPTX_CHARS = 40_000;

export type OfficeKind =
  | "docx"
  | "xlsx"
  | "pptx"
  | "odf"
  | "rtf"
  | "delimited"
  | "pdf"
  | "legacy"
  | "unknown";

const WORD_EXT = new Set([".docx", ".docm", ".dotx", ".dotm"]);
const EXCEL_EXT = new Set([".xlsx", ".xlsm", ".xltx", ".xltm"]);
const PPT_EXT = new Set([".pptx", ".pptm", ".potx", ".potm", ".ppsx", ".ppsm"]);
const ODF_EXT = new Set([".odt", ".ods", ".odp", ".odg", ".fodt", ".fods", ".fodp"]);
const FLAT_ODF_EXT = new Set([".fodt", ".fods", ".fodp"]);

function attr(attrs: string, name: string): string | undefined {
  const pattern = name.includes(":") ? name.replace(":", "\\s*:\\s*") : name;
  return new RegExp(`\\b${pattern}\\s*=\\s*"([^"]*)"`, "i").exec(attrs)?.[1];
}

function decodeTextBuffer(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le");
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return Buffer.from(buffer.subarray(2)).swap16().toString("utf16le");
  }
  const start = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? 3 : 0;
  return buffer.subarray(start).toString("utf8");
}

/* ── PPTX ── */

function relationships(xml: string, baseDir: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = attr(match[1], "Id");
    const target = attr(match[1], "Target");
    if (!id || !target || /\/chart$|\/chart\//.test(attr(match[1], "Type") ?? "")) continue;
    const clean = target.replace(/^\/+/, "");
    map.set(id, path.posix.normalize(clean.startsWith("ppt/") ? clean : `${baseDir}/${clean}`));
  }
  return map;
}

function slideRefs(buffer: Buffer): string[] {
  const presentation = readZipEntry(buffer, "ppt/presentation.xml")?.toString("utf8") ?? "";
  const relsXml = readZipEntry(buffer, "ppt/_rels/presentation.xml.rels")?.toString("utf8") ?? "";
  const rels = relationships(relsXml, "ppt");
  const refs: string[] = [];
  for (const match of presentation.matchAll(/<p:sldId\b([^>]*)\/?>/g)) {
    const target = rels.get(attr(match[1], "r:id") ?? "");
    if (target && !refs.includes(target)) refs.push(target);
  }
  if (refs.length > 0) return refs;
  // 没有 presentation/rels（部分导出器）时按 slideN.xml 兜底；最多看 200 张。
  for (let index = 1; index <= MAX_SLIDES; index += 1) {
    const candidate = `ppt/slides/slide${index}.xml`;
    if (readZipEntry(buffer, candidate)) refs.push(candidate);
  }
  return refs;
}

function slideXmlToText(xml: string): string {
  return normalizeOfficeText(
    decodeXmlEntities(
      xml
        .replace(/<a:br\b[^>]*\/>/g, "\n")
        .replace(/<a:tab\b[^>]*\/>/g, "\t")
        .replace(/<\/a:p>/g, "\n")
        .replace(/<\/a:tr>/g, "\n")
        .replace(/<\/a:tc>/g, "\t")
        .replace(/<[^>]+>/g, ""),
    ),
  );
}

export function extractPptxText(buffer: Buffer, maxSlides = MAX_SLIDES): string {
  const refs = slideRefs(buffer).slice(0, Math.min(Math.max(1, maxSlides), MAX_SLIDES));
  if (refs.length === 0) throw new Error("不是有效的 PPTX：找不到幻灯片");
  const sections: string[] = [];
  for (const [index, ref] of refs.entries()) {
    const xml = readZipEntry(buffer, ref)?.toString("utf8");
    if (!xml) continue;
    const text = slideXmlToText(xml);
    sections.push(`## Slide ${index + 1}\n${text || "（无文本）"}`);
    if (sections.join("\n\n").length >= MAX_PPTX_CHARS) break;
  }
  if (sections.length === 0) throw new Error("不是有效的 PPTX：幻灯片均为空");
  return sections.join("\n\n").trim();
}

/* ── OpenDocument ── */

function odfXmlToText(xml: string): string {
  return normalizeOfficeText(
    decodeXmlEntities(
      xml
        .replace(/<text:line-break\b[^>]*\/>/g, "\n")
        .replace(/<text:tab\b[^>]*\/>/g, "\t")
        .replace(/<text:s\b[^>]*\/>/g, " ")
        .replace(/<\/text:p>/g, "\n")
        .replace(/<\/text:h>/g, "\n")
        .replace(/<\/table:table-cell>/g, "\t")
        .replace(/<\/table:table-row>/g, "\n")
        .replace(/<\/draw:page>/g, "\n")
        .replace(/<[^>]+>/g, ""),
    ),
  );
}

export function extractOdfText(buffer: Buffer, ext: string): string {
  const flat = FLAT_ODF_EXT.has(ext);
  const xml = flat ? buffer.toString("utf8") : readZipEntry(buffer, "content.xml")?.toString("utf8");
  if (!xml) throw new Error("不是有效的 OpenDocument：找不到 content.xml");
  return odfXmlToText(xml);
}

/* ── RTF ── */

const RTF_SKIP_DESTINATIONS = new Set([
  "fonttbl", "colortbl", "stylesheet", "info", "pict", "object", "objdata",
  "header", "headerl", "headerr", "headerf", "footer", "footerl", "footerr", "footerf",
  "footnote", "annotation", "field", "fldinst", "listtable", "listoverridetable",
  "rsidtbl", "generator", "xmlnstbl", "datastore", "themedata", "colorschememapping",
]);

/** 删除 RTF 的字体表/图片/域指令等目标组，保留正文。 */
function stripRtfDestinations(rtf: string): string {
  let out = "";
  let index = 0;
  while (index < rtf.length) {
    if (rtf[index] !== "{") {
      out += rtf[index];
      index += 1;
      continue;
    }
    let cursor = index + 1;
    while (cursor < rtf.length && /\s/.test(rtf[cursor])) cursor += 1;
    let destination = "";
    if (rtf[cursor] === "\\") {
      if (rtf[cursor + 1] === "*") destination = "*";
      else {
        let end = cursor + 1;
        while (end < rtf.length && /[a-zA-Z]/.test(rtf[end])) end += 1;
        destination = rtf.slice(cursor + 1, end);
      }
    }
    if (destination === "*" || RTF_SKIP_DESTINATIONS.has(destination)) {
      let depth = 0;
      while (index < rtf.length) {
        if (rtf[index] === "{") depth += 1;
        else if (rtf[index] === "}") {
          depth -= 1;
          if (depth === 0) {
            index += 1;
            break;
          }
        }
        index += 1;
      }
    } else {
      out += rtf[index];
      index += 1;
    }
  }
  return out;
}

function decodeRtfBytes(bytes: number[], codepage: number): string {
  const label = codepage === 936 ? "gbk" : codepage === 65001 ? "utf-8" : "windows-1252";
  try {
    return new TextDecoder(label).decode(Buffer.from(bytes));
  } catch {
    return Buffer.from(bytes).toString("latin1");
  }
}

export function extractRtfText(buffer: Buffer): string {
  const rtf = buffer.toString("latin1");
  const codepage = Number(/\\ansicpg(\d+)/.exec(rtf)?.[1] ?? 1252);
  let text = stripRtfDestinations(rtf);
  // 先保护转义的大括号/反斜杠，避免后续控制字清洗误删。
  text = text.replace(/\\\\/g, "\u0000BS\u0000").replace(/\\\{/g, "\u0000LB\u0000").replace(/\\\}/g, "\u0000RB\u0000");
  text = text.replace(/(?:\\'[0-9a-fA-F]{2})+/g, (run) => {
    const bytes = [...run.matchAll(/\\'([0-9a-fA-F]{2})/g)].map((match) => Number.parseInt(match[1], 16));
    return decodeRtfBytes(bytes, codepage);
  });
  text = text.replace(/\\u(-?\d+)\s*\??/g, (_, raw: string) => {
    let code = Number(raw);
    if (code < 0) code += 65_536;
    try {
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "\uFFFD";
    } catch {
      return "\uFFFD";
    }
  });
  text = text
    .replace(/\\par[d]?\b\s?/g, "\n")
    .replace(/\\line\b\s?/g, "\n")
    .replace(/\\tab\b\s?/g, "\t")
    .replace(/\\cell\b\s?/g, "\t")
    .replace(/\\row\b\s?/g, "\n")
    .replace(/\\emdash\b\s?/g, "—")
    .replace(/\\endash\b\s?/g, "–")
    .replace(/\\bullet\b\s?/g, "•")
    .replace(/\\[a-zA-Z]+-?\d*\s?/g, "")
    .replace(/[{}]/g, "")
    .replace(/\u0000BS\u0000/g, "\\")
    .replace(/\u0000LB\u0000/g, "{")
    .replace(/\u0000RB\u0000/g, "}");
  return normalizeOfficeText(text);
}

/* ── CSV / TSV ── */

function detectDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).slice(0, 5).join("\n");
  const candidates = [",", ";", "\t", "|"];
  let best = ",";
  let bestCount = -1;
  for (const candidate of candidates) {
    let count = 0;
    let quoted = false;
    for (let index = 0; index < sample.length; index += 1) {
      if (sample[index] === '"') quoted = !quoted;
      else if (!quoted && sample[index] === candidate) count += 1;
    }
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

export function parseDelimitedText(text: string, delimiter?: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const delim = delimiter ?? detectDelimiter(text);
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"' && cell.length === 0) {
      quoted = true;
    } else if (char === delim) {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value.length > 0)) rows.push(row);
  return rows;
}

export function extractDelimitedText(buffer: Buffer, ext: string): string {
  const text = decodeTextBuffer(buffer);
  const rows = parseDelimitedText(text, ext === ".tsv" ? "\t" : undefined)
    .slice(0, MAX_CSV_ROWS)
    .map((row) => row.map((cell) => cell.replace(/[\t\r\n]+/g, " ")).join("\t"));
  return rows.join("\n").trim();
}

/* ── 分派 ── */

export function detectOfficeKind(buffer: Buffer, file: string): OfficeKind {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".pdf" || buffer.subarray(0, 4).toString("latin1") === "%PDF") return "pdf";
  if (ext === ".csv" || ext === ".tsv") return "delimited";
  if (ext === ".rtf" || buffer.subarray(0, 5).toString("latin1").toLowerCase() === "{\\rtf") return "rtf";
  if (ext === ".fodt" || ext === ".fods" || ext === ".fodp") return "odf";
  if (ext === ".doc" || ext === ".xls" || ext === ".ppt") {
    if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0xd0cf11e0) return "legacy";
  }
  if (!hasZipMagic(buffer)) return "unknown";
  if (readZipEntry(buffer, "word/document.xml")) return "docx";
  if (readZipEntry(buffer, "xl/workbook.xml") || readZipEntry(buffer, "xl/worksheets/sheet1.xml")) return "xlsx";
  if (readZipEntry(buffer, "ppt/presentation.xml") || readZipEntry(buffer, "ppt/slides/slide1.xml")) return "pptx";
  if (readZipEntry(buffer, "content.xml")) return "odf";
  return "unknown";
}

export interface OfficeReadOptions {
  maxChars?: number;
  sheet?: string | number;
  allSheets?: boolean;
  maxSheets?: number;
  maxPages?: number;
  maxSlides?: number;
}

export interface OfficeReadResult {
  kind: OfficeKind;
  text: string;
}

export async function extractOfficeText(file: string, options: OfficeReadOptions = {}): Promise<OfficeReadResult> {
  const buffer = fs.readFileSync(file);
  const kind = detectOfficeKind(buffer, file);
  switch (kind) {
    case "docx":
      return { kind, text: extractDocxText(buffer) };
    case "xlsx":
      return {
        kind,
        text: extractXlsxText(buffer, {
          sheet: options.sheet,
          allSheets: options.allSheets,
          maxSheets: options.maxSheets,
          maxChars: options.maxChars,
        }),
      };
    case "pptx":
      return { kind, text: extractPptxText(buffer, options.maxSlides) };
    case "odf":
      return { kind, text: extractOdfText(buffer, path.extname(file).toLowerCase()) };
    case "rtf":
      return { kind, text: extractRtfText(buffer) };
    case "delimited":
      return { kind, text: extractDelimitedText(buffer, path.extname(file).toLowerCase()) };
    case "pdf": {
      const result = await extractPdfText(buffer, options.maxPages);
      const note = result.parsedPages < result.pages ? `\n（已解析前 ${result.parsedPages}/${result.pages} 页）` : "";
      return { kind, text: result.text ? `${result.text}${note}` : `[空文本] PDF 共 ${result.pages} 页，未找到文本层（可能是扫描件，需要 OCR）${note}` };
    }
    case "legacy":
      throw new Error("检测到旧版二进制 Office（.doc/.xls/.ppt）；请用 Office/LibreOffice 另存为 .docx/.xlsx/.pptx 或 PDF 后再读取");
    default:
      throw new Error("无法识别的办公文档格式（支持 DOCX/XLSX/PPTX/ODT/ODS/ODP/RTF/CSV/TSV/PDF）");
  }
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n…（已截断，全文 ${text.length} 字符）` : text;
}

export function registerOfficeTools(registry: ToolRegistry): void {
  registry.register({
    name: "office_read",
    description:
      "统一读取办公文档的纯文本：DOCX/DOCM、XLSX/XLSM、PPTX/PPTM、ODT/ODS/ODP、RTF、CSV/TSV、PDF 文本层。按内容自动识别；不还原版面/样式/图片，扫描 PDF 需 OCR；旧版 .doc/.xls/.ppt 需先另存。",
    permissions: { read: true },
    schema: z.object({
      path: z.string().min(1).max(1000),
      maxChars: z.number().int().min(500).max(MAX_TEXT_CHARS).optional(),
      sheet: z.union([z.string().max(200), z.number().int().min(1).max(500)]).optional(),
      allSheets: z.boolean().optional(),
      maxSheets: z.number().int().min(1).max(50).optional(),
      maxPages: z.number().int().min(1).max(500).optional(),
      maxSlides: z.number().int().min(1).max(200).optional(),
    }),
    execute: async (ctx): Promise<ToolResult> => {
      const params = ctx.params as {
        path: string;
        maxChars?: number;
        sheet?: string | number;
        allSheets?: boolean;
        maxSheets?: number;
        maxPages?: number;
        maxSlides?: number;
      };
      try {
        const file = path.resolve(params.path);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(file);
        } catch {
          return { ok: false, content: `[错误] 文件不存在：${file}` };
        }
        if (!stat.isFile()) return { ok: false, content: `[错误] 不是文件：${file}` };
        if (stat.size > MAX_OFFICE_BYTES) {
          return { ok: false, content: `[错误] 文件过大（${stat.size} 字节，上限 ${MAX_OFFICE_BYTES}）` };
        }
        const result = await extractOfficeText(file, params);
        const limit = params.maxChars ?? MAX_TEXT_CHARS;
        const text = clip(result.text, limit);
        return { ok: true, content: text || "[空文档] 未找到可见文本" };
      } catch (err) {
        if (err instanceof OfficeZipError) {
          return { ok: false, content: `[错误] ${err.message}（${err.code}）` };
        }
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });
}
