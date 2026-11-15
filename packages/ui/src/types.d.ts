// window.loopsoarAPI 声明文件（与 shell preload 白名单对齐）。
// 只声明 UI 真正消费的域方法；事件白名单与 contracts 的 EVENTS 保持一致。
//
// 偏好类型直接消费契约推断类型（唯一产地 packages/contracts/src/schemas.ts）：
// 不再手写第二份 interface —— 契约新增字段而 UI 类型不更新时，设置页读不到该字段，
// 而壳层 zod safeParse 会 strip 未知键、静默落回默认值，这类漂移必须由编译期消灭。
import type { PreferencesData } from "loopsoar-contracts/schemas";

export interface LoopsoarDomain {
  [method: string]: (...args: unknown[]) => Promise<unknown>;
}

export interface ProviderStatus {
  id?: string;
  configured: boolean;
  provider: string | null;
  baseUrl: string | null;
  model: string | null;
  hasApiKey: boolean;
  usable: boolean;
  reason: string | null;
  keyHint?: string | null;
  keySource?: "stored" | "env" | null;
  storageMode?: "os" | "degraded" | "unavailable";
  apiFormat?: "auto" | "openai" | "anthropic";
  rpm?: number | null;
  models?: ProviderModel[];
}

export interface TestProviderResult {
  ok: boolean;
  status?: number;
  latencyMs?: number;
  message: string;
}

export interface AgentSummary {
  id: string;
  name: string;
  role: string;
  description: string | null;
  builtin: boolean;
  loopId: string | null;
  toolCount: number | null;
  isDefault: boolean;
}

export interface BootStatus {
  status: string;
  version?: string;
}

/**
 * 通用偏好：契约 schema 的推断类型（单源）。
 * 字段增删只改 packages/contracts/src/schemas.ts 的 PreferencesSchema，UI 自动跟随；
 * 本文件不再保留手写字段表，避免「契约有、UI 没有」导致设置页静默丢字段。
 */
export type Preferences = PreferencesData;

export interface PermissionCategory {
  key: "read" | "write" | "terminal" | "network" | "browser";
  label: string;
  description: string;
}

export interface PermissionsState {
  permissions: {
    read: "allow" | "confirm" | "deny";
    write: "allow" | "confirm" | "deny";
    terminal: "allow" | "confirm" | "deny";
    network: "allow" | "confirm" | "deny";
    /** 浏览器操作（Agent 操控内嵌浏览器）；登录/支付/不可撤销动作仍逐次确认，不受此项影响。 */
    browser: "allow" | "confirm" | "deny";
    workspaceRoots: string[];
    confirmDangerousAlways: boolean;
  };
  categories: PermissionCategory[];
  workspaceRoot: string;
}

export interface RuleEntry {
  id: string;
  name: string;
  scope: "global" | "workspace";
  enabled: boolean;
  path: string;
  bytes: number;
  content: string;
}

export interface RulesSnapshot {
  maxFileBytes: number;
  maxTotalBytes: number;
  entries: RuleEntry[];
  merged: {
    text: string;
    included: { scope: string; path: string; bytes: number }[];
    skipped: { path: string; reason: string }[];
    totalBytes: number;
  };
  claudeCompat: boolean;
  guardrail: string;
}

export interface MemoryFactView {
  id: string;
  content: string;
  category: string;
  tags: string[];
  importance: number;
  source: string;
  layer: string;
  repeated: number;
  confidence: number;
  links: string[];
  updatedAt: number;
}

export interface MemoryStats {
  total: number;
  active: number;
  archived: number;
  links: number;
  totalAccess: number;
  byCategory: Record<string, number>;
}

export interface MemoryListResult {
  facts: MemoryFactView[];
  archivedCount: number;
  stats: MemoryStats;
  filePath: string;
}

export interface LocationsInfo {
  dataDir: string;
  configDir: string;
  rulesDir: string;
  sessionsFile: string;
  defaultMemoryFile: string;
  workspaceRoot: string;
}

export interface DiagnosticsInfo {
  paths: Record<string, string>;
  versions: Record<string, string>;
  extra?: Record<string, unknown>;
}

export interface AboutInfo {
  name: string;
  version: string;
  appId: string;
  protocol: string;
  electron: string;
  node: string;
  brandAssetSource: string;
  license: string;
}

export interface TabState {
  id: string;
  url: string;
  title: string;
  active: boolean;
  canBack: boolean;
  canForward: boolean;
  /** 主框架加载中：原生视图隐藏，BrowserSurface 显示加载页。 */
  loading?: boolean;
  /** 站点图标（data: URL；来自主进程 page-favicon-updated）。 */
  favicon?: string;
  /** Agent 打开或导航过：UI 把它折叠进「Agent 工作区」而不是普通标签条。 */
  agentBound?: boolean;
  /** 最近一次主框架加载失败（已过滤 ERR_ABORTED）。 */
  loadFailure?: {
    code: number;
    description: string;
    url: string;
    isMainFrame?: boolean;
  } | null;
}

/** 全局历史条目（所有标签/会话共享；旧字段 index/current 仅向后兼容保留）。 */
export interface HistoryEntry {
  url: string;
  title?: string;
  /** 站点图标（data: URL；来自主进程抓取）。 */
  favicon?: string;
  visitedAt?: number;
  visitCount?: number;
  index?: number;
  current?: boolean;
}

/** 浏览器扩展（Chrome/Edge 系，Electron 支持子集）。 */
export interface BrowserExtensionInfo {
  id: string;
  name: string;
  version: string;
  manifestVersion: number;
  description?: string;
  source: "store" | "folder" | "bundled";
  dir: string;
  enabled: boolean;
  error?: string;
}

/** 终端环境自检里的单项 CLI 依赖。 */
export interface TerminalToolCheck {
  key: string;
  label: string;
  category: "shell" | "runtime" | "tool" | "vcs";
  command: string;
  available: boolean;
  version?: string;
  path?: string;
  detail?: string;
  installHint?: string;
}

/** 设置页「终端环境」自检结果。 */
export interface TerminalDiagnostics {
  platform: string;
  arch: string;
  release: string;
  defaultShell: string;
  profiles: TerminalProfileInfo[];
  tools: TerminalToolCheck[];
  ready: boolean;
  checkedAt: number;
}

export interface DownloadItem {
  id: string;
  filename: string;
  savePath: string;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  received: number;
  total: number;
  startedAt: number;
}

export interface SessionMeta {
  id: string;
  title: string;
  updatedAt: number;
  preview: string;
  messageCount: number;
  /** 会话归属的工作区（旧会话可能没有）。 */
  workspaceId?: string | null;
  /** 会话级「浏览器控制」开关（缺省 = 关闭）；消息列表/当前会话查询据此水合。 */
  browserControl?: boolean;
  /** 浏览器任务会话（Agent 工作区）：列表专属标记。 */
  task?: boolean;
  /** 分支来源（列表「分支」标记）。 */
  forkedFrom?: { sessionId: string; keepCount: number; at: number };
}

export interface WorkspaceRecord {
  id: string;
  name: string;
  root: string;
  createdAt: number;
  lastUsedAt: number;
}

export interface WorkspaceGitStatus {
  isRepo: boolean;
  root: string | null;
  branch: string | null;
  head: string | null;
  dirty: boolean;
  changedFiles: number;
}

export interface SessionWorktree {
  path: string;
  branch: string;
  baseBranch: string;
  repoRoot: string;
  createdAt: number;
}

export interface WorktreeFileChange {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked" | "unknown";
  additions: number;
  deletions: number;
}

export interface WorktreeDiff {
  branch: string;
  baseBranch: string;
  files: WorktreeFileChange[];
  commits: { hash: string; subject: string }[];
  dirty: boolean;
  ahead: number;
}

export interface WorkspaceStatusResult {
  ok: boolean;
  workspace?: WorkspaceRecord;
  git?: WorkspaceGitStatus;
  sessions?: { id: string; title: string; updatedAt: number }[];
  worktrees?: { sessionId: string; title: string; worktree: SessionWorktree | null }[];
  activeId?: string | null;
  error?: string;
}

export interface ProviderModel {
  id: string;
  selected?: boolean;
  contextWindow?: number;
  maxOutput?: number;
  vision?: boolean;
  thinking?: boolean;
  thinkingEfforts?: string[];
  /** 输入模态（模型卡/上游元数据）：text/image/audio/video。 */
  inputModalities?: Array<"text" | "image" | "audio" | "video">;
  /** 是否支持函数/工具调用。 */
  functionCalling?: boolean;
  /** 是否支持结构化输出（JSON Schema / response_format）。 */
  structuredOutput?: boolean;
}

export interface ProviderItem {
  id: string;
  provider: string;
  baseUrl: string;
  model: string;
  apiFormat?: "auto" | "openai" | "anthropic";
  rpm?: number;
  /** 自定义请求头（随供应商配置持久化）。 */
  headers?: Record<string, string>;
  models?: ProviderModel[];
  hasKey?: boolean;
  keyHint?: string | null;
  keySource?: "stored" | "env" | null;
}

export interface SkillRecord {
  id: string;
  path: string;
  frontmatter: { name: string; description: string; whenToUse?: string; version?: string; tags?: string[] };
  body: string;
  bytes: number;
  enabled: boolean;
  warnings?: string[];
}

export interface ExtensionRuntimeStatus {
  state: "idle" | "starting" | "ready" | "error";
  tools: string[];
  error?: string;
}

export interface McpServerInfo {
  id: string;
  name: string;
  transport?: "stdio" | "http";
  command: string;
  args: string[];
  url?: string;
  enabled: boolean;
  state: "idle" | "connecting" | "ready" | "error";
  tools: string[];
  capabilities: string[];
  stderr: string[];
  error?: string;
}

export interface SkillRecord {
  id: string;
  path: string;
  frontmatter: { name: string; description: string; whenToUse?: string; version?: string; tags?: string[] };
  body: string;
  bytes: number;
  enabled: boolean;
  warnings?: string[];
}

export interface ExtensionRuntimeStatus {
  state: "idle" | "starting" | "ready" | "error";
  tools: string[];
  error?: string;
}

export interface McpServerInfo {
  id: string;
  name: string;
  transport?: "stdio" | "http";
  command: string;
  args: string[];
  url?: string;
  enabled: boolean;
  state: "idle" | "connecting" | "ready" | "error";
  tools: string[];
  capabilities: string[];
  stderr: string[];
  error?: string;
}

export interface InstalledExtension {
  manifest: {
    id: string;
    name: string;
    version: string;
    description?: string;
    author?: string;
    /** 入口文件（相对扩展目录）；为空表示纯声明式扩展 */
    main?: string;
    permissions?: string[];
  };
  dir: string;
  enabled: boolean;
  installedAt: number;
}

export interface ChatHistoryMessage {
  role: "user" | "assistant";
  text: string;
  ts: number;
  /** 思考时间线（持久化恢复用） */
  timeline?: unknown[];
  /** 生成本条回复的供应商/模型（历史消息按各自记录展示）。 */
  provider?: string;
  model?: string;
}

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

/* ── 询问用户（ask_user 工具弹窗） ── */

/** ask:user 事件负载（工具挂起等人回答；渲染层弹窗）。 */
export interface AskUserRequest {
  requestId: string;
  question: string;
  /** 可选项（最多 8 个；点选即回答）。 */
  options?: string[];
  /** 是否允许自由文本（缺省语义：无选项时允许）。 */
  allowFreeText?: boolean;
}

/** ask:respond 返回：是否命中等待中的问题（重复/过期 = false）。 */
export interface AskRespondResult {
  received: boolean;
}

/* ── Agent-Loop（ADR-0010：内置 loop + 安全回退 + 选择） ── */

/** 一个可运行的 Agent 执行循环（builtin 不可删除、不可原位修改）。 */
export interface LoopInfo {
  id: string;
  name: string;
  builtin: boolean;
  /** 是否为当前活动 loop。 */
  active: boolean;
  /** 三档 loop 类型（builtin / 声明式 / 脚本）；旧后端可缺省。 */
  kind?: "builtin" | "declarative" | "script" | "custom";
  /** 定义是否可用（坏 JSON / 脚本缺失时 false，UI 应灰显）。 */
  valid?: boolean;
  error?: string;
  description?: string;
}

/** 安全回退记录（自定义 loop 失败 → 用同一 ctx 回退 builtin）。 */
export interface LoopFallbackRecord {
  reason: string;
  at: number;
}

/** loop:list 返回：可选 loop 列表 + 当前选择 + 回退历史。 */
/** /compact 结果。 */
export interface CompactResult {
  ok: boolean;
  before: { messages: number; chars: number };
  after: { messages: number; chars: number };
  dropped: number;
  savedRatio: number;
  applied: boolean;
  /** 是否真的超出预算（false 时 apply 也幂等无副作用）。 */
  compressed?: boolean;
  sessionId?: string;
  /** 压缩摘要正文（apply 时写入会话）。 */
  summary?: string;
  /** 预览条目（apply=false 时最多 24 条）。 */
  preview?: Array<{ role?: string; text: string }>;
  error?: string;
}

export interface LoopListResult {
  loops: LoopInfo[];
  activeId: string | null;
  fallbacks: LoopFallbackRecord[];
}

/** loop:setActive 返回（失败带中文原因；成功时同时带最新列表，省一次 loop:list 往返）。 */
export interface LoopSetActiveResult {
  ok: boolean;
  error?: string;
  activeId?: string | null;
  /** 成功时返回的最新 loop 列表（与 loop:list 同构字段）。 */
  loops?: LoopInfo[];
  fallbacks?: LoopFallbackRecord[];
}

/** loop:changed 事件负载：活动 loop 变更（可能携带最新列表）。 */
export interface LoopChangedPayload {
  activeId: string | null;
  loops?: LoopInfo[];
}

/** loop:fallback 事件负载：安全回退（界面必须显著提示）。 */
export interface LoopFallbackPayload {
  reason: string;
  at?: number;
}

/* ── 书签（浏览器功能面） ── */

/** 一条书签（URL 已由主进程规范化并去重）。 */
export interface BookmarkItem {
  id: string;
  url: string;
  title: string;
  createdAt: number;
}

/** bookmarks:add 返回：duplicate=true 表示该 URL 已存在（返回已有项）。 */
export interface BookmarkAddResult {
  ok: boolean;
  bookmark?: BookmarkItem;
  error?: string;
  duplicate?: boolean;
}

/* ── 页面快照（可读正文 + 可交互元素） ── */

/** 快照里的一个可交互元素（来自注入脚本的 DOM 扫描）。 */
export interface BrowserSnapshotElement {
  /** 元素编号（点击/输入工具的目标）。 */
  id?: string;
  tag?: string;
  type?: string;
  text?: string;
  href?: string;
}

/** browser:snapshot 返回（ok=false 时为 error）。 */
export interface BrowserSnapshotResult {
  ok: boolean;
  url?: string;
  title?: string;
  text?: string;
  /** 可交互元素列表（WebContentsView 后端返回 elements）。 */
  elements?: BrowserSnapshotElement[];
  /** 兼容可能的新字段名（与 elements 同构）。 */
  interactive?: BrowserSnapshotElement[];
  error?: string;
}

/** browser:savePage 返回：保存到下载目录 saved-pages/ 的 HTML 全页。 */
export interface SavePageResult {
  ok: boolean;
  path?: string;
  title?: string;
  bytes?: number;
  error?: string;
}

export type LoopsoarEvent =
  | "chat:stream:chunk"
  | "chat:stream:reasoning"
  | "chat:stream:tool"
  | "chat:stream:tool_start"
  | "chat:stream:progress"
  | "chat:stream:done"
  | "chat:stream:error"
  | "chat:stream:heartbeat"
  | "chat:steer:applied"
  | "perm:request"
  | "boot:ready"
  | "browser:tabs"
  | "chat:taskForked"
  | "browser:downloads"
  | "extensions:updated"
  | "skills:updated"
  | "mcp:updated"
  | "skills:updated"
  | "mcp:updated"
  | "memory:updated"
  | "terminal:data"
  | "terminal:exit"
  | "terminal:state"
  | "ask:user"
  | "loop:changed"
  | "loop:fallback"
  | "chrome:popoverAction"
  | "chrome:popoverClosed"
  | "chrome:dismissPopovers"
  | "chrome:agentWindowClosed"
  | "chrome:devToolsPanel"
  | "chrome:agentWindowIconMode"
  | "chrome:agentWindowTransition"
  /** Agent 首次打开网页前的会话窗口布局安排（{ mode: "docked" | "agentWindow"; sessionId?; reason? }）。 */
  | "chrome:applyLayout"
  /** Agent 浏览器活动（{ sessionId?, tool, phase }）：当前会话显示呼吸灯，并切到操作中的标签。 */
  | "chrome:agentActivity"
  | "chat:compacted";

/** 浏览器工具栏浮层种类（与契约 PopoverKindSchema 对齐）。 */
export type ChromePopoverKind = "more" | "bookmarks" | "history" | "downloads" | "workspaces" | "workspace";

/** 浏览器管理整页种类（更多菜单「查看更多」/设置打开）。 */
export type ChromePageKind = "history" | "downloads" | "bookmarks" | "settings";

/** 界面主题。 */
export type ThemeMode = "soft" | "classic";

/** 右侧会话栏模式：常驻 / 收起 / 小窗浮动。 */
export type SidebarMode = "docked" | "collapsed" | "float";

export interface LoopsoarAPI {
  chat: LoopsoarDomain & {
    stream(payload: {
      message: string;
      sessionId?: string;
      mode?: "build" | "plan";
      reasoningEffort?: string;
    }): Promise<{ accepted: boolean; sessionId: string }>;
    stop(payload: { sessionId?: string }): Promise<{ stopped: boolean }>;
    rollback(payload: { keepCount: number; sessionId?: string }): Promise<{ ok: boolean; session: unknown }>;
    /** 从源会话第 keepCount 条消息处分支：复制前缀到新会话并切过去（不继承运行态/浏览器任务）。 */
    forkSession(payload: { sessionId?: string; keepCount: number; title?: string }): Promise<{
      ok: boolean;
      session: { sessionId: string; messages: ChatHistoryMessage[] } | null;
      sessions: SessionMeta[];
      currentId: string | null;
    }>;
    /** 投递一条「待发指令」（运行中插入）：accepted=false 时看 reason（no-running/full/empty/duplicate）。 */
    steer(payload: { message: string; sessionId?: string; steerId?: string }): Promise<{
      accepted: boolean;
      steerId: string;
      reason?: "no-running" | "full" | "empty" | "duplicate";
    }>;
    /** 撤销尚未注入的待发指令（取出主进程 steer 缓冲区里的同 id 条目）。 */
    steerCancel(payload: { steerId: string; sessionId?: string }): Promise<{ cancelled: boolean }>;
    history(): Promise<{ session: { sessionId: string; updatedAt: number; messages: ChatHistoryMessage[] } | null }>;
    saveTimeline(payload: { sessionId?: string; timeline: unknown[] }): Promise<{ ok: boolean }>;
    sessions(): Promise<{ sessions: SessionMeta[]; currentId: string | null }>;
    newSession(payload?: { workspaceId?: string | null }): Promise<{ session: { sessionId: string } | null; sessions: SessionMeta[]; currentId: string | null }>;
    switchSession(payload: { sessionId: string }): Promise<{ ok: boolean; session: { sessionId: string; messages: ChatHistoryMessage[] } | null }>;
    deleteSession(payload: { sessionId: string }): Promise<{ removed: boolean; sessions: SessionMeta[]; currentId: string | null }>;
    /** /compact：压缩会话历史（apply=false 只预览统计；apply=true 写回持久化）。 */
    compact(payload?: { sessionId?: string; apply?: boolean }): Promise<CompactResult>;
    /**
     * 会话级「浏览器控制」开关（功能1）：
     * 关闭（默认）时 browser_* 工具对模型不可见、也不可执行；开启后按原权限/确认流可用。
     */
    setBrowserControl(payload: { sessionId: string; enabled: boolean }): Promise<{ ok: boolean }>;
  };
  perm: LoopsoarDomain;
  ask: LoopsoarDomain & {
    /** 回答/取消挂起中的 ask_user 问题；received=false 表示问题已过期或会话已结束。 */
    respond(payload: { requestId: string; answer?: string; cancelled?: boolean }): Promise<AskRespondResult>;
  };
  /** 浏览器工具栏浮层（独立子窗口渲染）。 */
  ui: LoopsoarDomain & {
    openPopover(payload: { kind: ChromePopoverKind; anchor: { x: number; y: number; width: number; height: number }; lang?: "zh-CN" | "en-US" }): Promise<{ ok: boolean; error?: string }>;
    /** 原子开关：已打开 → 关闭（open:false），否则打开（open:true）。 */
    togglePopover(payload: { kind: ChromePopoverKind; anchor: { x: number; y: number; width: number; height: number }; lang?: "zh-CN" | "en-US" }): Promise<{ ok: boolean; open: boolean; error?: string }>;
    closePopover(): Promise<{ ok: boolean }>;
    popoverAction(payload: { action: string; payload?: unknown }): Promise<{ ok: boolean }>;
    /** 打开 Agent 会话栏独立窗口（真·窗口化；可拖动/缩放/最小化）。 */
    openAgentWindow(payload: { sessionId?: string }): Promise<{ ok: boolean; error?: string }>;
    /** 关闭会话栏独立窗口。 */
    closeAgentWindow(): Promise<{ ok: boolean }>;
    /** 最小化会话栏独立窗口（自绘无系统边框后由标题栏按钮调用）。 */
    minimizeAgentWindow(): Promise<{ ok: boolean }>;
    /** 图标模式下还原小窗（点击图标按钮）。 */
    restoreAgentWindow(): Promise<{ ok: boolean }>;
    /** 图标模式下拖动小窗图标（dx/dy 为屏幕坐标增量，主进程夹取工作区）。 */
    moveAgentWindow(payload: { dx: number; dy: number }): Promise<{ ok: boolean }>;
    /** 普通态 Agent 窗口标题栏拖拽（屏幕增量）。 */
    dragAgentWindow(payload: { dx: number; dy: number; phase?: "start" | "move" | "end" }): Promise<{ ok: boolean }>;
  };
  loop: LoopsoarDomain & {
    /** 可运行的 Agent-Loop 列表 + 当前选择 + 回退历史。 */
    list(): Promise<LoopListResult>;
    /** 切换活动 loop（builtin 与自定义都允许；不存在或校验失败返回 ok:false+error）。 */
    setActive(payload: { id: string }): Promise<LoopSetActiveResult>;
    /** 重新扫描 loops/ 目录（L2 声明式 / L3 脚本）。 */
    reload(): Promise<LoopListResult>;
  };
  file: LoopsoarDomain;
  workspace: LoopsoarDomain & {
    list(): Promise<{ workspaces: WorkspaceRecord[]; activeId: string | null }>;
    create(payload?: { root?: string; name?: string }): Promise<{
      ok: boolean;
      workspace?: WorkspaceRecord;
      workspaces: WorkspaceRecord[];
      activeId: string | null;
      error?: string;
    }>;
    select(payload: { id: string }): Promise<{
      ok: boolean;
      workspace?: WorkspaceRecord;
      workspaces: WorkspaceRecord[];
      activeId: string | null;
      error?: string;
    }>;
    /** 把工作区绑定到当前会话（输入框下方工作区选择器）。 */
    bindSession(payload: { sessionId?: string; workspaceId: string }): Promise<{
      ok: boolean;
      sessions?: SessionMeta[];
      workspaces?: WorkspaceRecord[];
      activeId?: string | null;
      error?: string;
    }>;
    /** 重命名工作区（只改显示名）。 */
    rename(payload: { id: string; name: string }): Promise<{
      ok: boolean;
      workspace?: WorkspaceRecord;
      workspaces: WorkspaceRecord[];
      activeId: string | null;
      error?: string;
    }>;
    /** 在系统文件管理器中打开工作区根目录。 */
    openFolder(payload: { id: string }): Promise<{ ok: boolean; root?: string; error?: string }>;
    remove(payload: { id: string }): Promise<{
      ok: boolean;
      workspaces: WorkspaceRecord[];
      activeId: string | null;
      error?: string;
    }>;
    status(payload?: { id?: string }): Promise<WorkspaceStatusResult>;
  };
  worktree: LoopsoarDomain & {
    create(payload: { sessionId: string }): Promise<{ ok: boolean; worktree?: SessionWorktree; error?: string }>;
    remove(payload: { sessionId: string; force?: boolean; deleteBranch?: boolean }): Promise<{ ok: boolean; error?: string }>;
    diff(payload: { sessionId: string }): Promise<{ ok: boolean; diff?: WorktreeDiff; worktree?: SessionWorktree; error?: string }>;
    merge(payload: { sessionId: string; message?: string }): Promise<{
      ok: boolean;
      committed?: boolean;
      mergeCommit?: string;
      conflicts?: string[];
      error?: string;
    }>;
  };
  agents: LoopsoarDomain & { list(): Promise<{ agents: AgentSummary[] }> };
  runtime: LoopsoarDomain & {
    status(): Promise<BootStatus>;
    version(): Promise<{ app: string; id: string; version: string }>;
  };
  /** 应用级提示：主进程透明子窗口（永远压在原生网页之上）。 */
  ui: LoopsoarDomain & {
    toast(payload: { text: string; sticky?: boolean }): Promise<{ ok: boolean }>;
  };
  browser: LoopsoarDomain & {
    navigate(payload: { url: string }): Promise<{ ok: boolean; url?: string; tabId?: string; error?: string }>;
    newTab(payload?: { url?: string }): Promise<{ ok: boolean; tabId: string; url?: string; error?: string }>;
    closeTab(payload: { tabId: string }): Promise<{ closed: boolean }>;
    /** 删除会话时关闭该会话名下的全部网页（工作区 > 会话 > 网页；删会话才关网页，关网页不删会话）。 */
    closeSessionTabs(payload: { sessionId: string }): Promise<{ closed: number }>;
    selectTab(payload: { tabId: string }): Promise<{ selected: boolean }>;
    listTabs(): Promise<{ tabs: TabState[]; visibleSession: string }>;
    /** 结束任务工作区：关页 + 清任务快照/标记（不再复活）。 */
    endTask(payload: { sessionId: string }): Promise<{ ok: boolean }>;
    /** 主题外壳色：四角遮罩/网页切角跟随。 */
    setCornerColor(payload: { color: string }): Promise<{ ok: boolean }>;
    /** 所有任务（跨会话任务条）。 */
    listTasks(): Promise<{ tasks: { sessionId: string; tabs: TabState[] }[]; visibleSession: string }>;
    /** 进入某个任务的折叠工作区（同时应切到该会话）。 */
    showTask(payload: { sessionId: string }): Promise<{ ok: boolean; tabs: TabState[] }>;
    /** 回到全局用户标签。 */
    showUserTabs(): Promise<{ ok: boolean; tabs: TabState[] }>;
    setOverlay(payload: { open: boolean }): Promise<{ open: boolean }>;
    /** Agent 工作区接管锁：locked=true 时该会话的网页只拦真实用户事件（放行 Agent 的合成事件）。 */
    setSidebarWidth(payload: { width: number; animate?: boolean }): Promise<{ width: number }>;
    /** 底部 DOM 面板（全宽终端）占用高度：原生网页视图让出，避免被遮挡。 */
    setBottomInset(payload: { bottom: number }): Promise<{ bottom: number }>;
    back(payload?: { tabId?: string }): Promise<{ ok: boolean; url?: string; error?: string }>;
    forward(payload?: { tabId?: string }): Promise<{ ok: boolean; url?: string; error?: string }>;
    reload(payload?: { tabId?: string }): Promise<{ ok: boolean; url?: string; error?: string }>;
    /** 切换当前标签的底部开发者工具面板（F12 / Ctrl+Shift+I / 状态栏按钮）。 */
    toggleDevTools(payload?: { tabId?: string }): Promise<{ ok: boolean; open?: boolean; error?: string }>;
    /** 同步底部调试面板的高度/开合（渲染层布局变化时调用）。 */
    setDevToolsPanel(payload: { open: boolean; height?: number }): Promise<{ open: boolean }>;
    /** 历史/快捷入口缺图标时按页面 URL 回抓（data URL）。 */
    resolveFavicon(payload: { url: string }): Promise<{ favicon: string | null }>;
    /** 浏览器扩展列表。 */
    listExtensions(): Promise<{ extensions: BrowserExtensionInfo[] }>;
    /** 安装扩展：path=本地未打包目录；url=Chrome 应用商店链接或 32 位扩展 ID。 */
    installExtension(payload: { path?: string; url?: string }): Promise<{ ok: boolean; extension?: BrowserExtensionInfo; error?: string }>;
    removeExtension(payload: { id: string }): Promise<{ ok: boolean; error?: string }>;
    history(payload?: { tabId?: string }): Promise<{ entries: HistoryEntry[] }>;
    /** 删除选中的历史条目（urls 来自 history().entries；幂等）。 */
    historyRemove(payload: { urls: string[] }): Promise<{ removed: number }>;
    downloads(): Promise<{ downloads: DownloadItem[] }>;
    downloadAction(payload: { id: string; action: "cancel" | "open" | "showInFolder" | "remove" }): Promise<{ ok: boolean }>;
    snapshot(): Promise<BrowserSnapshotResult>;
    screenshot(payload?: { selector?: string }): Promise<{ ok: boolean; data?: string; error?: string }>;
    /** 保存当前页面 HTML 全页到下载目录 saved-pages/。 */
    savePage(payload?: { tabId?: string }): Promise<SavePageResult>;
  };
  bookmarks: LoopsoarDomain & {
    /** 书签列表（最新在前；主进程已去重，上限 500）。 */
    list(): Promise<{ bookmarks: BookmarkItem[] }>;
    /** 新增书签；duplicate=true 表示已存在（返回已有项，不重复插入）。 */
    add(payload: { url: string; title?: string }): Promise<BookmarkAddResult>;
    /** 删除书签；ok=false 表示已不存在（幂等）。 */
    remove(payload: { id: string }): Promise<{ ok: boolean }>;
  };
  terminal: LoopsoarDomain & {
    /** 探测本机可用的终端配置档（cmd/PowerShell/Git Bash/Python/Node/C++；裸数组）。 */
    profiles(): Promise<TerminalProfileInfo[]>;
    /** 当前终端列表（裸数组；已退出条目保留 state:"exited" 供回放）。 */
    list(): Promise<TerminalSessionInfo[]>;
    /** 新建持久终端；缺省 cwd = 当前会话工作根。失败会 reject（中文错误消息）。 */
    open(payload: { sessionId?: string; profile: TerminalProfileKey; cwd?: string }): Promise<TerminalSessionInfo>;
    /** 原始输入（REPL 交互用；是否追加换行由 UI/用户决定）。 */
    input(payload: { terminalId: string; data: string }): Promise<TerminalActionResult>;
    /** 执行一整条命令（Enter 提交；安全判定在主进程）。 */
    run(payload: { terminalId: string; command: string }): Promise<TerminalActionResult>;
    /** 中断当前前台进程（Ctrl+C 等价）；false = 不存在/已退出（幂等）。 */
    interrupt(payload: { terminalId: string }): Promise<boolean>;
    /** 关闭终端并清理子进程树；false = 不存在/已退出（幂等）。 */
    close(payload: { terminalId: string }): Promise<boolean>;
    /** 回放终端输出缓冲；null = 该 id 不认识/已关闭。 */
    history(payload: { terminalId: string }): Promise<TerminalHistoryResult | null>;
    /** 终端环境自检（配置档 + 常见 CLI 依赖；只读探测）。 */
    diagnose(): Promise<TerminalDiagnostics>;
  };
  memory: LoopsoarDomain & {
    list(): Promise<MemoryListResult>;
    stats(): Promise<MemoryStats>;
    add(payload: { content: string; category: string; tags?: string[]; importance?: number }): Promise<{ added: boolean; id: string }>;
    update(payload: {
      id: string;
      content?: string;
      category?: string;
      tags?: string[];
      importance?: number;
    }): Promise<{ updated: boolean }>;
    delete(payload: { id: string }): Promise<{ deleted: boolean }>;
    clear(): Promise<{ cleared: boolean }>;
  };
  dialog: LoopsoarDomain & {
    pickPath(payload: { kind: "file" | "directory"; title?: string }): Promise<{ canceled: boolean; path: string | null }>;
  };
  settings: LoopsoarDomain & {
    listModels(payload: {
      provider: string;
      baseUrl: string;
      model?: string;
      apiFormat?: "auto" | "openai" | "anthropic";
      apiKey?: string;
      headers?: Record<string, string>;
    }): Promise<{
      models: ProviderModel[];
      /** 每个模型的能力来源诊断（上游给了哪些字段、内置表推断出哪些字段），用于三态合并。 */
      capabilityMeta?: Record<string, { upstreamFields: string[]; inferredCaps: Record<string, unknown> }>;
      error: string | null;
    }>;
    listProviders(): Promise<{ items: ProviderItem[]; activeId: string | null }>;
    upsertProvider(payload: {
      id?: string;
      provider: string;
      baseUrl: string;
      model: string;
      apiFormat?: "auto" | "openai" | "anthropic";
      rpm?: number;
      headers?: Record<string, string>;
      models?: ProviderModel[];
    }): Promise<{ item: ProviderItem; items: ProviderItem[]; activeId: string | null }>;
    removeProvider(payload: { id: string }): Promise<{ removed: boolean; items: ProviderItem[]; activeId: string | null }>;
    setActiveProvider(payload: { id: string }): Promise<{ ok: boolean; activeId: string | null }>;
    setApiKey(payload: { apiKey: string; providerId?: string }): Promise<{ saved: boolean; hint: string; storageMode: string }>;
    clearApiKey(payload: { providerId?: string }): Promise<{ cleared: boolean }>;
    getProvider(): Promise<ProviderStatus>;
    setProvider(payload: { provider: string; baseUrl: string; model: string }): Promise<{ saved: boolean; usable: boolean; reason?: string | null }>;
    testProvider(payload: {
      provider: string;
      baseUrl: string;
      model: string;
      /** 被测供应商 id：服务端据此取该供应商自己的密钥（缺省按 provider+baseUrl 匹配）。 */
      id?: string;
      /** 表单里刚输入、尚未保存的密钥（只用于本次探测，不落盘）。 */
      apiKey?: string;
      headers?: Record<string, string>;
    }): Promise<TestProviderResult>;
    clearProvider(): Promise<{ cleared: boolean }>;
    getPreferences(): Promise<{ preferences: Preferences; defaults: Preferences; searchUrlExample: string; locations: LocationsInfo }>;
    setPreferences(payload: Preferences): Promise<{ saved: boolean; preferences: Preferences }>;
    getPermissions(): Promise<PermissionsState>;
    setPermissions(payload: PermissionsState["permissions"]): Promise<{ saved: boolean; permissions: PermissionsState["permissions"] }>;
    getRules(): Promise<RulesSnapshot>;
    setRules(payload: {
      entries: { name?: string; scope: "global" | "workspace"; enabled: boolean; content: string }[];
      deleted?: string[];
    }): Promise<{ saved: boolean; entries: RuleEntry[]; merged: RulesSnapshot["merged"] }>;
    diagnostics(): Promise<DiagnosticsInfo>;
    about(): Promise<AboutInfo>;
  };
  window: LoopsoarDomain & {
    minimize(): Promise<{ ok: boolean }>;
    maximize(): Promise<{ ok: boolean; maximized: boolean }>;
    close(): Promise<{ ok: boolean }>;
    state(): Promise<{ maximizeSupported: boolean; maximized: boolean; focused: boolean }>;
  };
  skills: LoopsoarDomain & {
    list(): Promise<{ skills: SkillRecord[]; dir: string; skipped: { dir: string; reason: string }[] }>;
    reload(): Promise<{ skills: SkillRecord[]; skipped: { dir: string; reason: string }[] }>;
    setEnabled(payload: { id: string; enabled: boolean }): Promise<{ ok: boolean; skill: SkillRecord | null }>;
    openDir(): Promise<{ ok: boolean; dir: string }>;
  };
  mcp: LoopsoarDomain & {
    list(): Promise<{ servers: McpServerInfo[]; configPath: string }>;
    add(payload: {
      id?: string;
      name: string;
      transport?: "stdio" | "http";
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      url?: string;
      headers?: Record<string, string>;
      enabled?: boolean;
    }): Promise<{ server: McpServerInfo; servers: McpServerInfo[] }>;
    remove(payload: { id: string }): Promise<{ removed: boolean; servers: McpServerInfo[] }>;
    connect(payload: { id: string }): Promise<{ server: McpServerInfo | null; servers: McpServerInfo[] }>;
    disconnect(payload: { id: string }): Promise<{ ok: boolean; servers: McpServerInfo[] }>;
  };
  skills: LoopsoarDomain & {
    list(): Promise<{ skills: SkillRecord[]; dir: string; skipped: { dir: string; reason: string }[] }>;
    reload(): Promise<{ skills: SkillRecord[]; skipped: { dir: string; reason: string }[] }>;
    setEnabled(payload: { id: string; enabled: boolean }): Promise<{ ok: boolean; skill: SkillRecord | null }>;
    openDir(): Promise<{ ok: boolean; dir: string }>;
  };
  mcp: LoopsoarDomain & {
    list(): Promise<{ servers: McpServerInfo[]; configPath: string }>;
    add(payload: {
      id?: string;
      name: string;
      transport?: "stdio" | "http";
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      url?: string;
      headers?: Record<string, string>;
      enabled?: boolean;
    }): Promise<{ server: McpServerInfo; servers: McpServerInfo[] }>;
    remove(payload: { id: string }): Promise<{ removed: boolean; servers: McpServerInfo[] }>;
    connect(payload: { id: string }): Promise<{ server: McpServerInfo | null; servers: McpServerInfo[] }>;
    disconnect(payload: { id: string }): Promise<{ ok: boolean; servers: McpServerInfo[] }>;
  };
  fs: LoopsoarDomain & {
    readImage(payload: { path: string }): Promise<{ ok: boolean; dataUrl?: string; mime?: string; error?: string }>;
    /** 剪贴板图片落盘（主进程限 6MB / png·jpeg·webp·gif；文件名由主进程生成）。 */
    saveImage(payload: { dataBase64: string; mime: string; name?: string }): Promise<{
      ok: boolean;
      path?: string;
      mime?: string;
      bytes?: number;
      error?: string;
    }>;
  };
  extensions: LoopsoarDomain & {
    list(): Promise<{
      extensions: InstalledExtension[];
      dir: string;
      skipped: { dir: string; reason: string }[];
      runtime?: Record<string, ExtensionRuntimeStatus>;
    }>;
    setEnabled(payload: { id: string; enabled: boolean }): Promise<{
      ok: boolean;
      extension: InstalledExtension | null;
      runtime?: ExtensionRuntimeStatus;
    }>;
    start(payload: { id: string }): Promise<{ status: ExtensionRuntimeStatus; runtime: Record<string, ExtensionRuntimeStatus> }>;
    stop(payload: { id: string }): Promise<{ status: ExtensionRuntimeStatus; runtime: Record<string, ExtensionRuntimeStatus> }>;
    remove(payload: { id: string }): Promise<{ removed: boolean }>;
    openDir(): Promise<{ ok: boolean; dir: string }>;
  };
  on(event: LoopsoarEvent, cb: (payload: unknown) => void): () => void;
}

declare global {
  interface Window {
    loopsoarAPI?: LoopsoarAPI;
  }
}

export {};
