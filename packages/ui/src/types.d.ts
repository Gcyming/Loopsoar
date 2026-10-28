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

export interface RuleFile {
  path: string;
  exists: boolean;
  enabled: boolean;
  content: string;
  bytes: number;
}

export interface RulesSnapshot {
  maxFileBytes: number;
  global: RuleFile;
  workspace: RuleFile;
  merged: {
    text: string;
    included: { scope: string; path: string; bytes: number }[];
    skipped: { path: string; reason: string }[];
    totalBytes: number;
  };
  claudeCompat: boolean;
  guardrail: string;
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

export type LoopsoarEvent =
  | "chat:stream:chunk"
  | "chat:stream:reasoning"
  | "chat:stream:tool"
  | "chat:stream:progress"
  | "chat:stream:done"
  | "chat:stream:error"
  | "chat:stream:heartbeat"
  | "perm:request"
  | "boot:ready";

export interface LoopsoarAPI {
  chat: LoopsoarDomain & {
    stream(payload: { message: string; sessionId?: string }): Promise<{ accepted: boolean; sessionId: string }>;
    stop(payload: { sessionId: string }): Promise<{ stopped: boolean }>;
  };
  perm: LoopsoarDomain;
  file: LoopsoarDomain;
  agents: LoopsoarDomain & { list(): Promise<{ agents: AgentSummary[] }> };
  runtime: LoopsoarDomain & {
    status(): Promise<BootStatus>;
    version(): Promise<{ app: string; id: string; version: string }>;
  };
  browser: LoopsoarDomain & {
    navigate(payload: { url: string }): Promise<{ ok: boolean; url?: string; error?: string }>;
    snapshot(): Promise<{ ok: boolean; url?: string; title?: string; text?: string; error?: string }>;
    screenshot(): Promise<{ ok: boolean; data?: string; error?: string }>;
  };
  settings: LoopsoarDomain & {
    getProvider(): Promise<ProviderStatus>;
    setProvider(payload: { provider: string; baseUrl: string; model: string }): Promise<{ saved: boolean; usable: boolean; reason?: string | null }>;
    testProvider(payload: { provider: string; baseUrl: string; model: string }): Promise<TestProviderResult>;
    getPreferences(): Promise<{ preferences: Preferences; defaults: Preferences; searchUrlExample: string }>;
    setPreferences(payload: Preferences): Promise<{ saved: boolean; preferences: Preferences }>;
    getPermissions(): Promise<PermissionsState>;
    setPermissions(payload: PermissionsState["permissions"]): Promise<{ saved: boolean; permissions: PermissionsState["permissions"] }>;
    getRules(): Promise<RulesSnapshot>;
    setRules(payload: {
      global: { enabled: boolean; content: string };
      workspace: { enabled: boolean; content: string };
    }): Promise<{ saved: boolean; merged: RulesSnapshot["merged"] }>;
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
