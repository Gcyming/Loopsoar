/**
 * 终端工具（Agent 的"命令行"）：在工作区执行一条命令并返回输出。
 *
 * 安全边界：
 *   · 权限声明 { terminal: true } → 默认每次确认（设置·权限可改）；
 *   · 工作目录固定为工作区根（不提供任意 cwd，避免逃逸）；
 *   · 30s 超时 + 输出上限 12KB；Windows 用 taskkill /T /F 清理子进程树。
 * 说明：这不是"shell 自由会话"，单次命令、无交互 stdin（fail-closed）。
 */
import { spawn } from "node:child_process";
import { z } from "zod";
import type { ToolRegistry, ToolResult } from "loopsoar-core/tools/registry";

const MAX_OUTPUT = 12_000;
const DEFAULT_TIMEOUT = 30_000;

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // 进程已退出
  }
}

export function registerTerminalTools(registry: ToolRegistry, workspaceRoot: (sessionId?: string) => string): void {
  registry.register({
    name: "terminal_run",
    description: "在工作区执行一条命令行命令并返回输出（非交互；超时 30s；输出上限 12KB）",
    permissions: { terminal: true },
    schema: z.object({
      command: z.string().min(1).max(4000),
      timeoutMs: z.number().int().min(1000).max(120_000).optional(),
    }),
    execute: async (ctx): Promise<ToolResult> => {
      const params = (ctx.params ?? {}) as { command?: string; timeoutMs?: number };
      if (!params.command?.trim()) return { ok: false, content: "[错误] 缺少 command" };
      const cwd = workspaceRoot(ctx.sessionId) || process.cwd();
      const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT;
      const isWin = process.platform === "win32";
      return await new Promise<ToolResult>((resolve) => {
        const child = isWin
          ? spawn("cmd.exe", ["/d", "/s", "/c", params.command!], { cwd, windowsHide: true })
          : spawn("/bin/bash", ["-lc", params.command!], { cwd, detached: true });
        let output = "";
        let settled = false;
        const finish = (result: ToolResult): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        const timer = setTimeout(() => {
          killTree(child.pid);
          finish({ ok: false, content: `[超时 ${timeoutMs}ms] 已终止命令\n\n${output.slice(0, MAX_OUTPUT)}` });
        }, timeoutMs);
        const append = (chunk: Buffer): void => {
          if (output.length < MAX_OUTPUT * 2) output += chunk.toString("utf8");
        };
        child.stdout?.on("data", append);
        child.stderr?.on("data", append);
        child.on("error", (err) => finish({ ok: false, content: `[启动失败] ${err.message}` }));
        child.on("exit", (code) => {
          const clipped = output.length > MAX_OUTPUT ? `${output.slice(0, MAX_OUTPUT)}\n…（输出已截断）` : output;
          finish({
            ok: code === 0,
            content: `${clipped}${clipped ? "\n" : ""}[退出码 ${code ?? "null"}]（cwd: ${cwd}）`,
          });
        });
      });
    },
  });
}
