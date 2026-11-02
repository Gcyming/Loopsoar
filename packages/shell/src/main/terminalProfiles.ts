/**
 * 终端配置档（profile）：可用性探测 + spawn 规格解析。
 *
 * 为什么单独成模块：
 *   · 持久终端会话（terminalSession）与 Agent 工具 terminal_run（一次性执行）必须共用
 *     「同一份」解释器路径 / 启动参数 / C++ 工具链环境，否则两条执行路径行为漂移，会出现
 *     「面板里 python 能用、Agent 跑 python 却失败」这类无法解释的 bug；
 *   · 探测（起子进程问版本）与解析（同步给出 spawn 参数）节奏不同：UI 打开面板时异步探测
 *     一次并缓存 60s，而每条命令执行前都要同步拿到规格，所以拆成
 *     detectTerminalProfiles（异步、带缓存、失败降级不抛）与 resolveProfile（同步、不起进程）。
 *
 * 安全：spawn 的环境变量必须来自 buildTerminalEnv 白名单（见该函数注释）；这里的 env 只是
 * 「在白名单之上追加工具链需要的变量」（如 MinGW 的 PATH 前缀），不允许引入密钥类变量。
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type TerminalProfileKey = "cmd" | "powershell" | "gitbash" | "python" | "node" | "cpp";

/** 配置档枚举（与 contracts TerminalProfileKeySchema 同值；参数合法性由契约 zod 再校验一次）。 */
export const TERMINAL_PROFILE_KEYS: readonly TerminalProfileKey[] = [
  "cmd",
  "powershell",
  "gitbash",
  "python",
  "node",
  "cpp",
];

export type TerminalProfileKind = "shell" | "interpreter" | "toolchain";

export interface TerminalProfileInfo {
  key: TerminalProfileKey;
  label: string;
  description: string;
  available: boolean;
  version?: string;
  detail?: string;
  kind: TerminalProfileKind;
}

/** 一次 spawn 的完整规格：命令 + 参数 + 额外环境变量（与 buildTerminalEnv 合并后使用）。 */
export interface TerminalSpawnSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /**
   * true = 传 windowsVerbatimArguments（仅 Windows 有意义）。
   * 为什么需要：C++/MSVC 的启动串里必须保留 `call "C:\Program Files\..."` 这类引号，
   * Node 默认的 Windows 参数转义会把内嵌引号转成 \"（cmd 不认），用 verbatim 让 cmd 收到
   * 原始命令行才能正确解析含空格的 vcvars 路径。
   * 前提：command 自身路径不含空格（cmd.exe 系统路径满足）。
   */
  verbatim?: boolean;
}

/**
 * 解析后的配置档：持久模式规格 + 一次性执行构造器。
 * fail-closed 约定：available=false 时 persistent 必须为 null、buildOneShot 必须返回 null，
 * 绝不允许「环境不可用就悄悄换一个解释器执行」。
 */
export interface ResolvedProfile {
  key: TerminalProfileKey;
  label: string;
  kind: TerminalProfileKind;
  available: boolean;
  detail?: string;
  persistent: TerminalSpawnSpec | null;
  buildOneShot: (command: string) => TerminalSpawnSpec | null;
}

/* ───────────────────────── 静态描述（label/说明/安装提示） ───────────────────────── */

interface ProfileMeta {
  label: string;
  description: string;
  kind: TerminalProfileKind;
  /** 不可用时的中文安装提示（UI 直接展示，避免用户只看到「不可用」）。 */
  installHint: string;
}

const PROFILE_META: Record<TerminalProfileKey, ProfileMeta> = {
  cmd: {
    label: "命令提示符",
    description: "Windows cmd.exe，启动即切 UTF-8 代码页（chcp 65001）",
    kind: "shell",
    installHint: "未找到 cmd.exe（Windows 系统自带，请检查 %COMSPEC% 与 System32 是否存在）。",
  },
  powershell: {
    label: "PowerShell",
    description: "Windows PowerShell（-NoLogo -NoProfile -NonInteractive 启动）",
    kind: "shell",
    installHint: "未找到 powershell.exe。Windows 10/11 自带；也可安装 PowerShell 7 并把 powershell.exe 加入 PATH。",
  },
  gitbash: {
    label: "Git Bash",
    description: "Git for Windows 的 bash（--noprofile --norc）",
    kind: "shell",
    installHint: "未检测到 Git Bash。安装 Git for Windows（https://git-scm.com/download/win）或把其 bin\\bash.exe 加入 PATH。",
  },
  python: {
    label: "Python 3",
    description: "Python 3 交互解释器（py -3 -u -i；无 py 启动器时回退 python）",
    kind: "interpreter",
    installHint: "未检测到可运行的 Python 3。安装 python.org 版或 Microsoft Store 版，确保 py 或 python 在 PATH 中（WindowsApps 的商店别名不算已安装）。",
  },
  node: {
    label: "Node.js",
    description: "系统 Node.js REPL（node -i）",
    kind: "interpreter",
    installHint: "未在 PATH 检测到可运行的 node。安装 Node.js 后重开应用（应用自带的 Electron 不用于终端，避免递归拉起应用）。",
  },
  cpp: {
    label: "C/C++ 工具链",
    description: "MSVC（vswhere 定位 → vcvars64.bat）或 MinGW-w64（g++/clang++）",
    kind: "toolchain",
    installHint: "未检测到 C++ 工具链。安装 Visual Studio Build Tools 并勾选「使用 C++ 的桌面开发」，或安装 MinGW-w64 并把 g++ 加入 PATH。",
  },
};

/* ───────────────────────── 探测结果（路径 + 版本） ───────────────────────── */

interface LocatedExe {
  /** 可执行文件绝对路径。 */
  path: string;
  version?: string;
}

interface PythonRuntime extends LocatedExe {
  /** py 启动器需要 "-3" 参数；python 可执行文件不需要。 */
  baseArgs: string[];
}

type CppToolchain =
  | { kind: "msvc"; vcvars: string; version?: string; label: string }
  | { kind: "mingw"; compiler: string; version?: string; label: string };

interface ProfileRuntime {
  cmd: LocatedExe | null;
  powershell: LocatedExe | null;
  gitbash: LocatedExe | null;
  python: PythonRuntime | null;
  node: LocatedExe | null;
  cpp: CppToolchain | null;
}

const CACHE_TTL_MS = 60_000; // 60s 缓存：面板反复打开/命令连续执行时不重复起探测进程

let detectCache: { at: number; infos: TerminalProfileInfo[]; runtime: ProfileRuntime } | null = null;
let syncCache: { at: number; runtime: ProfileRuntime } | null = null;

/** 仅供测试：清空探测缓存（生产代码不得调用）。 */
export function __resetTerminalProfileCacheForTests(): void {
  detectCache = null;
  syncCache = null;
}

/** 运行时类型守卫：IPC 参数虽经契约为枚举，但 manager/tool 也可能被内部直接调用。 */
export function isTerminalProfileKey(value: unknown): value is TerminalProfileKey {
  return typeof value === "string" && (TERMINAL_PROFILE_KEYS as readonly string[]).includes(value);
}

/* ───────────────────────── 对外入口：探测（异步） ───────────────────────── */

/**
 * 探测全部配置档（60s 缓存）。
 * 失败一律降级为 available:false + 中文安装提示，绝不向调用方抛错——
 * 终端面板是「锦上添花」的能力，缺一个解释器不应让整个设置/面板崩掉。
 */
export async function detectTerminalProfiles(): Promise<TerminalProfileInfo[]> {
  const now = Date.now();
  if (detectCache && now - detectCache.at < CACHE_TTL_MS) return cloneInfos(detectCache.infos);
  const runtime = await probeRuntimeAsync();
  const infos = TERMINAL_PROFILE_KEYS.map((key) => toInfo(key, runtime));
  detectCache = { at: Date.now(), infos, runtime };
  return cloneInfos(infos);
}

/* ───────────────────────── 对外入口：解析（同步） ───────────────────────── */

/**
 * 同步解析配置档 spawn 规格（不起子进程）。
 * 优先消费 60s 内的异步探测结果（可用性以真实执行验证为准，如 WindowsApps 的 python 别名）；
 * 未探测过则做同步路径探测（只看文件是否存在），保证「先执行命令、后面板才打开」也有规格可用。
 */
export function resolveProfile(key: TerminalProfileKey | string): ResolvedProfile | null {
  if (!isTerminalProfileKey(key)) return null;
  const meta = PROFILE_META[key];
  const detected = detectCache && Date.now() - detectCache.at < CACHE_TTL_MS ? detectCache : null;
  const runtime = detected?.runtime ?? syncRuntime();
  const detectedInfo = detected?.infos.find((info) => info.key === key);

  const available = detectedInfo ? detectedInfo.available : hasRuntimeFor(key, runtime);
  const persistent = available ? buildPersistentSpec(key, runtime) : null;
  if (!available || !persistent) {
    return {
      key,
      label: meta.label,
      kind: meta.kind,
      available: false,
      detail: detectedInfo?.detail ?? meta.installHint,
      persistent: null,
      buildOneShot: () => null,
    };
  }
  return {
    key,
    label: meta.label,
    kind: meta.kind,
    available: true,
    persistent,
    buildOneShot: (command: string) => buildOneShotSpec(key, runtime, command),
  };
}

/* ───────────────────────── 环境变量白名单 ───────────────────────── */

/**
 * 保留变量：shell/解释器启动与 UTF-8 输出所必需的系统变量。
 * 刻意不含 NODE_OPTIONS/ELECTRON_*（父进程的注入项不应影响终端子进程）。
 */
const TERMINAL_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SystemDrive",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMDATA",
  "COMSPEC",
  "WINDIR",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  "VIRTUAL_ENV",
  "PYTHONIOENCODING",
];

/** 敏感变量名（与白名单叠加使用，双保险）。 */
const SENSITIVE_ENV_NAME_RE =
  /(?:API_?KEY|ACCESS_?KEY|AUTH_?TOKEN|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_?KEY)/i;

function isSensitiveEnvName(name: string): boolean {
  return SENSITIVE_ENV_NAME_RE.test(name) || name.toUpperCase().startsWith("LOOPSOAR_");
}

/**
 * 构造终端子进程环境变量（白名单）。
 *
 * 为什么是白名单：黑名单永远列不全（各家 SDK 的变量名千奇百怪），而终端会把整个环境变量
 * 暴露给用户在面板里输入的任何命令；白名单能把模型 API Key、业务密钥、LOOPSOAR_* 配置
 * 一次性挡在终端之外，符合 fail-closed。
 *
 * @param extra 工具链专用追加（如 MinGW 的 PATH 前缀）；仍会剥离敏感/LOOPSOAR_* 名称。
 */
export function buildTerminalEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  // 为什么用「规范化大小写」映射：Windows 环境变量大小写不敏感（宿主可能给 SYSTEMROOT/PATH），
  // 但返回的是普通对象（区分大小写）。统一写成白名单里的规范名，下游读取与测试才稳定。
  const canonical = new Map(TERMINAL_ENV_ALLOWLIST.map((name) => [name.toLowerCase(), name]));
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value !== "string") continue;
    const key = canonical.get(name.toLowerCase());
    if (!key) continue;
    if (isSensitiveEnvName(name)) continue;
    env[key] = value;
  }
  // Python 子进程统一 UTF-8：否则中文输出在 GBK 控制台会乱码（主进程侧解码按 UTF-8）
  if (!env.PYTHONIOENCODING) env.PYTHONIOENCODING = "utf-8";
  // Windows 环境变量名大小写变体兜底（PATH/Path 都可能出现）
  if (!env.PATH && typeof process.env.PATH === "string") env.PATH = process.env.PATH;
  if (extra) {
    for (const [name, value] of Object.entries(extra)) {
      if (typeof value !== "string") continue;
      if (isSensitiveEnvName(name)) continue;
      env[name] = value;
    }
  }
  return env;
}

/* ───────────────────────── spawn 规格构造 ───────────────────────── */

function buildPersistentSpec(key: TerminalProfileKey, runtime: ProfileRuntime): TerminalSpawnSpec | null {
  switch (key) {
    case "cmd":
      // /Q 关命令回显；/K 执行初始化后保持会话；chcp 65001 保证中文正确
      return runtime.cmd ? { command: runtime.cmd.path, args: ["/Q", "/K", "chcp 65001>nul"] } : null;
    case "powershell":
      // -Command -：从 stdin 逐行读取命令，闭包（函数/变量/cwd）全部保留
      return runtime.powershell
        ? {
            command: runtime.powershell.path,
            args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"],
          }
        : null;
    case "gitbash":
      // 非交互 bash 从 stdin 读命令；--noprofile --norc 避免用户配置干扰/拖慢启动
      return runtime.gitbash
        ? { command: runtime.gitbash.path, args: ["--noprofile", "--norc"] }
        : null;
    case "python":
      return runtime.python
        ? { command: runtime.python.path, args: [...runtime.python.baseArgs, "-u", "-i"] }
        : null;
    case "node":
      return runtime.node ? { command: runtime.node.path, args: ["-i"] } : null;
    case "cpp":
      return runtime.cpp ? buildCppPersistent(runtime.cpp, runtime) : null;
  }
}

function buildOneShotSpec(
  key: TerminalProfileKey,
  runtime: ProfileRuntime,
  command: string,
): TerminalSpawnSpec | null {
  switch (key) {
    case "cmd":
      return runtime.cmd ? { command: runtime.cmd.path, args: ["/d", "/s", "/c", command] } : null;
    case "powershell":
      return runtime.powershell
        ? {
            command: runtime.powershell.path,
            args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
          }
        : null;
    case "gitbash":
      return runtime.gitbash
        ? { command: runtime.gitbash.path, args: ["--noprofile", "--norc", "-c", command] }
        : null;
    case "python":
      return runtime.python
        ? { command: runtime.python.path, args: [...runtime.python.baseArgs, "-u", "-c", command] }
        : null;
    case "node":
      return runtime.node ? { command: runtime.node.path, args: ["-e", command] } : null;
    case "cpp":
      return buildCppOneShot(runtime, command);
  }
}

function buildCppPersistent(cpp: CppToolchain, runtime: ProfileRuntime): TerminalSpawnSpec {
  if (cpp.kind === "msvc") {
    // 在 cmd 里 call vcvars64.bat 后再 chcp：cl.exe/link.exe 的 INCLUDE/LIB/PATH 由此进入会话，
    // 之后用户/Agent 在同一个持久 shell 里连续编译无需重复初始化。
    return {
      command: runtime.cmd?.path ?? "cmd.exe",
      args: ["/Q", "/K", `call "${cpp.vcvars}" >nul 2>&1 & chcp 65001>nul`],
      verbatim: true,
    };
  }
  // MinGW：优先 Git Bash（PATH 前缀语义干净），否则 cmd 里把编译器目录塞进 PATH
  const env = { PATH: prependPath(path.dirname(cpp.compiler)) };
  if (runtime.gitbash) {
    return { command: runtime.gitbash.path, args: ["--noprofile", "--norc"], env };
  }
  return { command: runtime.cmd?.path ?? "cmd.exe", args: ["/Q", "/K", "chcp 65001>nul"], env };
}

function buildCppOneShot(runtime: ProfileRuntime, command: string): TerminalSpawnSpec | null {
  const cpp = runtime.cpp;
  if (!cpp) return null;
  if (cpp.kind === "msvc") {
    return {
      command: runtime.cmd?.path ?? "cmd.exe",
      // && 保证工具链初始化失败时不静默地执行命令（否则会得到「命令找不到」的误导输出）
      args: ["/d", "/s", "/c", `call "${cpp.vcvars}" >nul 2>&1 && ${command}`],
      verbatim: true,
    };
  }
  const env = { PATH: prependPath(path.dirname(cpp.compiler)) };
  if (runtime.gitbash) {
    return { command: runtime.gitbash.path, args: ["--noprofile", "--norc", "-c", command], env };
  }
  return { command: runtime.cmd?.path ?? "cmd.exe", args: ["/d", "/s", "/c", command], env, verbatim: true };
}

function prependPath(dir: string): string {
  const base = process.env.PATH ?? "";
  return base ? `${dir}${path.delimiter}${base}` : dir;
}

/* ───────────────────────── 探测实现 ───────────────────────── */

async function probeRuntimeAsync(): Promise<ProfileRuntime> {
  // 并行探测：最坏情况下每个探测有 4s 超时，串行会让面板首开明显卡顿
  const [cmd, powershell, gitbash, python, node, cpp] = await Promise.all([
    probeCmdAsync(),
    probePowerShellAsync(),
    probeGitBashAsync(),
    probePythonAsync(),
    probeNodeAsync(),
    probeCppAsync(),
  ]);
  return { cmd, powershell, gitbash, python, node, cpp };
}

async function probeCmdAsync(): Promise<LocatedExe | null> {
  const located = locateCmd();
  if (!located) return null;
  const captured = await runCapture(located.path, ["/d", "/s", "/c", "ver"]);
  if (!captured) return null;
  const version = parseWindowsVersion(captured.stdout);
  return { path: located.path, version };
}

async function probePowerShellAsync(): Promise<LocatedExe | null> {
  const located = locatePowerShell();
  if (!located) return null;
  const captured = await runCapture(located.path, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "$PSVersionTable.PSVersion.ToString()",
  ]);
  const version = captured?.stdout.trim();
  return captured && version ? { path: located.path, version } : null;
}

async function probeGitBashAsync(): Promise<LocatedExe | null> {
  const located = locateGitBash();
  if (!located) return null;
  const captured = await runCapture(located.path, [
    "--noprofile",
    "--norc",
    "-c",
    'printf \'%s\' "$BASH_VERSION"',
  ]);
  const version = captured?.stdout.trim();
  return captured && version ? { path: located.path, version } : null;
}

async function probePythonAsync(): Promise<PythonRuntime | null> {
  const candidates = pythonCandidates();
  // 并行验证（WindowsApps 别名会「文件存在但执行失败」，必须真跑一次）
  const results = await Promise.all(
    candidates.map(async (candidate) => {
      const captured = await runCapture(candidate.path, [
        ...candidate.baseArgs,
        "-u",
        "-c",
        "import sys;print(sys.version.split()[0])",
      ]);
      if (!captured) return null;
      const version = captured.stdout.trim();
      // 只认 "3.12.1" 这类版本号：WindowsApps 商店别名会打印「not found」并返回非 0 退出码
      return /^\d+\.\d+/.test(version) ? { ...candidate, version } : null;
    }),
  );
  return results.find((item) => item !== null) ?? null;
}

async function probeNodeAsync(): Promise<LocatedExe | null> {
  const located = locateNode();
  if (!located) return null;
  const captured = await runCapture(located.path, ["--version"]);
  const version = captured?.stdout.trim();
  return captured && version ? { path: located.path, version } : null;
}

/** 路径里出现这些字符会破坏 cmd 命令串（vcvars 路径要拼进 /K 初始化串），fail-closed 直接视为不可用。 */
function isSafeCmdPath(candidate: string): boolean {
  return !/["&|<>^\r\n]/.test(candidate);
}

async function probeCppAsync(): Promise<CppToolchain | null> {
  // ① MSVC：vswhere 能定位非默认盘/自定义安装路径
  const vswhere = locateVsWhere();
  if (vswhere) {
    const captured = await runCapture(vswhere, [
      "-latest",
      "-products",
      "*",
      "-requires",
      "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
      "-property",
      "installationPath",
    ]);
    const installPath = captured?.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (installPath) {
      const vcvars = path.join(installPath, "VC", "Auxiliary", "Build", "vcvars64.bat");
      // 路径校验：vcvars 会拼进 cmd 命令串，含引号/连接符的异常安装路径一律不认（防命令串注入）
      if (isFile(vcvars) && isSafeCmdPath(vcvars)) {
        const versionCaptured = await runCapture(vswhere, [
          "-latest",
          "-products",
          "*",
          "-property",
          "installationVersion",
        ]);
        const full = versionCaptured?.stdout.trim().split(/\r?\n/)[0] ?? "";
        const major = full.split(".")[0];
        return { kind: "msvc", vcvars, version: major ? `VS ${major}` : undefined, label: "MSVC" };
      }
    }
  }
  // ② 默认安装目录扫描（vswhere 缺失或返回的安装里没装 C++ 组件时兜底）
  const knownVcVars = scanKnownVcVars();
  if (knownVcVars) return { kind: "msvc", vcvars: knownVcVars, label: "MSVC" };
  // ③ MinGW-w64 / LLVM-MinGW
  for (const name of ["g++", "clang++", "gcc"] as const) {
    const compiler = findOnPath([name]);
    if (!compiler) continue;
    const captured = await runCapture(compiler, ["--version"]);
    if (!captured) continue;
    const version = captured.stdout.split(/\r?\n/)[0]?.trim().slice(0, 120);
    return { kind: "mingw", compiler, version: version || undefined, label: name };
  }
  return null;
}

/** 同步（纯 fs，不起进程）探测：仅在「命令先于面板探测执行」时兜底。 */
function syncRuntime(): ProfileRuntime {
  if (syncCache && Date.now() - syncCache.at < CACHE_TTL_MS) return syncCache.runtime;
  const runtime: ProfileRuntime = {
    cmd: locateCmd(),
    powershell: locatePowerShell(),
    gitbash: locateGitBash(),
    python: locatePythonSync(),
    node: locateNode(),
    cpp: locateCppSync(),
  };
  syncCache = { at: Date.now(), runtime };
  return runtime;
}

function hasRuntimeFor(key: TerminalProfileKey, runtime: ProfileRuntime): boolean {
  switch (key) {
    case "cmd":
      return runtime.cmd !== null;
    case "powershell":
      return runtime.powershell !== null;
    case "gitbash":
      return runtime.gitbash !== null;
    case "python":
      return runtime.python !== null;
    case "node":
      return runtime.node !== null;
    case "cpp":
      return runtime.cpp !== null;
  }
}

function toInfo(key: TerminalProfileKey, runtime: ProfileRuntime): TerminalProfileInfo {
  const meta = PROFILE_META[key];
  const available = hasRuntimeFor(key, runtime);
  return {
    key,
    label: meta.label,
    description: meta.description,
    available,
    version: runtimeVersionOf(key, runtime),
    detail: available ? undefined : meta.installHint,
    kind: meta.kind,
  };
}

function runtimeVersionOf(key: TerminalProfileKey, runtime: ProfileRuntime): string | undefined {
  switch (key) {
    case "cmd":
      return runtime.cmd?.version;
    case "powershell":
      return runtime.powershell?.version;
    case "gitbash":
      return runtime.gitbash?.version;
    case "python":
      return runtime.python?.version;
    case "node":
      return runtime.node?.version;
    case "cpp":
      return runtime.cpp?.version ?? runtime.cpp?.label;
  }
}

function cloneInfos(infos: readonly TerminalProfileInfo[]): TerminalProfileInfo[] {
  return infos.map((info) => ({ ...info }));
}

/* ───────────────────────── 路径定位（fs only） ───────────────────────── */

function windowsRoot(): string {
  return process.env.SystemRoot || process.env.windir || "C:\\Windows";
}

function programFilesDirs(): string[] {
  const dirs = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], "C:\\Program Files", "C:\\Program Files (x86)"];
  return dirs.filter((dir): dir is string => typeof dir === "string" && dir.trim().length > 0);
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function firstExistingFile(candidates: readonly (string | null | undefined)[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.length === 0) continue;
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/** 在 PATH 中按命令名找可执行文件（win32 补 .exe/.cmd/.bat；纯 fs 判断，不起子进程）。 */
function findOnPath(names: readonly string[]): string | null {
  const rawPath = process.env.PATH ?? process.env.Path ?? "";
  const dirs = rawPath.split(path.delimiter).filter((dir) => dir.trim().length > 0);
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of dirs) {
    for (const name of names) {
      for (const ext of extensions) {
        const candidate = path.join(dir, `${name}${ext}`);
        if (isFile(candidate)) return candidate;
      }
    }
  }
  return null;
}

function locateCmd(): LocatedExe | null {
  if (process.platform !== "win32") return null;
  const found = firstExistingFile([
    process.env.ComSpec,
    path.join(windowsRoot(), "System32", "cmd.exe"),
    findOnPath(["cmd"]),
  ]);
  return found ? { path: found } : null;
}

function locatePowerShell(): LocatedExe | null {
  if (process.platform === "win32") {
    const found = firstExistingFile([
      path.join(windowsRoot(), "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      findOnPath(["powershell"]),
    ]);
    return found ? { path: found } : null;
  }
  // 非 Windows：仅当显式安装了 pwsh（PowerShell 7）
  const pwsh = findOnPath(["pwsh"]);
  return pwsh ? { path: pwsh } : null;
}

function locateGitBash(): LocatedExe | null {
  const candidates: (string | null)[] = [];
  for (const base of programFilesDirs()) candidates.push(path.join(base, "Git", "bin", "bash.exe"));
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) candidates.push(path.join(localAppData, "Programs", "Git", "bin", "bash.exe"));
  if (process.platform !== "win32") candidates.push(findOnPath(["bash"]));
  const onPath = process.platform === "win32" ? findOnPath(["bash"]) : null;
  // PATH 里的 bash 可能是 WSL 的 C:\Windows\System32\bash.exe（不是 Git Bash），必须路径含 git 才认
  if (onPath && /git/i.test(onPath)) candidates.push(onPath);
  const found = firstExistingFile(candidates);
  return found ? { path: found } : null;
}

function locatePythonSync(): PythonRuntime | null {
  const [first] = pythonCandidates();
  return first ?? null;
}

/** python 候选顺序：py 启动器 > PATH 的 python > 常见安装目录 > WindowsApps 别名（最后兜底但会被执行验证淘汰）。 */
function pythonCandidates(): PythonRuntime[] {
  const list: PythonRuntime[] = [];
  const pyLauncher = findOnPath(["py"]);
  if (pyLauncher) list.push({ path: pyLauncher, baseArgs: ["-3"] });
  const pythonOnPath = findOnPath(process.platform === "win32" ? ["python"] : ["python3", "python"]);
  if (pythonOnPath) list.push({ path: pythonOnPath, baseArgs: [] });
  for (const candidate of pythonInstallCandidates()) list.push({ path: candidate, baseArgs: [] });
  const seen = new Set<string>();
  return list.filter((item) => {
    const key = item.path.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pythonInstallCandidates(): string[] {
  const result: string[] = [];
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const programs = path.join(localAppData, "Programs", "Python");
    try {
      for (const entry of fs.readdirSync(programs)) {
        if (/^python3\d*/i.test(entry)) result.push(path.join(programs, entry, "python.exe"));
      }
    } catch {
      // 目录不存在：忽略
    }
  }
  for (const base of programFilesDirs()) {
    for (const dir of ["Python313", "Python312", "Python311", "Python310", "Python39"]) {
      result.push(path.join(base, dir, "python.exe"));
    }
  }
  return result;
}

function locateNode(): LocatedExe | null {
  // 不能回退 process.execPath：那是 Electron 本体，spawn 它会再拉起一个应用实例。
  const found = findOnPath(["node"]);
  return found ? { path: found } : null;
}

function locateVsWhere(): string | null {
  const candidates: (string | null)[] = [];
  for (const base of programFilesDirs()) {
    candidates.push(path.join(base, "Microsoft Visual Studio", "Installer", "vswhere.exe"));
  }
  return firstExistingFile(candidates);
}

/** 扫描 VS 2017/2019/2022 的默认安装目录，找 vcvars64.bat（vswhere 不可用时的同步兜底）。 */
function scanKnownVcVars(): string | null {
  const candidates: string[] = [];
  for (const base of programFilesDirs()) {
    for (const year of ["2022", "2019", "2017"]) {
      for (const edition of ["Enterprise", "Professional", "Community", "BuildTools"]) {
        const candidate = path.join(
          base,
          "Microsoft Visual Studio",
          year,
          edition,
          "VC",
          "Auxiliary",
          "Build",
          "vcvars64.bat",
        );
        if (isSafeCmdPath(candidate)) candidates.push(candidate);
      }
    }
  }
  return firstExistingFile(candidates);
}

function locateCppSync(): CppToolchain | null {
  const knownVcVars = scanKnownVcVars();
  if (knownVcVars) return { kind: "msvc", vcvars: knownVcVars, label: "MSVC" };
  for (const name of ["g++", "clang++", "gcc"] as const) {
    const compiler = findOnPath([name]);
    if (compiler) return { kind: "mingw", compiler, label: name };
  }
  return null;
}

/* ───────────────────────── 子进程探测（带超时，失败返回 null） ───────────────────────── */

interface CaptureResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * 跑一个短命令捕获输出做探测。
 * 返回 null 表示「文件不存在/不可执行」（ENOENT/EACCES）；命令存在但退出码非 0 时仍返回输出，
 * 让调用方自行判断（例如 WindowsApps 的 python 别名会打印「not found」并返回 9009）。
 */
function runCapture(file: string, args: string[], timeoutMs = 4000): Promise<CaptureResult | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        file,
        args,
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024, encoding: "utf8" },
        (error, stdout, stderr) => {
          const out = typeof stdout === "string" ? stdout : "";
          const err = typeof stderr === "string" ? stderr : "";
          if (!error) {
            resolve({ stdout: out, stderr: err, code: 0 });
            return;
          }
          const failure = error as NodeJS.ErrnoException & { killed?: boolean };
          if (failure.code === "ENOENT" || failure.code === "EACCES") {
            resolve(null);
            return;
          }
          resolve({ stdout: out, stderr: err, code: typeof failure.code === "number" ? failure.code : -1 });
        },
      );
    } catch {
      resolve(null);
    }
  });
}

function parseWindowsVersion(text: string): string | undefined {
  const match = /Version\s+([\d.]+)/i.exec(text);
  return match?.[1];
}
