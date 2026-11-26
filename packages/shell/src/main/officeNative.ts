/**
 * Microsoft Office 原生导出：优先用已安装的 Word/PowerPoint/Excel 把文档导出为 PDF。
 *
 * 为什么需要它：LibreOffice 对复杂 PPT/Word 的字体、文本框、公式和图片锚点常有偏移，
 * 同一份文件在 PowerPoint 里正常、转成 PDF 后却「错位」。Office 自己的 PDF 导出与源文件
 * 使用同一套排版引擎，保真度最高；没有 Office 时由调用方回退 LibreOffice。
 *
 * 只在 Windows 桌面端启用；宏一律禁用，文件只读打开，不修改源文件。
 *
 * 进程归属：PowerPoint 的 COM Quit() 常留下无窗口后台进程。清理这类残留时只允许结束
 * 本应用自己启动、并记录过 PID 的进程（见 officeProcessGuard.ts）；用户自己打开的
 * PowerPoint 没有 PID 记录，绝不能被按映像名误杀。
 */
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  createOfficeProcessTracker,
  decideOfficeProcessCleanup,
  type OfficeCleanupDecision,
  type OfficeProcessKind,
  type OfficeProcessTracker,
  type ProcessSnapshot,
  type ProcessSnapshotEntry,
} from "./officeProcessGuard.js";

/** Office 应用种类；与进程守卫共用同一套字面量。 */
export type OfficeKind = OfficeProcessKind;

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

/** Get-Process 使用的进程名（不带 .exe）；PowerPoint 残留清理只认这个映像 + 已记录 PID。 */
const POWERPOINT_PROCESS_NAME = path.parse(OFFICE_EXE.powerpoint).name;

/** PowerShell 脚本确认「启动前没有 PowerPoint、激活后恰好多出一个」时打印的 PID 标记。 */
export const TRACKED_OFFICE_PID_MARKER = "LOOPSOAR_OFFICE_PID=";

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
  "$processName = $env:LOOPSOAR_OFFICE_PROCESS_NAME",
  "$trackedBefore = @()",
  "if ($processName) {",
  "  try {",
  "    $trackedBefore = @(Get-Process -Name $processName -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })",
  "  } catch {",
  "    # 查询失败就放弃记录：没有启动前基线时不能把任何进程认作自己的。",
  "    $processName = $null",
  "  }",
  "}",
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
  "      # 记录本应用启动的 PowerPoint PID：残留清理只允许结束这个 PID，不按映像名误杀用户实例。",
  "      if ($processName) {",
  "        try {",
  "          $after = @(Get-Process -Name $processName -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })",
  "          $new = @($after | Where-Object { $trackedBefore -notcontains $_ })",
  "          if ($trackedBefore.Count -eq 0 -and $new.Count -eq 1) {",
  "            Write-Output ('LOOPSOAR_OFFICE_PID=' + $new[0])",
  "          }",
  "        } catch {}",
  "      }",
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

/** 启动导出进程的注入点：生产用 node:child_process.spawn，测试注入假进程。 */
export type OfficeProcessSpawner = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/** 可注入依赖：测试替换进程启动/查询/结束；生产全部走真实实现。 */
export interface OfficeNativeDeps {
  /** 启动 PowerShell 导出进程。 */
  spawnProcess?: OfficeProcessSpawner;
  /** 查询当前进程快照；null 表示查询失败（不得据此 kill）。 */
  listProcesses?: () => ProcessSnapshot;
  /** 结束指定 PID；只在归属确认后调用。 */
  killProcess?: (pid: number) => void;
  /** PID 登记表；测试注入独立实例，避免用例之间串扰。 */
  tracker?: OfficeProcessTracker;
  /** 时间源（测试注入固定时钟）。 */
  now?: () => number;
}

/** 查询当前进程快照（PID + 映像名）。null = 查询失败，调用方不得据此 kill。 */
export function listOfficeProcesses(): ProcessSnapshot {
  if (process.platform !== "win32") return [];
  try {
    const result = spawnSync("tasklist", ["/FO", "CSV", "/NH"], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 5_000,
    });
    if (result.error || result.status !== 0 || typeof result.stdout !== "string") return null;
    const entries: ProcessSnapshotEntry[] = [];
    for (const line of result.stdout.split(/\r?\n/)) {
      // CSV 首两列：`"POWERPNT.EXE","1234",...`；本地化提示行不以引号开头，自然跳过。
      const match = /^"([^"]+)","(\d+)"/.exec(line.trim());
      if (!match) continue;
      const pid = Number(match[2]);
      if (Number.isSafeInteger(pid) && pid > 0) entries.push({ pid, imageName: match[1] });
    }
    return entries;
  } catch {
    return null;
  }
}

/** 按 PID 结束进程；只有 cleanupTrackedOfficeProcess 在归属确认后才会调用。 */
function killOfficeProcessByPid(pid: number): void {
  if (process.platform !== "win32") return;
  try {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5_000 });
  } catch {
    // 进程已经退出/无权限：忽略
  }
}

/** 从 PowerShell 输出里解析脚本报告的 Office PID；没有标记返回 null。 */
export function parseTrackedOfficePid(output: string): number | null {
  const match = new RegExp(`${TRACKED_OFFICE_PID_MARKER}(\\d{1,10})`).exec(String(output ?? ""));
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/** 本进程内唯一的 PID 登记表（导出串行执行，同一 kind 只需保留最近一条）。 */
const defaultTracker = createOfficeProcessTracker();

/**
 * 清理「本应用启动并记录过 PID」的 Office 进程。
 *
 * 无记录、记录过期、快照查询失败、进程已退出、PID 被复用（映像名不符）时一律不 kill；
 * 返回决策供调用方记录日志，也便于单测断言。
 */
export function cleanupTrackedOfficeProcess(kind: OfficeKind, deps: OfficeNativeDeps = {}): OfficeCleanupDecision {
  const tracked = (deps.tracker ?? defaultTracker).take(kind);
  if (!tracked) return { action: "skip", reason: "no-tracking" };
  let snapshot: ProcessSnapshot;
  try {
    snapshot = (deps.listProcesses ?? listOfficeProcesses)();
  } catch {
    // 查询异常等同于查询失败：无法证明进程还在，绝不 kill。
    snapshot = null;
  }
  const decision = decideOfficeProcessCleanup({ tracked, snapshot, now: (deps.now ?? Date.now)() });
  if (decision.action === "kill") {
    try {
      (deps.killProcess ?? killOfficeProcessByPid)(decision.pid);
    } catch {
      // 清理失败只影响后台残留，不影响导出结果
    }
  }
  return decision;
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
  deps: OfficeNativeDeps = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = Buffer.from(EXPORT_SCRIPT, "utf16le").toString("base64");
    const spawnProcess: OfficeProcessSpawner = deps.spawnProcess ?? ((command, args, options) => spawn(command, args, options));
    const tracker = deps.tracker ?? defaultTracker;
    const child = spawnProcess(
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
          // 只对 PowerPoint 记录进程归属：脚本会在 PowerPoint 激活后报告它启动的 PID。
          ...(kind === "powerpoint" ? { LOOPSOAR_OFFICE_PROCESS_NAME: POWERPOINT_PROCESS_NAME } : {}),
        },
      },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    /** 清理本应用启动的 PowerPoint 残留；归属不明时 cleanupTrackedOfficeProcess 内部会拒绝 kill。 */
    const cleanup = (): void => {
      if (kind === "powerpoint") cleanupTrackedOfficeProcess(kind, deps);
    };
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      killTree(child);
      cleanup();
      finish(() => reject(new Error(`Office 导出 PDF 超时（${Math.round(timeoutMs / 1000)}s）`)));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8").slice(0, 4_000);
      const pid = parseTrackedOfficePid(stdout);
      if (pid !== null && kind === "powerpoint") tracker.track(kind, pid, OFFICE_EXE.powerpoint);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8").slice(0, 4_000);
    });
    child.on("error", (err) => {
      cleanup();
      finish(() => reject(new Error(`无法启动 Office 导出：${err.message}`)));
    });
    child.on("close", (code) => {
      cleanup();
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
