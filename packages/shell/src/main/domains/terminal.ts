/**
 * terminal 域：持久终端会话的 8 个受信 IPC 通道。
 *
 * 设计原则：
 *   · 参数校验只在契约层（handleTrusted 按 CHANNEL_BINDINGS 的 zod schema 校验），域层不重复定义
 *     schema，避免「契约改了域没改」的双产地漂移；
 *   · 这里只做转发：返回结构与 TerminalSessionManager 方法一一对应（monitor 见 terminalSession.ts）；
 *   · open 的失败语义是 reject（未知配置档/超限/不可用/cwd 越界/启动失败），由渲染层 try/catch
 *     展示中文错误；其余通道用 { ok, error? } / boolean / null 表达业务失败，不抛跨进程异常。
 */
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";
import { diagnoseTerminalEnvironment } from "../terminalDiagnostics.js";
import type { TerminalProfileKey } from "../terminalProfiles.js";
import type { TerminalSessionManager } from "../terminalSession.js";

export function registerTerminalDomain(deps: TrustedIpcDeps, manager: TerminalSessionManager): void {
  // 可用配置档探测（60s 缓存；不可用的档带安装提示）
  handleTrusted(deps, "terminal:profiles", () => manager.profiles());

  // 设置页「终端环境」自检：配置档 + 常见 CLI 依赖（只读探测）。
  handleTrusted(deps, "terminal:diagnose", () => diagnoseTerminalEnvironment());

  // 终端列表（含 exited 未 close 的回放条目；UI 据此恢复标签页）
  handleTrusted(deps, "terminal:list", () => manager.list());

  // 打开终端：成功返回 TerminalSessionInfo，失败 reject（UI 用 try/catch）
  handleTrusted(deps, "terminal:open", (payload) => {
    const input = (payload ?? {}) as { sessionId?: string; profile: TerminalProfileKey; cwd?: string };
    return manager.open({
      sessionId: input.sessionId,
      profile: input.profile,
      cwd: input.cwd,
    });
  });

  // 原始输入（按键流/整行）；含换行的完整命令行走 hardRuleCheck
  handleTrusted(deps, "terminal:input", (payload) => {
    const input = payload as { terminalId: string; data: string };
    return manager.input(input.terminalId, input.data);
  });

  // 在持久会话里执行一整行命令
  handleTrusted(deps, "terminal:run", (payload) => {
    const input = payload as { terminalId: string; command: string };
    return manager.run(input.terminalId, input.command);
  });

  // 中断当前命令（Ctrl+C）
  handleTrusted(deps, "terminal:interrupt", (payload) => {
    return manager.interrupt((payload as { terminalId: string }).terminalId);
  });

  // 关闭终端（幂等）
  handleTrusted(deps, "terminal:close", (payload) => {
    return manager.close((payload as { terminalId: string }).terminalId);
  });

  // 回放缓冲（重开面板/切回终端时恢复输出）
  handleTrusted(deps, "terminal:history", (payload) => {
    return manager.history((payload as { terminalId: string }).terminalId);
  });
}
