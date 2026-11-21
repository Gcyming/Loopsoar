/**
 * 系统浏览器注册：让操作系统把 Loopsoar 当成「可选浏览器」，而不是普通 Electron 应用。
 *
 * 这里刻意不 import electron：
 *   - 注册只依赖可执行文件路径与平台，便于纯 Node 单测；
 *   - main/index.ts 仍是唯一需要 Electron 生命周期的组合根。
 *
 * Windows 的默认浏览器不能由程序静默改写（UserChoice 有系统哈希保护），
 * 我们能做的是登记浏览器能力（StartMenuInternet + RegisteredApplications + ProgID），
 * 让「设置 → 默认应用」出现 Loopsoar；用户选择后，http/https URL 会带着 %1 参数启动本应用。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface BrowserRegistrationInput {
  appName: string;
  executablePath: string;
  /** 开发期 Electron 需要显式加载的入口（打包后为空）。 */
  appPath?: string | null;
  /** false = 当前是未打包的 Electron（appPath 必须存在，否则注册命令不可用）。 */
  packaged?: boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  description?: string;
}

export interface BrowserRegistrationResult {
  ok: boolean;
  platform: NodeJS.Platform;
  registered: boolean;
  /** 写入的注册文件（Linux）或注册表根（Windows），便于诊断。 */
  target?: string;
  error?: string;
}

export interface RegistryEntry {
  key: string;
  /** 省略 name = 写默认值（reg.exe 的 /ve）。 */
  name?: string;
  value: string;
}

/** Windows 注册表写入器可注入，单测不会污染真实注册表。 */
export type RegistryRunner = (args: string[]) => void;

function windowsQuote(value: string): string {
  // Windows 路径/URL 不允许字面双引号；只做最薄的一层转义，避免破坏 reg.exe 的 argv。
  return `"${value.replace(/"/g, '\\"')}"`;
}

function normalizeAppPath(appPath?: string | null): string | null {
  const trimmed = appPath?.trim();
  if (!trimmed) return null;
  return path.resolve(trimmed);
}

/** 浏览器启动命令：打包后直接启动 exe；开发期先让 Electron 加载 app 入口。 */
export function browserLaunchCommand(input: Pick<BrowserRegistrationInput, "executablePath" | "appPath">): string {
  const exe = windowsQuote(input.executablePath);
  const appPath = normalizeAppPath(input.appPath);
  return appPath ? `${exe} ${windowsQuote(appPath)} "%1"` : `${exe} "%1"`;
}

/** 生成 Windows 浏览器登记项；纯函数，测试可直接断言键名与命令。 */
export function windowsBrowserRegistryEntries(input: BrowserRegistrationInput): RegistryEntry[] {
  const appName = input.appName.trim();
  const keyName = appName || "Loopsoar";
  const progId = `${keyName.replace(/[^A-Za-z0-9._-]/g, "")}HTML` || "LoopsoarHTML";
  const clientKey = `HKCU\\Software\\Clients\\StartMenuInternet\\${keyName}`;
  const capabilitiesKey = `${clientKey}\\Capabilities`;
  const registeredPath = `Software\\Clients\\StartMenuInternet\\${keyName}\\Capabilities`;
  const classesKey = `HKCU\\Software\\Classes\\${progId}`;
  const command = browserLaunchCommand(input);
  const icon = `${windowsQuote(input.executablePath)},0`;
  const description = input.description?.trim() || `${keyName} 浏览器与 Agent 工作台`;

  return [
    // 默认应用列表里的浏览器身份
    { key: clientKey, value: keyName },
    { key: `${clientKey}\\shell\\open\\command`, value: command },
    { key: capabilitiesKey, name: "ApplicationName", value: keyName },
    { key: capabilitiesKey, name: "ApplicationDescription", value: description },
    { key: capabilitiesKey, name: "ApplicationIcon", value: icon },
    // Windows 用 URLAssociations 判断它是否能处理浏览器协议
    { key: `${capabilitiesKey}\\URLAssociations`, name: "http", value: progId },
    { key: `${capabilitiesKey}\\URLAssociations`, name: "https", value: progId },
    { key: `${capabilitiesKey}\\FileAssociations`, name: ".htm", value: progId },
    { key: `${capabilitiesKey}\\FileAssociations`, name: ".html", value: progId },
    { key: `${capabilitiesKey}\\FileAssociations`, name: ".xhtml", value: progId },
    // 让 Windows 在「默认应用」里找到 Capabilities
    { key: "HKCU\\Software\\RegisteredApplications", name: keyName, value: registeredPath },
    // 实际的 URL/HTML ProgID 与打开命令
    { key: classesKey, value: `${keyName} HTML Document` },
    { key: `${classesKey}\\FriendlyTypeName`, value: `${keyName} HTML Document` },
    { key: `${classesKey}\\DefaultIcon`, value: icon },
    { key: `${classesKey}\\shell\\open\\command`, value: command },
    { key: `${classesKey}\\Application`, name: "ApplicationName", value: keyName },
    { key: `${classesKey}\\Application`, name: "ApplicationIcon", value: icon },
  ];
}

function runReg(args: string[]): void {
  const regExe = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe");
  try {
    execFileSync(regExe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const detail = err as { stderr?: Buffer | string; message?: string };
    const stderr = detail.stderr?.toString().trim();
    throw new Error(`${detail.message ?? "reg.exe 失败"}${stderr ? `：${stderr}` : ""}`);
  }
}

function writeWindowsRegistry(input: BrowserRegistrationInput, run: RegistryRunner): string {
  if (!input.executablePath.trim()) throw new Error("可执行文件路径为空，无法注册浏览器");
  if (input.packaged === false && !normalizeAppPath(input.appPath)) {
    throw new Error("开发期浏览器注册需要 appPath（Electron 入口脚本）");
  }
  const entries = windowsBrowserRegistryEntries(input);
  for (const entry of entries) {
    const args = [
      "add",
      entry.key,
      ...(entry.name ? ["/v", entry.name] : ["/ve"]),
      "/t",
      "REG_SZ",
      "/d",
      entry.value,
      "/f",
    ];
    // Electron 在 WOW64/受控环境下可能落到 32 位注册表视图；浏览器登记必须写用户默认视图。
    run(process.arch === "ia32" ? args : [...args, "/reg:64"]);
  }
  return `HKCU\\Software\\Clients\\StartMenuInternet\\${input.appName.trim() || "Loopsoar"}`;
}

function desktopQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`")}"`;
}

function desktopCommand(input: BrowserRegistrationInput): string {
  const appPath = normalizeAppPath(input.appPath);
  return [desktopQuote(input.executablePath), appPath ? desktopQuote(appPath) : null, "%U"].filter(Boolean).join(" ");
}

function writeLinuxDesktop(input: BrowserRegistrationInput, env: NodeJS.ProcessEnv): string {
  const home = env.HOME?.trim() || os.homedir();
  const dataHome = env.XDG_DATA_HOME?.trim() || path.join(home, ".local", "share");
  const dir = path.join(dataHome, "applications");
  const file = path.join(dir, "loopsoar.desktop");
  const content = [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${input.appName.trim() || "Loopsoar"}`,
    "Comment=Loopsoar 浏览器与 Agent 工作台",
    `Exec=${desktopCommand(input)}`,
    "Icon=loopsoar",
    "Terminal=false",
    "Categories=Network;WebBrowser;",
    "MimeType=x-scheme-handler/http;x-scheme-handler/https;text/html;text/xhtml+xml;",
    "StartupWMClass=Loopsoar",
    "",
  ].join("\n");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  fs.chmodSync(file, 0o755);
  return file;
}

/**
 * 注册 Loopsoar 为浏览器候选。
 * Windows 写 HKCU（无需管理员）；Linux 写用户 applications/*.desktop；macOS 需要 Info.plist 打包声明。
 */
export function registerAsBrowser(input: BrowserRegistrationInput, run: RegistryRunner = runReg): BrowserRegistrationResult {
  const platform = input.platform ?? process.platform;
  try {
    if (platform === "win32") {
      const target = writeWindowsRegistry(input, run);
      return { ok: true, platform, registered: true, target };
    }
    if (platform === "linux") {
      const target = writeLinuxDesktop(input, input.env ?? process.env);
      return { ok: true, platform, registered: true, target };
    }
    if (platform === "darwin") {
      return {
        ok: false,
        platform,
        registered: false,
        error: "macOS 需要在打包的 Info.plist 中声明 http/https URL Types（见打包配置）",
      };
    }
    return { ok: false, platform, registered: false, error: `不支持的平台：${platform}` };
  } catch (err) {
    return {
      ok: false,
      platform,
      registered: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 当前 Windows 注册表是否已有默认应用可见的能力声明（只读诊断，不抛错）。 */
export function readWindowsBrowserRegistration(input: Pick<BrowserRegistrationInput, "appName">): boolean {
  try {
    const keyName = input.appName.trim() || "Loopsoar";
    const output = execFileSync(
      "reg.exe",
      ["query", `HKCU\\Software\\RegisteredApplications`, "/v", keyName],
      { windowsHide: true, encoding: "utf8" },
    );
    return output.includes(keyName);
  } catch {
    return false;
  }
}
