/**
 * Microsoft Office 原生导出：优先用已安装的 Word/PowerPoint/Excel 把文档导出为 PDF。
 *
 * 为什么需要它：LibreOffice 对复杂 PPT/Word 的字体、文本框、公式和图片锚点常有偏移，
 * 同一份文件在 PowerPoint 里正常、转成 PDF 后却「错位」。Office 自己的 PDF 导出与源文件
 * 使用同一套排版引擎，保真度最高；没有 Office 时由调用方回退 LibreOffice。
 *
 * 只在 Windows 桌面端启用；宏一律禁用，文件只读打开，不修改源文件。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type OfficeKind = "word" | "excel" | "powerpoint";

const WORD_EXTENSIONS = new Set([".doc", ".docx", ".docm", ".dot", ".dotx", ".dotm", ".rtf"]);
const EXCEL_EXTENSIONS = new Set([".xls", ".xlsx", ".xlsm", ".xlsb", ".xlt", ".xltx", ".xltm", ".csv"]);
const POWERPOINT_EXTENSIONS = new Set([".ppt", ".pptx", ".pptm", ".pps", ".ppsx", ".ppsm", ".pot", ".potx", ".potm"]);

/** 扩展名 → 需要调用的 Office 应用；OpenDocument 等非微软格式返回 null，交给 LibreOffice。 */
export function officeKindForFile(file: string): OfficeKind | null {
  const ext = path.extname(String(file ?? "")).toLowerCase();
  if (WORD_EXTENSIONS.has(ext)) return "word";
  if (EXCEL_EXTENSIONS.has(ext)) return "excel";
  if (POWERPOINT_EXTENSIONS.has(ext)) return "powerpoint";
  return null;
}

const OFFICE_EXE: Record<OfficeKind, string> = {
  word: "WINWORD.EXE",
  excel: "EXCEL.EXE",
  powerpoint: "POWERPNT.EXE",
};

/** Office Click-to-Run 的常见安装目录（32/64 位、2016+）。 */
const OFFICE_SUBDIRS = [
  "Microsoft Office/root/Office16",
  "Microsoft Office/root/Office15",
  "Microsoft Office/Office16",
  "Microsoft Office/Office15",
  "Microsoft Office/Office14",
];

/**
 * 查找本机 Office 可执行文件。找不到时返回 null（调用方继续走 LibreOffice）。
 * 不用 COM 探测：直接查文件更便宜，也避免启动 Office 进程才能判断。
 */
export function findOfficeApp(kind: OfficeKind): string | null {
  if (process.platform !== "win32") return null;
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramW6432]
    .filter((value): value is string => Boolean(value));
  for (const root of roots) {
    for (const subdir of OFFICE_SUBDIRS) {
      const candidate = path.join(root, subdir, OFFICE_EXE[kind]);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // 无权限/路径非法：继续找
      }
    }
  }
  return null;
}

/**
 * 用户已经打开同款 Office 时不要再走 COM：Word/PowerPoint 是单实例应用，
 * `New-Object -ComObject` 可能附着到用户正在编辑的实例，`Quit()` 会关掉用户窗口。
 * 这种场景直接走 LibreOffice 隔离转换，宁可回退也不碰用户文档。
 */
export function isOfficeProcessRunning(kind: OfficeKind): boolean {
  if (process.platform !== "win32") return false;
  try {
    const image = OFFICE_EXE[kind];
    const result = spawnSync("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/NH"], {
      windowsHide: true,
      encoding: "utf8",
    });
    if (result.status !== 0) return false;
    return String(result.stdout ?? "").toLowerCase().includes(image.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * 由 PowerShell 驱动 COM 导出。脚本只从环境变量读路径，避免把用户文件名拼进命令字符串；
 * 文件以只读方式打开，AutomationSecurity=3 强制禁用宏。
 */
const EXPORT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$input = $env:LOOPSOAR_OFFICE_INPUT",
  "$output = $env:LOOPSOAR_OFFICE_OUTPUT",
  "$kind = $env:LOOPSOAR_OFFICE_KIND",
  "try {",
  "  switch ($kind) {",
  "    'word' {",
  "      $app = New-Object -ComObject Word.Application",
  "      $app.Visible = $false",
  "      $app.DisplayAlerts = 0",
  "      $app.AutomationSecurity = 3",
  "      $doc = $null",
  "      try {",
  "        $app.Options.UpdateLinksAtOpen = $false",
  "        $doc = $app.Documents.Open($input, $false, $true, $false)",
  "        $doc.ExportAsFixedFormat($output, 17)",
  "      } finally {",
  "        if ($doc) { $doc.Close(0) }",
  "        $app.Quit()",
  "      }",
  "    }",
  "    'excel' {",
  "      $app = New-Object -ComObject Excel.Application",
  "      $app.Visible = $false",
  "      $app.DisplayAlerts = $false",
  "      $app.AskToUpdateLinks = $false",
  "      $app.AutomationSecurity = 3",
  "      $wb = $null",
  "      try {",
  "        $wb = $app.Workbooks.Open($input, 0, $true)",
  "        # Excel 默认不打印网格线；xlsx 常见“只有文字、没有表格线”。预览 PDF 强制打开",
  "        # 每个工作表的打印网格线；小表再缩放到一页，避免预览里表格只占左上角一小块。",
  "        foreach ($ws in $wb.Worksheets) {",
  "          try {",
  "            $ws.PageSetup.PrintGridlines = $true",
  "            $used = $ws.UsedRange",
  "            if ($used.Columns.Count -le 20 -and $used.Rows.Count -le 60) {",
  "              $ws.PageSetup.Zoom = $false",
  "              $ws.PageSetup.FitToPagesWide = 1",
  "              $ws.PageSetup.FitToPagesTall = 1",
  "              $ws.PageSetup.CenterHorizontally = $true",
  "            }",
  "          } catch {}",
  "        }",
  "        $wb.ExportAsFixedFormat(0, $output)",
  "      } finally {",
  "        if ($wb) { $wb.Close($false) }",
  "        $app.Quit()",
  "      }",
  "    }",
  "    'powerpoint' {",
  "      $app = New-Object -ComObject PowerPoint.Application",
  "      $app.DisplayAlerts = 1",
  "      $app.AutomationSecurity = 3",
  "      $pres = $null",
  "      try {",
  "        $pres = $app.Presentations.Open($input, $true, $false, $false)",
  "        $pres.SaveAs($output, 32)",
  "      } finally {",
  "        if ($pres) { $pres.Close() }",
  "        $app.Quit()",
  "      }",
  "    }",
  "    default { throw ('未知的 Office 类型：' + $kind) }",
  "  }",
  "  Write-Output 'OK'",
  "} catch {",
  "  [Console]::Error.WriteLine($_.Exception.Message)",
  "  exit 1",
  "}",
].join("\n");

function powershellPath(): string {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const candidate = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return fs.existsSync(candidate) ? candidate : "powershell.exe";
}

function killTree(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid) {
    try {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      return;
    } catch {
      // 回退 child.kill
    }
  }
  child.kill();
}

/**
 * PowerPoint 的 COM Quit() 常把进程留在后台（无窗口但仍驻留），下次打开会被
 * isOfficeProcessRunning 判定为用户实例而被迫回退 LibreOffice。因此在**确认启动前
 * 没有 PowerPoint** 的前提下，导出结束后强制清理该影像进程。
 */
function killPowerPointIfLeftover(): void {
  if (process.platform !== "win32") return;
  try {
    spawnSync("taskkill", ["/IM", OFFICE_EXE.powerpoint, "/F"], { windowsHide: true, timeout: 5_000 });
  } catch {
    // 进程已经退出/无权限：忽略
  }
}

/**
 * 用原生 Office 把文件导出为 PDF。输出必须真实存在且非空，否则视为失败，让调用方回退。
 * 超时会连同 PowerShell 子进程一起结束，避免 PowerPoint/Word 残留在后台继续占文件。
 */
export function runOfficeExport(
  file: string,
  outputPdf: string,
  kind: OfficeKind,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = Buffer.from(EXPORT_SCRIPT, "utf16le").toString("base64");
    const child = spawn(
      powershellPath(),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", script],
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          LOOPSOAR_OFFICE_INPUT: path.resolve(file),
          LOOPSOAR_OFFICE_OUTPUT: path.resolve(outputPdf),
          LOOPSOAR_OFFICE_KIND: kind,
        },
      },
    );
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      killTree(child);
      if (kind === "powerpoint") killPowerPointIfLeftover();
      finish(() => reject(new Error(`Office 导出 PDF 超时（${Math.round(timeoutMs / 1000)}s）`)));
    }, timeoutMs);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8").slice(0, 4_000);
    });
    child.on("error", (err) => {
      if (kind === "powerpoint") killPowerPointIfLeftover();
      finish(() => reject(new Error(`无法启动 Office 导出：${err.message}`)));
    });
    child.on("close", (code) => {
      if (kind === "powerpoint") killPowerPointIfLeftover();
      if (code !== 0) {
        finish(() => reject(new Error(`Office 导出 PDF 失败（退出码 ${code ?? "未知"}）${stderr ? `：${stderr.trim()}` : ""}`)));
        return;
      }
      try {
        const stat = fs.statSync(outputPdf);
        if (!stat.isFile() || stat.size === 0) {
          finish(() => reject(new Error("Office 未生成有效的 PDF 文件")));
          return;
        }
        finish(resolve);
      } catch (err) {
        finish(() => reject(new Error(`Office 导出后找不到 PDF：${err instanceof Error ? err.message : String(err)}`)));
      }
    });
  });
}
