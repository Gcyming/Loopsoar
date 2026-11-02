// window.loopsoarAPI 声明文件（与 shell preload 白名单对齐）。
// 只声明 UI 真正消费的域方法；事件白名单与 contracts 的 EVENTS 保持一致。

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

export interface Preferences {
  language: "zh-CN" | "en-US";
  animations: "full" | "reduced" | "off";
  restoreSession: boolean;
  searchEngine: "bing" | "google" | "duckduckgo";
  /** 广告/追踪请求拦截（webRequest 层；缺省 true，误拦时可关闭）。 */
  adBlockEnabled?: boolean;
  downloadDir?: string;
  workspaceRoot?: string;
  memoryStorePath?: string;
  memoryAutoCapture: boolean;
  sidebarWidth: number;
  agentMaxRounds?: number;
  agentMaxToolCalls?: number;
  agentRepeatToolWarn?: number;
  agentRepeatToolStop?: number;
  reasoningEffort?: string;
  /** 当前 Agent-Loop id（缺省 = 内置 loop；主进程按需持久化）。 */
  loopId?: string;
}

export interface PermissionCategory {
  key: "read" | "write" | "terminal" | "network";
  label: string;
  description: string;
}

export interface PermissionsState {
  permissions: {
    read: "allow" | "confirm" | "deny";
    write: "allow" | "confirm" | "deny";
    terminal: "allow" | "confirm" | "deny";
    network: "allow" | "confirm" | "deny";
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
}

export interface HistoryEntry {
  url: string;
  index: number;
  current: boolean;
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
}

/** 安全回退记录（自定义 loop 失败 → 用同一 ctx 回退 builtin）。 */
export interface LoopFallbackRecord {
  reason: string;
  at: number;
}

/** loop:list 返回：可选 loop 列表 + 当前选择 + 回退历史。 */
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
  | "perm:request"
  | "boot:ready"
  | "browser:tabs"
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
  | "loop:fallback";

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
    steer(payload: { message: string; sessionId?: string }): Promise<{ accepted: boolean }>;
    history(): Promise<{ session: { sessionId: string; updatedAt: number; messages: ChatHistoryMessage[] } | null }>;
    saveTimeline(payload: { sessionId?: string; timeline: unknown[] }): Promise<{ ok: boolean }>;
    sessions(): Promise<{ sessions: SessionMeta[]; currentId: string | null }>;
    newSession(): Promise<{ session: { sessionId: string } | null; sessions: SessionMeta[]; currentId: string | null }>;
    switchSession(payload: { sessionId: string }): Promise<{ ok: boolean; session: { sessionId: string; messages: ChatHistoryMessage[] } | null }>;
    deleteSession(payload: { sessionId: string }): Promise<{ removed: boolean; sessions: SessionMeta[]; currentId: string | null }>;
  };
  perm: LoopsoarDomain;
  ask: LoopsoarDomain & {
    /** 回答/取消挂起中的 ask_user 问题；received=false 表示问题已过期或会话已结束。 */
    respond(payload: { requestId: string; answer?: string; cancelled?: boolean }): Promise<AskRespondResult>;
  };
  loop: LoopsoarDomain & {
    /** 可运行的 Agent-Loop 列表 + 当前选择 + 回退历史。 */
    list(): Promise<LoopListResult>;
    /** 切换活动 loop（builtin 与自定义都允许；不存在或校验失败返回 ok:false+error）。 */
    setActive(payload: { id: string }): Promise<LoopSetActiveResult>;
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
  browser: LoopsoarDomain & {
    navigate(payload: { url: string }): Promise<{ ok: boolean; url?: string; tabId?: string; error?: string }>;
    newTab(payload?: { url?: string }): Promise<{ ok: boolean; tabId: string; url?: string; error?: string }>;
    closeTab(payload: { tabId: string }): Promise<{ closed: boolean }>;
    selectTab(payload: { tabId: string }): Promise<{ selected: boolean }>;
    listTabs(): Promise<{ tabs: TabState[] }>;
    setOverlay(payload: { open: boolean }): Promise<{ open: boolean }>;
    setSidebarWidth(payload: { width: number }): Promise<{ width: number }>;
    back(payload?: { tabId?: string }): Promise<{ ok: boolean; url?: string; error?: string }>;
    forward(payload?: { tabId?: string }): Promise<{ ok: boolean; url?: string; error?: string }>;
    reload(payload?: { tabId?: string }): Promise<{ ok: boolean; url?: string; error?: string }>;
    history(payload?: { tabId?: string }): Promise<{ entries: HistoryEntry[] }>;
    downloads(): Promise<{ downloads: DownloadItem[] }>;
    downloadAction(payload: { id: string; action: "cancel" | "open" | "showInFolder" | "remove" }): Promise<{ ok: boolean }>;
    snapshot(): Promise<BrowserSnapshotResult>;
    screenshot(): Promise<{ ok: boolean; data?: string; error?: string }>;
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
    }): Promise<{ models: ProviderModel[]; error: string | null }>;
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
