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
  downloadDir?: string;
  workspaceRoot?: string;
  memoryStorePath?: string;
  memoryAutoCapture: boolean;
  sidebarWidth: number;
  agentMaxRounds?: number;
  agentMaxToolCalls?: number;
  reasoningEffort?: string;
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
  | "memory:updated";

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
  file: LoopsoarDomain;
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
    snapshot(): Promise<{ ok: boolean; url?: string; title?: string; text?: string; error?: string }>;
    screenshot(): Promise<{ ok: boolean; data?: string; error?: string }>;
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
