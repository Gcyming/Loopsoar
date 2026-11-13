/**
 * 终端环境自检：给「设置 · 终端环境」提供依赖探测。
 *
 * 目的：用户要求 Loopsoar 的终端能明确报告「系统里哪些终端/解释器/工具链存在、版本、
 * 是否能为终端所用」。这里复用 terminalProfiles 的探测（与持久终端/一次性工具同一份
 * 解释器路径与 spawn 规格），额外诊断 git/node/npm/pnpm/python/rg 等常见 CLI。
 *
 * 约束：
 *   · 只做只读探测（--version 类命令），命令在白名单里硬编码，不接受任意输入；
 *   · 超时 5s、失败归一为 available:false + 原因，不抛错；
 *   · 子进程环境用 buildTerminalEnv 白名单，不把宿主密钥带进去；
 *   · Windows 上 npm/pnpm 实际是可执行脚本 `npm.cmd`/`pnpm.cmd` —— execFile 不做 PATHEXT
 *     解析，必须显式给候选命令，否则明明装了也会显示缺失（用户会以为终端坏了）。
 */
import { execFile } from "node:child_process";
import os from "node:os";
import { buildTerminalEnv, detectTerminalProfiles, type TerminalProfileInfo } from "./terminalProfiles.js";

export interface TerminalToolCheck {
  key: string;
  label: string;
  category: "shell" | "runtime" | "tool" | "vcs";
  command: string;
  available: boolean;
  version?: string;
  path?: string;
  detail?: string;
  /** 不可用时的安装建议。 */
  installHint?: string;
}

export interface TerminalDiagnostics {
  platform: string;
  arch: string;
  release: string;
  /** 系统默认 shell（COMSPEC / SHELL）。 */
  defaultShell: string;
  /** Loopsoar 终端配置档（与终端面板同一份探测结果）。 */
  profiles: TerminalProfileInfo[];
  /** 常见 CLI 依赖。 */
  tools: TerminalToolCheck[];
  /** 是否有可用的 shell（只要能开一个持久终端就算可用）。 */
  ready: boolean;
  checkedAt: number;
}

interface CandidateCommand {
  command: string;
  args: string[];
}

const TOOL_DEFS: Array<{
  key: string;
  label: string;
  category: TerminalToolCheck["category"];
  candidates: CandidateCommand[];
  installHint: string;
}> = [
  {
    key: "git",
    label: "Git",
    category: "vcs",
    candidates: [{ command: "git", args: ["--version"] }],
    installHint: "安装 Git for Windows：https://git-scm.com/download/win",
  },
  {
    key: "node",
    label: "Node.js",
    category: "runtime",
    candidates: [{ command: "node", args: ["--version"] }],
    installHint: "安装 Node.js（系统 PATH，不依赖应用内置 Electron Node）：https://nodejs.org",
  },
  {
    key: "npm",
    label: "npm",
    category: "runtime",
    candidates: [
      { command: "npm.cmd", args: ["--version"] },
      { command: "npm", args: ["--version"] },
    ],
    installHint: "随 Node.js 安装 npm；若使用 pnpm 可忽略。",
  },
  {
    key: "pnpm",
    label: "pnpm",
    category: "runtime",
    candidates: [
      { command: "pnpm.cmd", args: ["--version"] },
      { command: "pnpm", args: ["--version"] },
    ],
    installHint: "npm i -g pnpm 或 corepack enable pnpm",
  },
  {
    key: "python",
    label: "Python",
    category: "runtime",
    candidates: [
      { command: "py", args: ["-3", "--version"] },
      { command: "python", args: ["--version"] },
      { command: "python3", args: ["--version"] },
    ],
    installHint: "安装 Python 3 并加入 PATH：https://www.python.org/downloads/",
  },
  {
    key: "rg",
    label: "ripgrep",
    category: "tool",
    candidates: [{ command: "rg", args: ["--version"] }],
    installHint: "安装 ripgrep：winget install BurntSushi.ripgrep.MSVC",
  },
  {
    key: "curl",
    label: "curl",
    category: "tool",
    candidates: [
      { command: "curl.exe", args: ["--version"] },
      { command: "curl", args: ["--version"] },
    ],
    installHint: "Windows 10/11 自带 curl；或用 winget install curl.curl",
  },
];

function runVersion(command: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    try {
      execFile(
        command,
        args,
        {
          env: buildTerminalEnv({}),
          timeout: 5000,
          // Windows 上 npm/pnpm 是 .cmd 脚本：CreateProcess 不能直接执行，需经 shell 解析（命令白名单硬编码）。
          shell: process.platform === "win32",
          windowsHide: true,
          maxBuffer: 1024 * 1024,
        },
        (error, stdout, stderr) => {
          const output = `${stdout ?? ""}${stderr ?? ""}`.trim();
          resolve({ ok: !error, output });
        },
      );
    } catch {
      resolve({ ok: false, output: "" });
    }
  });
}

function firstLine(text: string, max = 120): string {
  return text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim().slice(0, max) ?? "";
}

/** 诊断终端环境（5s 超时；不抛错）。 */
export async function diagnoseTerminalEnvironment(): Promise<TerminalDiagnostics> {
  const profiles = await detectTerminalProfiles();
  const tools: TerminalToolCheck[] = [];
  for (const def of TOOL_DEFS) {
    let hit: { command: string; output: string } | null = null;
    for (const candidate of def.candidates) {
      const result = await runVersion(candidate.command, candidate.args);
      if (result.ok) {
        hit = { command: candidate.command, output: result.output };
        break;
      }
    }
    tools.push({
      key: def.key,
      label: def.label,
      category: def.category,
      command: hit?.command ?? def.candidates[0]?.command ?? def.key,
      available: Boolean(hit),
      version: hit ? firstLine(hit.output) : undefined,
      detail: hit ? undefined : "命令未找到或无法执行",
      installHint: def.installHint,
    });
  }
  const shells = profiles.filter((profile) => profile.kind === "shell" && profile.available);
  return {
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    defaultShell: process.platform === "win32" ? process.env.COMSPEC ?? "cmd.exe" : process.env.SHELL ?? "/bin/sh",
    profiles,
    tools,
    ready: shells.length > 0,
    checkedAt: Date.now(),
  };
}
