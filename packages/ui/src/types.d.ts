// window.loopsoarAPI 声明文件（与 shell preload 白名单对齐）。
// 只声明 UI 真正消费的域方法；事件白名单与 contracts 的 EVENTS 保持一致。

export interface LoopsoarDomain {
  [method: string]: (...args: unknown[]) => Promise<unknown>;
}

export interface ProviderStatus {
  configured: boolean;
  provider: string | null;
  baseUrl: string | null;
  model: string | null;
  hasApiKey: boolean;
  usable: boolean;
  reason: string | null;
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
}

export interface ChatHistoryMessage {
  role: "user" | "assistant";
  text: string;
  ts: number;
}

export type LoopsoarEvent =
  | "chat:stream:chunk"
  | "chat:stream:reasoning"
  | "chat:stream:tool"
  | "chat:stream:progress"
  | "chat:stream:done"
  | "chat:stream:error"
  | "chat:stream:heartbeat"
  | "perm:request"
  | "boot:ready"
  | "browser:tabs"
  | "memory:updated";

export interface LoopsoarAPI {
  chat: LoopsoarDomain & {
    stream(payload: { message: string; sessionId?: string; mode?: "build" | "plan" }): Promise<{ accepted: boolean; sessionId: string }>;
    stop(payload: { sessionId: string }): Promise<{ stopped: boolean }>;
    history(): Promise<{ session: { sessionId: string; updatedAt: number; messages: ChatHistoryMessage[] } | null }>;
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
    listModels(payload: { provider: string; baseUrl: string; model: string }): Promise<{ models: string[]; error: string | null }>;
    getProvider(): Promise<ProviderStatus>;
    setProvider(payload: { provider: string; baseUrl: string; model: string }): Promise<{ saved: boolean; usable: boolean; reason?: string | null }>;
    testProvider(payload: { provider: string; baseUrl: string; model: string }): Promise<TestProviderResult>;
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
  on(event: LoopsoarEvent, cb: (payload: unknown) => void): () => void;
}

declare global {
  interface Window {
    loopsoarAPI?: LoopsoarAPI;
  }
}

export {};
