/* 终端类型（持久多环境终端 / 应用内终端面板）。
 *
 * 从 types.d.ts 拆出：这段是终端通道的完整类型面（配置档、实例、事件负载），
 * 与浏览器/会话类型没有交叉引用；types.d.ts 受 1400 行预算约束，主 API 面留在那里。
 */
/* ── 终端（持久多环境终端；P0 应用内终端面板） ── */

/** 终端配置档：不同解释器 / 工具链环境（与 contracts 的 TerminalProfileKeySchema 对齐）。 */
export type TerminalProfileKey = "cmd" | "powershell" | "gitbash" | "python" | "node" | "cpp";

/** 配置档种类（shell 环境 / 解释器 REPL / 编译器工具链）。 */
export type TerminalProfileKind = "shell" | "interpreter" | "toolchain";

/** 配置档能力信息（探测结果）：不可用项 UI 禁用并显示 detail（安装提示）。 */
export interface TerminalProfileInfo {
  key: TerminalProfileKey;
  label: string;
  description: string;
  available: boolean;
  /** 探测到的版本号（如 "Python 3.12.4"），不可用时可能缺省。 */
  version?: string;
  /** 不可用原因 / 安装指引 / 额外说明（tooltip 展示）。 */
  detail?: string;
  kind: TerminalProfileKind;
}

/** 终端实例状态：进程退出后条目保留（exited，可回放/关闭），close 后才从列表移除。 */
export type TerminalSessionState = "starting" | "ready" | "exited" | "error";

/** 一个持久终端实例（主进程签发 terminalId）。 */
export interface TerminalSessionInfo {
  terminalId: string;
  sessionId: string;
  profile: TerminalProfileKey;
  cwd: string;
  state: TerminalSessionState;
  createdAt: number;
  /** 标签标题（shell 侧生成）。 */
  label: string;
}

/** 终端回放缓冲（切换标签 / 重开面板时恢复输出；主进程环形缓冲上限 512KB）。 */
export interface TerminalHistoryResult {
  terminalId: string;
  profile: string;
  state: string;
  /** 原始输出（含 ANSI 转义与 \r；UI 需 stripAnsi + 规范化）。 */
  data: string;
}

/** 终端操作通用返回（run / input）。 */
export interface TerminalActionResult {
  ok: boolean;
  error?: string;
}

/** terminal:data 事件负载：增量输出（stdout+stderr 合流、主进程 30ms 批处理）。 */
export interface TerminalDataPayload {
  terminalId: string;
  data: string;
}

/** terminal:exit 事件负载：子进程退出（code=null 表示被信号终止）。 */
export interface TerminalExitPayload {
  terminalId: string;
  code: number | null;
  signal?: string;
}

/** terminal:state 事件负载：终端状态迁移（可能携带 cwd/label 更新）。 */
export interface TerminalStatePayload {
  terminalId: string;
  state: TerminalSessionState;
  cwd?: string;
  label?: string;
  error?: string;
}
