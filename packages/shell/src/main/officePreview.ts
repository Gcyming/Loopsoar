/**
 * 本地 Office/PDF 预览准备：把用户拖入的 Office 文档用本机 LibreOffice 转成 PDF，
 * 再由 BrowserHost 以 file:// 标签页交给 Chromium 内置 PDF 查看器。转换结果按
 * 「路径 + 大小 + 修改时间」缓存，重复拖入同一文件不再启动 LibreOffice。
 *
 * 这是用户主动打开本地文件的功能，不是 Agent 工具；只接受明确的 Office/PDF 扩展名，
 * 并在转换前校验文件大小，避免把任意路径/超大文件塞进外部进程。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findSoffice, runSoffice } from "./officeConvert.js";
import { findOfficeApp, isOfficeProcessRunning, officeKindForFile, runOfficeExport } from "./officeNative.js";

const MAX_DOCUMENT_BYTES = 120 * 1024 * 1024;
const CONVERT_TIMEOUT_MS = 120_000;
/** 原生 Office 导出通常 3–10s；给慢机器留余量，但不能无限等 COM。 */
const NATIVE_OFFICE_TIMEOUT_MS = 45_000;
const CACHE_VERSION = "office-pdf-v3";

/**
 * 可交给 LibreOffice 转 PDF 的扩展名（含旧版二进制格式）。
 * PDF 直接交给 Chromium 查看器；WPS 等未列出的格式不猜测，避免调用失败的转换。
 */
const DOCUMENT_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".docm",
  ".dot",
  ".dotx",
  ".dotm",
  ".rtf",
  ".odt",
  ".ott",
  ".xls",
  ".xlsx",
  ".xlsm",
  ".xlsb",
  ".xlt",
  ".xltx",
  ".xltm",
  ".csv",
  ".ods",
  ".ots",
  ".ppt",
  ".pptx",
  ".pptm",
  ".pps",
  ".ppsx",
  ".ppsm",
  ".pot",
  ".potx",
  ".potm",
  ".odp",
  ".otp",
]);

export interface PreparedOfficePreview {
  /** 可供 Chromium 直接加载的 PDF 绝对路径。 */
  pdf: string;
  /** 原始文件名（含扩展名）。 */
  title: string;
  /** 是否刚从 Office 转换而来（缓存命中为 false）。 */
  converted: boolean;
}

/** 小写扩展名；不是文件路径时返回空串。 */
export function officeExtension(file: string): string {
  return path.extname(String(file ?? "")).toLowerCase();
}

/** 是否为可预览的本地 Office/PDF 文档。 */
export function isOfficeDocument(file: string): boolean {
  return DOCUMENT_EXTENSIONS.has(officeExtension(file));
}

/**
 * 把 Chromium 的 file:// URL 还原成本地路径，并且只对可预览文档返回。
 * 返回 null = 不是本地文件 / 不是支持的类型（调用方应保持原有导航行为）。
 */
export function officeFileFromUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(String(rawUrl ?? ""));
    if (parsed.protocol !== "file:") return null;
    const file = fileURLToPath(parsed);
    return isOfficeDocument(file) ? file : null;
  } catch {
    return null;
  }
}

/** 预览标签页标题：去掉扩展名，空名回退为「文档预览」。 */
export function officeDocumentTitle(file: string): string {
  const base = path.basename(String(file ?? ""));
  const title = base.slice(0, Math.max(0, base.length - path.extname(base).length)).trim();
  return title.slice(0, 120) || "文档预览";
}

/** 串行化转换：LibreOffice 共用用户配置时并发启动会互相锁住，预览只需排队等待。 */
let conversionQueue: Promise<unknown> = Promise.resolve();

function enqueueConversion<T>(task: () => Promise<T>): Promise<T> {
  const next = conversionQueue.then(task, task);
  conversionQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function cachePathFor(file: string, stat: fs.Stats, cacheDir: string): string {
  const key = createHash("sha1")
    .update(`${path.resolve(file)}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}\0${CACHE_VERSION}`)
    .digest("hex");
  return path.join(cacheDir, `${key}.pdf`);
}

export interface OfficePreviewOptions {
  cacheDir: string;
  timeoutMs?: number;
  /** 默认优先本机 Microsoft Office；测试/特殊环境可显式关闭，直接走 LibreOffice。 */
  preferMicrosoftOffice?: boolean;
  /** 缓存未命中、真正开始转换时回调一次，供 UI 立即显示进度，避免像“卡死”。 */
  onProgress?: (message: string) => void;
}

function usablePdf(file: string): boolean {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/**
 * 预热 LibreOffice 用户配置。首次转换最慢的一段是创建 profile/font cache；
 * 在应用启动后把这个成本提前 amortize 掉，之后第一次拖入文档会明显更快。
 * 已有 Office 原生导出时不需要预热（原生优先，LibreOffice 只是兜底）。
 */
export async function warmOfficePreview(options: { cacheDir: string; timeoutMs?: number }): Promise<void> {
  if (process.platform === "win32" && (findOfficeApp("word") || findOfficeApp("powerpoint") || findOfficeApp("excel"))) {
    return;
  }
  const command = findSoffice();
  if (!command) return;
  const cacheDir = path.resolve(options.cacheDir);
  const profile = path.join(cacheDir, "soffice-profile");
  fs.mkdirSync(profile, { recursive: true });
  await enqueueConversion(() =>
    runSoffice(
      command,
      [
        `-env:UserInstallation=${pathToFileURL(profile).href}`,
        "--headless",
        "--norestore",
        "--nolockcheck",
        "--nofirststartwizard",
        "--terminate_after_init",
      ],
      options.timeoutMs ?? 20_000,
    ),
  );
}

/**
 * 准备预览 PDF：
 *   · PDF 原样返回；
 *   · Office 文档优先用本机 Microsoft Office 导出 PDF（保真，避免 LibreOffice 的 PPT 错位），
 *     没有 Office 或导出失败时回退 LibreOffice headless；
 *   · 结果按「路径 + 大小 + 修改时间」缓存到 <dataDir>/office-preview。
 *
 * 抛出可读错误（缺少转换器 / 文件不存在 / 转换失败），由 IPC 层转成提示。
 */
export async function prepareOfficePreview(
  file: string,
  options: OfficePreviewOptions,
): Promise<PreparedOfficePreview> {
  const resolved = path.resolve(String(file ?? ""));
  const ext = officeExtension(resolved);
  if (!DOCUMENT_EXTENSIONS.has(ext)) {
    throw new Error("只支持 Office 文档或 PDF");
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`文件不存在或无法读取：${resolved}`);
  }
  if (!stat.isFile()) throw new Error("目标不是文件");
  if (stat.size > MAX_DOCUMENT_BYTES) {
    throw new Error(`文件过大（上限 ${Math.round(MAX_DOCUMENT_BYTES / 1024 / 1024)}MB）`);
  }

  const title = path.basename(resolved);
  if (ext === ".pdf") {
    return { pdf: resolved, title, converted: false };
  }

  const cacheDir = path.resolve(options.cacheDir);
  fs.mkdirSync(cacheDir, { recursive: true });
  const cached = cachePathFor(resolved, stat, cacheDir);
  try {
    const cachedStat = fs.statSync(cached);
    if (cachedStat.isFile() && cachedStat.size > 0) {
      return { pdf: cached, title, converted: false };
    }
  } catch {
    // 缓存不存在：继续转换
  }

  const nativeKind = options.preferMicrosoftOffice === false ? null : officeKindForFile(resolved);
  const nativeApp = nativeKind && !isOfficeProcessRunning(nativeKind) ? findOfficeApp(nativeKind) : null;
  const command = findSoffice();
  if (!nativeApp && !command) {
    throw new Error("未找到可用的 Office 转换器：请安装 Microsoft Office（推荐）或 LibreOffice");
  }

  return enqueueConversion(async () => {
    // 排队期间另一个请求可能已经转换完成，命中缓存就不再启动第二个转换器。
    if (usablePdf(cached)) {
      return { pdf: cached, title, converted: false };
    }

    options.onProgress?.("正在转换 Office 文档（首次打开可能需要 5–15 秒）…");
    let nativeFailure = "";

    // 优先原生 Office：PPT 的文本框/图片锚点/公式与源文件同一排版引擎，避免 LibreOffice 的错位。
    if (nativeKind && nativeApp) {
      const nativeTemp = `${cached}.${process.pid}.${Date.now()}.native.pdf`;
      try {
        await runOfficeExport(
          resolved,
          nativeTemp,
          nativeKind,
          Math.min(options.timeoutMs ?? NATIVE_OFFICE_TIMEOUT_MS, NATIVE_OFFICE_TIMEOUT_MS),
        );
        if (!usablePdf(nativeTemp)) throw new Error("Office 未生成有效的 PDF");
        fs.renameSync(nativeTemp, cached);
        return { pdf: cached, title, converted: true };
      } catch (err) {
        nativeFailure = err instanceof Error ? err.message : String(err);
        fs.rmSync(nativeTemp, { force: true });
        if (process.env.LOOPSOAR_OFFICE_DEBUG) {
          console.error(`[office-native] ${nativeFailure}`);
        }
        // Office 导出失败（文件被占用/受保护/COM 不可用）：继续走 LibreOffice 兜底。
      }
    }

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-office-preview-"));
    const outDir = path.join(workDir, "out");
    // 复用稳定的 LibreOffice profile：每次新建 profile 会重新生成字体缓存，
    // 这正是「第一次打开 Office 文档极慢」的主要来源。
    const profile = path.join(cacheDir, "soffice-profile");
    fs.mkdirSync(outDir, { recursive: true });
    fs.mkdirSync(profile, { recursive: true });
    try {
      await runSoffice(
        command!,
        [
          `-env:UserInstallation=${pathToFileURL(profile).href}`,
          "--headless",
          "--norestore",
          "--nolockcheck",
          "--nofirststartwizard",
          "--convert-to",
          "pdf",
          "--outdir",
          outDir,
          resolved,
        ],
        options.timeoutMs ?? CONVERT_TIMEOUT_MS,
      );
      const expected = path.join(outDir, `${path.basename(resolved, path.extname(resolved))}.pdf`);
      const produced = fs.existsSync(expected)
        ? expected
        : fs
            .readdirSync(outDir)
            .map((name) => path.join(outDir, name))
            .find((candidate) => candidate.toLowerCase().endsWith(".pdf")) ?? "";
      if (!produced) throw new Error("LibreOffice 未生成 PDF 文件");
      // 原子落缓存：先写临时文件再 rename，避免半截 PDF 被后续请求当成有效缓存。
      const temp = `${cached}.${process.pid}.${Date.now()}.tmp`;
      fs.copyFileSync(produced, temp);
      fs.renameSync(temp, cached);
      return { pdf: cached, title, converted: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(nativeFailure ? `${message}；Microsoft Office 导出失败：${nativeFailure}` : message);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
}
