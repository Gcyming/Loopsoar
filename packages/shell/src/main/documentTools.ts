/**
 * 文档读取工具（P1-6）：DOCX/XLSX 原生文本抽取。
 *
 * 为什么不用第三方库：DOCX/XLSX 只是 ZIP + XML，自己解包可以避免把 mammoth/xlsx
 * 这类大依赖塞进 Electron 主包；解析失败时返回可读错误，不抛异常。
 * 限制：只取可见文本，不保留样式/图片/批注；XLSX 默认首个工作表，可显式读全部。
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ToolRegistry, ToolResult } from "loopsoar-core/tools/registry";
import { MAX_OFFICE_BYTES, readZipEntry } from "./officeZip.js";
import { decodeXmlEntities, normalizeOfficeText } from "./officeXml.js";

const MAX_DOCX_BYTES = MAX_OFFICE_BYTES;
const MAX_TEXT_CHARS = 20_000;

/** DOCX 的 document.xml → 可读纯文本。段落/换行/制表符保留，其余标签剥掉。 */
export function docxXmlToText(xml: string): string {
  return normalizeOfficeText(
    decodeXmlEntities(
      xml
        .replace(/<w:tab\b[^>]*\/>/g, "\t")
        .replace(/<w:br\b[^>]*\/>/g, "\n")
        .replace(/<\/w:p>/g, "\n")
        .replace(/<\/w:tr>/g, "\n")
        .replace(/<\/w:tc>/g, "\t")
        .replace(/<[^>]+>/g, ""),
    ),
  );
}

export function extractDocxText(buffer: Buffer): string {
  const document = readZipEntry(buffer, "word/document.xml");
  if (!document) throw new Error("不是有效的 DOCX：找不到 word/document.xml");
  return docxXmlToText(document.toString("utf8"));
}

function cellText(inner: string, attrs: string, shared: string[]): string {
  const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? "";
  if (type === "inlineStr") {
    const texts = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]);
    return decodeXmlEntities(texts.join(""));
  }
  const value = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "";
  if (!value) return "";
  if (type === "s") return shared[Number(value)] ?? "";
  if (type === "b") return value === "1" ? "TRUE" : "FALSE";
  return decodeXmlEntities(value);
}

function cellColumn(attrs: string): number {
  const ref = /\br="([A-Z]+)\d+"/i.exec(attrs)?.[1] ?? "";
  let index = 0;
  for (const char of ref.toUpperCase()) index = index * 26 + (char.charCodeAt(0) - 64);
  // Excel 列上限 16,384；越界/畸形引用直接丢弃，避免恶意 r="ZZZZ..." 撑爆行数组。
  return index >= 1 && index <= 16_384 ? index - 1 : -1;
}

export interface XlsxReadOptions {
  /** 工作表名（大小写不敏感）或 1 起始的序号。 */
  sheet?: string | number;
  /** 读取全部工作表；默认只读第一张。 */
  allSheets?: boolean;
  maxSheets?: number;
  maxChars?: number;
}

interface SheetRef {
  name: string;
  path: string;
}

function xmlAttr(attrs: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name.replace(":", "\\s*:\\s*")}\\s*=\\s*"([^"]*)"`, "i").exec(attrs);
  return match?.[1];
}

/** 从 workbook.xml + rels 解析工作表名和实际路径；缺失时退回 sheet1.xml。 */
function workbookSheets(buffer: Buffer): SheetRef[] {
  const workbook = readZipEntry(buffer, "xl/workbook.xml")?.toString("utf8") ?? "";
  const relsXml = readZipEntry(buffer, "xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
  const relationships = new Map<string, string>();
  for (const match of relsXml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = xmlAttr(match[1], "Id");
    const target = xmlAttr(match[1], "Target");
    if (id && target) relationships.set(id, target);
  }
  const sheets: SheetRef[] = [];
  for (const match of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const attrs = match[1];
    const name = decodeXmlEntities(xmlAttr(attrs, "name") ?? "").trim();
    const rid = xmlAttr(attrs, "r:id") ?? xmlAttr(attrs, "id") ?? "";
    const target = relationships.get(rid);
    if (!target) continue;
    let clean = target.replace(/^\/+/, "");
    if (!clean.startsWith("xl/")) clean = `xl/${clean.replace(/^\.\//, "")}`;
    sheets.push({
      name: name || `Sheet${sheets.length + 1}`,
      path: path.posix.normalize(clean),
    });
  }
  if (sheets.length > 0) return sheets;
  if (readZipEntry(buffer, "xl/worksheets/sheet1.xml")) {
    return [{ name: "Sheet1", path: "xl/worksheets/sheet1.xml" }];
  }
  throw new Error("不是有效的 XLSX：找不到工作表（xl/workbook.xml 或 sheet1.xml）");
}

/** 单张工作表 XML → 制表符分列、换行分行的纯文本。 */
function worksheetXmlToText(sheet: string, shared: string[]): string {
  const rows = [...sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((row) => {
    const cells = [...row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)]
      .map((cell, index) => {
        const column = cellColumn(cell[1]);
        return {
          // 缺 r 的合法单元格按出现顺序落列；显式引用越界则丢弃。
          column: column >= 0 ? column : cell[1].includes("r=") ? -1 : index,
          text: cellText(cell[2], cell[1], shared),
        };
      })
      .filter((cell) => cell.column >= 0);
    const width = cells.reduce((max, cell) => Math.max(max, cell.column + 1), 0);
    const line = Array.from({ length: width }, () => "");
    for (const cell of cells) line[cell.column] = cell.text.replace(/\r?\n/g, " ");
    return line.join("\t").replace(/\t+$/g, "");
  });
  return normalizeOfficeText(rows.filter((row) => row.trim().length > 0).join("\n"));
}

/** XLSX → 纯文本表格；默认第一张工作表，支持指定工作表/全部工作表。公式取缓存值。 */
export function extractXlsxText(buffer: Buffer, options: XlsxReadOptions = {}): string {
  const sharedXml = readZipEntry(buffer, "xl/sharedStrings.xml")?.toString("utf8") ?? "";
  const shared = [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((si) => {
    const texts = [...si[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXmlEntities(m[1]));
    return texts.join("");
  });
  const all = workbookSheets(buffer);
  const maxSheets = Math.min(Math.max(1, options.maxSheets ?? 20), 50);
  let selected: SheetRef[];
  if (options.sheet !== undefined) {
    if (typeof options.sheet === "number") {
      const index = Math.trunc(options.sheet) - 1;
      const found = all[index];
      if (!found) throw new Error(`工作表不存在：第 ${options.sheet} 张；可用：${all.map((s) => s.name).join("、")}`);
      selected = [found];
    } else {
      const wanted = options.sheet.toLowerCase();
      const found = all.find((sheet) => sheet.name.toLowerCase() === wanted) ?? all[Math.trunc(Number(options.sheet)) - 1];
      if (!found) throw new Error(`工作表不存在：${options.sheet}；可用：${all.map((s) => s.name).join("、")}`);
      selected = [found];
    }
  } else if (options.allSheets) {
    selected = all.slice(0, maxSheets);
  } else {
    selected = [all[0]];
  }

  const limit = options.maxChars ?? MAX_TEXT_CHARS;
  const sections: string[] = [];
  for (const sheet of selected) {
    const xml = readZipEntry(buffer, sheet.path)?.toString("utf8");
    if (!xml) throw new Error(`工作表文件缺失：${sheet.path}`);
    const text = worksheetXmlToText(xml, shared);
    sections.push(selected.length > 1 ? `## Sheet: ${sheet.name}\n${text || "（空工作表）"}` : text);
    if (sections.join("\n\n").length >= limit) break;
  }
  if (options.allSheets && all.length > selected.length) {
    sections.push(`…（仅读取前 ${selected.length}/${all.length} 张工作表）`);
  }
  return sections.filter(Boolean).join("\n\n").trim();
}

export function registerDocumentTools(registry: ToolRegistry): void {
  registry.register({
    name: "docx_read",
    description:
      "读取 WordprocessingML（.docx/.docm/.dotx/.dotm）的纯文本：解包 word/document.xml，保留段落/换行/制表符，去掉样式；适合读需求文档、会议纪要。更多格式用 office_read。",
    permissions: { read: true },
    schema: z.object({
      path: z.string().min(1).max(1000),
      maxChars: z.number().int().min(500).max(MAX_TEXT_CHARS).optional(),
    }),
    execute: async (ctx): Promise<ToolResult> => {
      const params = ctx.params as { path: string; maxChars?: number };
      try {
        const file = path.resolve(params.path);
        if (![".docx", ".docm", ".dotx", ".dotm"].includes(path.extname(file).toLowerCase())) {
          return { ok: false, content: "[错误] 只支持 .docx/.docm/.dotx/.dotm（旧版 .doc 请先另存为 .docx）" };
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

  registry.register({
    name: "xlsx_read",
    description:
      "读取 Excel（.xlsx/.xlsm/.xltx/.xltm）为纯文本：制表符分列、换行分行，共享/内联字符串都支持；默认第一张工作表，可指定 sheet 或 allSheets；公式取缓存值。",
    permissions: { read: true },
    schema: z.object({
      path: z.string().min(1).max(1000),
      maxChars: z.number().int().min(500).max(MAX_TEXT_CHARS).optional(),
      sheet: z.union([z.string().max(200), z.number().int().min(1).max(500)]).optional(),
      allSheets: z.boolean().optional(),
      maxSheets: z.number().int().min(1).max(50).optional(),
    }),
    execute: async (ctx): Promise<ToolResult> => {
      const params = ctx.params as { path: string; maxChars?: number; sheet?: string | number; allSheets?: boolean; maxSheets?: number };
      try {
        const file = path.resolve(params.path);
        if (![".xlsx", ".xlsm", ".xltx", ".xltm"].includes(path.extname(file).toLowerCase())) {
          return { ok: false, content: "[错误] 只支持 .xlsx/.xlsm/.xltx/.xltm（旧版 .xls 请先另存为 .xlsx）" };
        }
        let stat: fs.Stats;
        try {
          stat = fs.statSync(file);
        } catch {
          return { ok: false, content: `[错误] 文件不存在：${file}` };
        }
        if (!stat.isFile()) return { ok: false, content: `[错误] 不是文件：${file}` };
        if (stat.size > MAX_DOCX_BYTES) {
          return { ok: false, content: `[错误] XLSX 过大（${stat.size} 字节，上限 ${MAX_DOCX_BYTES}）` };
        }
        const text = extractXlsxText(fs.readFileSync(file), {
          sheet: params.sheet,
          allSheets: params.allSheets,
          maxSheets: params.maxSheets,
          maxChars: params.maxChars ?? MAX_TEXT_CHARS,
        });
        const limit = params.maxChars ?? MAX_TEXT_CHARS;
        const clipped = text.length > limit ? `${text.slice(0, limit)}\n…（已截断，全文 ${text.length} 字符）` : text;
        return { ok: true, content: clipped || "[空表格] 未找到可见单元格" };
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });
}
