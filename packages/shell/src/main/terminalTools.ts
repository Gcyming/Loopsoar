/**
 * 终端工具（Agent 的"命令行"）：按配置档一次性执行一条命令并返回输出。
 *
 * 与旧版的差异（为什么改）：
 *   · 旧版只支持 cmd/bash、不校验危险命令、cwd 不可控；现在所有命令先过
 *     hardRuleCheck + classifyCommand（fail-closed：命中直接拒绝，绝不 spawn）；
 *   · profile 选择解释器（python→py -3 -c、node→node -e、gitbash→bash -c、
 *     powershell→-Command、cmd→cmd /c、cpp→带工具链环境 shell）；
 *   · cwd 必须落在会话工作根内（与持久终端共用 resolveCwdWithin，含 symlink 解析）；
 *   · 环境变量白名单（不把宿主 API Key / LOOPSOAR_* 带进子进程）。
 *
 * 说明：仍不是"shell 自由会话"——单次命令、无交互 stdin（fail-closed）；
 * 需要保留状态/交互时用终端面板的持久会话（terminal:run）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { z } from "zod";
import type { ToolContext, ToolRegistry, ToolResult } from "loopsoar-core/tools/registry";
import { hardRuleCheck } from "loopsoar-core/tools/hard_rules";
import { classifyCommand } from "loopsoar-core/tools/classifier";
import { TERMINAL_TIMEOUT_MS } from "loopsoar-contracts/security-policy";
import { buildTerminalEnv, resolveProfile, type TerminalProfileKey, type TerminalSpawnSpec } from "./terminalProfiles.js";
import { resolveCwdWithin } from "./terminalSession.js";

/** 输出上限：模型上下文与工具卡都吃不下更多；超出只截断展示（进程继续跑到退出）。 */
const MAX_OUTPUT = 12_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

const TerminalToolSchema = z.object({
  command: z.string().min(1).max(8000),
  /** 解释器/工具链选择；不可用的档直接报错（fail-closed，不静默换解释器）。 */
  profile: z.enum(["cmd", "powershell", "gitbash", "python", "node", "cpp"]).optional(),
  /** 工作目录（相对=会话工作根，绝对=必须在其内）；缺省=会话工作根。 */
  cwd: z.string().max(1024).optional(),
  timeoutMs: z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS).optional(),
});

type TerminalToolParams = z.infer<typeof TerminalToolSchema>;

function defaultProfile(): TerminalProfileKey {
  // 项目以 Windows 为主目标；非 Windows 上 cmd 一定不可用，默认 Git Bash 更接近 Unix 习惯
  return process.platform === "win32" ? "cmd" : "gitbash";
}

function blockedResult(reason: string | undefined): ToolResult {
  return { ok: false, content: `[错误] 危险命令已拦截：${reason ?? "匹配危险规则"}` };
}

function clampTimeout(value: unknown): number {
  const raw = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : TERMINAL_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, raw));
}

/**
 * 杀进程树：Windows 用 taskkill /T /F。
 * 为什么不能只 kill 直接子进程：cmd/npx/uvx 类命令会派生孙进程并持有 stdout 管道，
 * 只杀父进程会留下孤儿进程、读取端永久挂起（见 docs/research 的教训）。
 */
function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) {
    try {
      child.kill("SIGKILL");
    } catch {
      // 已退出
    }
    return;
  }
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      // POSIX：detached spawn 已建独立进程组，负 pid 一次带走整棵树
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // 已退出
    }
  }
}

interface OneShotInput {
  spec: TerminalSpawnSpec;
  cwd: string;
  timeoutMs: number;
  profileKey: TerminalProfileKey;
  signal?: AbortSignal;
}

/** 一次性执行：单个子进程、无交互 stdin、超时/中止通过杀进程树兜底。 */
function runOneShot(input: OneShotInput): Promise<ToolResult> {
  return new Promise<ToolResult>((resolve) => {
    let output = "";
    let truncated = false;
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let child: ChildProcess | null = null;

    const finish = (result: ToolResult): void => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      input.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const append = (text: string): void => {
      if (!text) return;
      if (output.length >= MAX_OUTPUT) {
        truncated = true;
        return;
      }
      output += text;
      if (output.length > MAX_OUTPUT) {
        output = output.slice(0, MAX_OUTPUT);
        truncated = true;
      }
    };
    const onAbort = (): void => {
      if (child) killProcessTree(child);
      finish({ ok: false, content: `[已取消] 工具执行被中止\n\n${output}` });
    };

    if (input.signal?.aborted) {
      finish({ ok: false, content: "[已取消] 工具执行被中止" });
      return;
    }

    try {
      child = spawn(input.spec.command, input.spec.args, {
        cwd: input.cwd,
        env: { ...buildTerminalEnv(), ...(input.spec.env ?? {}) },
        stdio: ["ignore", "pipe", "pipe"], // 无交互 stdin：只读命令，不接受输入（fail-closed）
        windowsHide: true,
        // C++/MSVC 需要保留 call "C:\Program Files\..." 内的引号（见 TerminalSpawnSpec.verbatim）
        windowsVerbatimArguments: input.spec.verbatim === true,
        detached: process.platform !== "win32",
      });
    } catch (err) {
      finish({ ok: false, content: `[启动失败] ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    input.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => append(chunk));
    child.stderr?.on("data", (chunk: string) => append(chunk));
    child.on("error", (err: Error) => {
      finish({ ok: false, content: `[启动失败] ${err.message}` });
    });
    timer = setTimeout(() => {
      if (child) killProcessTree(child);
      const partial = output ? `\n\n${output}` : "";
      finish({
        ok: false,
        content: `[超时 ${input.timeoutMs}ms] 已终止命令（profile: ${input.profileKey}）${partial}`,
      });
    }, input.timeoutMs);
    child.on("exit", (code: number | null) => {
      if (settled) return;
      const clipped = truncated ? `${output}\n…（输出已截断）` : output;
      const suffix = `[退出码 ${code ?? "null"}]（cwd: ${input.cwd}，profile: ${input.profileKey}）`;
      finish({ ok: code === 0, content: `${clipped}${clipped ? "\n" : ""}${suffix}` });
    });
  });
}

export function registerTerminalTools(registry: ToolRegistry, workspaceRoot: (sessionId?: string) => string): void {
  registry.register({
    name: "terminal_run",
    description:
      "按指定配置档在工作区执行一条命令并返回输出（非交互；默认超时 30s；输出上限 12KB；危险命令会被拒绝）。profile 可选 cmd/powershell/gitbash/python/node/cpp。",
    permissions: { terminal: true },
    schema: TerminalToolSchema,
    execute: async (ctx: ToolContext): Promise<ToolResult> => {
      const params = (ctx.params ?? {}) as Partial<TerminalToolParams> & { command?: unknown };
      const command = typeof params.command === "string" ? params.command : "";
      if (!command.trim()) return { ok: false, content: "[错误] 缺少 command" };

      // ① 危险命令硬规则（与沙箱策略共用同一份规则，避免两处判定漂移）
      const hard = hardRuleCheck(command);
      if (hard.blocked) return blockedResult(hard.reason);
      // ② 安全分类器：未来规则扩展时分类器判 block 也拒绝（fail-closed）
      let verdict: "readonly" | "confirm" | "block";
      try {
        verdict = classifyCommand(command);
      } catch (err) {
        return {
          ok: false,
          content: `[错误] 命令安全分类失败（fail-closed）：${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (verdict === "block") return blockedResult(undefined);

      // ③ 配置档：未知/不可用都明确报错并给安装提示（绝不降级换解释器执行）
      const profileKey: TerminalProfileKey =
        typeof params.profile === "string" ? (params.profile as TerminalProfileKey) : defaultProfile();
      const profile = resolveProfile(profileKey);
      if (!profile) return { ok: false, content: `[错误] 未知终端配置档：${String(params.profile)}` };
      if (!profile.available) {
        return { ok: false, content: `[错误] 配置档「${profile.label}」不可用：${profile.detail ?? "未安装"}` };
      }

      // ④ cwd 限定会话工作根内：越界/不存在在 spawn 之前就拒绝
      let cwd: string;
      try {
        const root = workspaceRoot(ctx.sessionId) || process.cwd();
        cwd = resolveCwdWithin(root, typeof params.cwd === "string" ? params.cwd : undefined);
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }

      const spec = profile.buildOneShot(command);
      if (!spec) {
        return { ok: false, content: `[错误] 配置档「${profile.label}」无法构造一次性执行命令（fail-closed）` };
      }
      return runOneShot({
        spec,
        cwd,
        timeoutMs: clampTimeout(params.timeoutMs),
        profileKey: profile.key,
        signal: ctx.signal,
      });
    },
  });
}
