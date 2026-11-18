/**
 * 旧版二进制 Office 的可选转换（P1-6 补口）：调用本机 LibreOffice headless，
 * 把 .doc/.xls/.ppt 转成 OOXML 后交给 office_read。
 *
 * 为什么单独成工具：转换会启动外部进程，不能用只读权限偷偷执行；用户/Agent
 * 必须显式调用 `office_convert`（terminal 权限），转换输出到临时目录并在读取后删除。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { ToolRegistry, ToolResult } from "loopsoar-core/tools/registry";
import { extractOfficeText } from "./officeTools.js";

const MAX_LEGACY_BYTES = 30 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

export type LegacyTarget = "docx" | "xlsx" | "pptx";

export function legacyTarget(ext: string): LegacyTarget | null {
  const normalized = ext.toLowerCase();
  if (normalized === ".doc") return "docx";
  if (normalized === ".xls") return "xlsx";
  if (normalized === ".ppt") return "pptx";
  return null;
}

const FILTERS: Record<LegacyTarget, string> = {
  docx: "Office Open XML Text",
  xlsx: "Calc MS Excel 2007 XML",
  pptx: "Impress MS PowerPoint 2007 XML",
};

/** 查找 LibreOffice；优先 LOOPSOAR_SOFFICE，再查常见安装路径。 */
export function findSoffice(): string | null {
  const candidates = [
    process.env.LOOPSOAR_SOFFICE,
    process.platform === "win32" ? "C:/Program Files/LibreOffice/program/soffice.exe" : undefined,
    process.platform === "win32" ? "C:/Program Files (x86)/LibreOffice/program/soffice.exe" : undefined,
    process.platform === "darwin" ? "/Applications/LibreOffice.app/Contents/MacOS/soffice" : undefined,
    "/usr/bin/soffice",
    "/usr/local/bin/soffice",
    "/opt/libreoffice/program/soffice",
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // 无权限/路径非法：继续找下一个。
    }
  }
  return null;
}

function runSoffice(command: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`LibreOffice 转换超时（${Math.round(timeoutMs / 1000)}s）`));
    }, timeoutMs);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8").slice(0, 4_000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`无法启动 LibreOffice：${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`LibreOffice 转换失败（退出码 ${code}）${stderr ? `：${stderr.trim()}` : ""}`));
    });
  });
}

export interface ConvertedLegacy {
  file: string;
  dir: string;
}

/** 转换旧版 Office 到临时目录；调用方负责 rmSync(dir)。 */
export async function convertLegacyOffice(
  file: string,
  options: { soffice?: string; timeoutMs?: number } = {},
): Promise<ConvertedLegacy> {
  const target = legacyTarget(path.extname(file));
  if (!target) throw new Error("只支持 .doc/.xls/.ppt 旧版 Office");
  const command = options.soffice ?? findSoffice();
  if (!command) {
    throw new Error("未找到 LibreOffice；请安装后重试，或设置 LOOPSOAR_SOFFICE 指向 soffice");
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-office-convert-"));
  const profile = path.join(dir, "profile");
  const outDir = path.join(dir, "out");
  fs.mkdirSync(outDir, { recursive: true });
  const args = [
    `-env:UserInstallation=${pathToFileURL(profile).href}`,
    "--headless",
    "--norestore",
    "--nolockcheck",
    "--nofirststartwizard",
    "--convert-to",
    `${target}:${FILTERS[target]}`,
    "--outdir",
    outDir,
    file,
  ];
  try {
    await runSoffice(command, args, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const output = path.join(outDir, `${path.basename(file, path.extname(file))}.${target}`);
    if (!fs.existsSync(output)) throw new Error(`LibreOffice 未生成 ${target} 文件`);
    return { file: output, dir };
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

export function registerOfficeConvertTools(registry: ToolRegistry): void {
  registry.register({
    name: "office_convert",
    description:
      "把旧版二进制 Office（.doc/.xls/.ppt）用本机 LibreOffice 转成 OOXML 并读取文本；需要 terminal 权限，输出只落临时目录，读完即删。机器上没有 LibreOffice 时返回可读错误。",
    permissions: { read: true, terminal: true },
    schema: z.object({
      path: z.string().min(1).max(1000),
      maxChars: z.number().int().min(500).max(20_000).optional(),
      timeoutMs: z.number().int().min(5_000).max(300_000).optional(),
    }),
    execute: async (ctx): Promise<ToolResult> => {
      const params = ctx.params as { path: string; maxChars?: number; timeoutMs?: number };
      const file = path.resolve(params.path);
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile()) return { ok: false, content: `[错误] 不是文件：${file}` };
        if (stat.size > MAX_LEGACY_BYTES) return { ok: false, content: `[错误] 文件过大（上限 ${MAX_LEGACY_BYTES} 字节）` };
        if (!legacyTarget(path.extname(file))) return { ok: false, content: "[错误] 只支持 .doc/.xls/.ppt" };
        const converted = await convertLegacyOffice(file, { timeoutMs: params.timeoutMs });
        try {
          const result = await extractOfficeText(converted.file);
          const text = result.text.length > (params.maxChars ?? 20_000)
            ? `${result.text.slice(0, params.maxChars ?? 20_000)}\n…（已截断）`
            : result.text;
          return { ok: true, content: text || "[空文档] 未找到可见文本" };
        } finally {
          fs.rmSync(converted.dir, { recursive: true, force: true });
        }
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });
}
