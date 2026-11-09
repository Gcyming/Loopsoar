/**
 * settings 域：设置面板的全部读写（通用 / 权限 / 供应商 / 规则 / 记忆路径 / 存储 / 诊断 / 关于）。
 *
 * 文件布局（%APPDATA%\loopsoar 或 LOOPSOAR_DATA_DIR 覆盖）：
 *   config/provider.json     模型服务商（非机密；apiKey 只走环境变量）
 *   config/preferences.json  通用偏好（含工作区根/记忆库路径/下载目录/自动记忆开关）
 *   config/permissions.json  权限策略
 *   config/rules.json        规则条目启用状态
 *   rules/*.md               全局规则条目（逐条增删，AGENTS.md 约定）
 *   <workspace>/AGENTS.md    项目规则（随项目仓库共享；无则兼容 CLAUDE.md）
 *   memory/memory.json       记忆库（路径可配置）
 *   sessions/last.json       最近会话
 *
 * 安全纪律：apiKey 永不落盘、永不回传；规则注入前经 core/rules 校验与护栏。
 */
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { renderHeaderTemplates } from "loopsoar-contracts/headerTemplate";
import { withProviderDefaults } from "../providerDefaults.js";
import { describeCapabilitySources, enrichModelSpec, type ModelSpec } from "loopsoar-core/modelCapabilities";
import { isSameProviderTarget } from "../providerStore.js";
import type { LoopsoarPlatform } from "loopsoar-core/platform";
import { inferApiFormat } from "loopsoar-core/llm";
import {
  isBlockedHostname,
  isIpLiteral,
  isLoopbackHostname,
  isLoopbackIp,
  isPrivateOrReservedIp,
} from "loopsoar-core/websearch";
import {
  validateProviderConfig,
  resolveApiKeyFromEnv,
  providerUsability,
  type ProviderConfig,
} from "loopsoar-core/provider";
import {
  DEFAULT_PREFERENCES,
  mergePreferences,
  searchUrlFor,
  type Preferences,
} from "loopsoar-core/preferences";
import { PERMISSION_CATEGORIES, mergePermissions, type Permissions } from "loopsoar-core/permissions";
import {
  RULES_FILE_NAME,
  CLAUDE_COMPAT_FILE_NAME,
  RULES_MAX_FILE_BYTES,
  RULES_MAX_TOTAL_BYTES,
  mergeRules,
  rulesForPrompt,
  validateRuleContent,
  type RuleSource,
} from "loopsoar-core/rules";
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";
import type { ProviderStore } from "../providerStore.js";
import type { SecretStore } from "../secretStore.js";

export interface SettingsDeps extends TrustedIpcDeps {
  platform: LoopsoarPlatform;
  dataDir: string;
  configDir: string;
  /** 工作区根（项目规则的查找起点）；可在设置里改，改后由装配层回调更新。 */
  workspaceRoot: string;
  env: Record<string, string | undefined>;
  appVersion: string;
  diagnosticsExtra?: () => Record<string, unknown>;
  /** 供应商配置保存后回调（装配层据此重建 LLM 客户端，无需重启）。 */
  onProviderSaved?: (cfg: ProviderConfig) => void;
  /** 供应商配置被清除后回调（装配层销毁 LLM 客户端）。 */
  onProviderCleared?: () => void;
  /** 通用偏好保存后回调（装配层据此切换工作区根/记忆库位置等）。 */
  onPreferencesSaved?: (prefs: Preferences) => void;
  /** 原生文件/目录选择器（由 index 注入 dialog；不 import electron）。 */
  pickPath?: (kind: "file" | "directory", title?: string) => Promise<string | null>;
  /** 多供应商配置（providers.json）；未注入时回退旧单配置文件。 */
  providers?: ProviderStore;
  /** 供应商增删改/切换活跃后回调（装配层重建 LLM 客户端）。 */
  onProvidersChanged?: () => void;
  /** 加密密钥库（API Key 输入与隔离存储；永不回传明文）。 */
  secrets?: SecretStore;
}

export interface SettingsPaths {
  provider: string;
  preferences: string;
  permissions: string;
  rulesState: string;
  globalRulesDir: string;
  workspaceRules: string;
  memoryFile: string;
  sessionsFile: string;
}

export function settingsPaths(
  deps: Pick<SettingsDeps, "configDir" | "dataDir" | "workspaceRoot">,
): SettingsPaths {
  return {
    provider: path.join(deps.configDir, "provider.json"),
    preferences: path.join(deps.configDir, "preferences.json"),
    permissions: path.join(deps.configDir, "permissions.json"),
    rulesState: path.join(deps.configDir, "rules.json"),
    globalRulesDir: path.join(deps.dataDir, "rules"),
    workspaceRules: path.join(deps.workspaceRoot, RULES_FILE_NAME),
    memoryFile: path.join(deps.dataDir, "memory", "memory.json"),
    sessionsFile: path.join(deps.dataDir, "sessions", "last.json"),
  };
}

function readJsonFile(file: string): unknown {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonFile(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export async function loadProviderConfig(
  _platform: LoopsoarPlatform,
  configDir: string,
): Promise<ProviderConfig | null> {
  const raw = readJsonFile(path.join(configDir, "provider.json"));
  if (!raw) return null;
  try {
    return validateProviderConfig(raw);
  } catch {
    return null;
  }
}

export function loadPreferences(configDir: string): Preferences {
  return mergePreferences(readJsonFile(path.join(configDir, "preferences.json")) ?? {});
}

export function loadPermissions(configDir: string): Permissions {
  return mergePermissions(readJsonFile(path.join(configDir, "permissions.json")) ?? {});
}

/**
 * 局部更新偏好（供非设置页的装配层使用，如 Agent-Loop 选择持久化）。
 * 为什么单独导出：设置页走 settings:setPreferences 通道；装配层（index.ts）也需要写偏好，
 * 但不能为了一个字段伪造一次 IPC。合并后写回，返回完整偏好。
 */
export function savePreferencesPatch(configDir: string, patch: Partial<Preferences>): Preferences {
  const next = mergePreferences({ ...loadPreferences(configDir), ...patch });
  writeJsonFile(path.join(configDir, "preferences.json"), next);
  return next;
}

/* ───────────────────────── 规则条目（逐条增删） ───────────────────────── */

export interface RuleEntryState {
  id: string;
  name: string;
  scope: "global" | "workspace";
  enabled: boolean;
  path: string;
  bytes: number;
  content: string;
}

interface RulesStateFile {
  disabled: string[];
}

function loadRulesState(configDir: string): RulesStateFile {
  const raw = readJsonFile(path.join(configDir, "rules.json")) as Partial<RulesStateFile> | null;
  return { disabled: Array.isArray(raw?.disabled) ? raw!.disabled : [] };
}

/** 全局规则文件名安全校验（防路径穿越；允许中文名）。 */
export const RULE_FILE_RE = /^[A-Za-z0-9\u4e00-\u9fa5._-]{1,56}\.md$/;

export function readRuleEntries(deps: SettingsDeps): RuleEntryState[] {
  const paths = settingsPaths(deps);
  const state = loadRulesState(deps.configDir);
  const entries: RuleEntryState[] = [];

  // 全局规则目录：每个 *.md 一条
  try {
    if (fs.existsSync(paths.globalRulesDir)) {
      const files = fs
        .readdirSync(paths.globalRulesDir)
        .filter((f) => f.endsWith(".md"))
        .sort();
      for (const file of files.slice(0, 30)) {
        const full = path.join(paths.globalRulesDir, file);
        let content = "";
        try {
          content = fs.readFileSync(full, "utf8");
        } catch {
          content = "";
        }
        const id = `global:${file}`;
        entries.push({
          id,
          name: file,
          scope: "global",
          enabled: !state.disabled.includes(id),
          path: full,
          bytes: byteLength(content),
          content,
        });
      }
    }
  } catch {
    // 目录不可读时返回空列表（UI 可新建）
  }

  // 项目规则：AGENTS.md（无则 CLAUDE.md 兼容）
  const agents = paths.workspaceRules;
  const claude = path.join(deps.workspaceRoot, CLAUDE_COMPAT_FILE_NAME);
  const wsFile = fs.existsSync(agents) ? agents : fs.existsSync(claude) ? claude : agents;
  let wsContent = "";
  try {
    if (fs.existsSync(wsFile)) wsContent = fs.readFileSync(wsFile, "utf8");
  } catch {
    wsContent = "";
  }
  const wsId = `workspace:${RULES_FILE_NAME}`;
  entries.push({
    id: wsId,
    name:
      fs.existsSync(wsFile) && wsFile.endsWith(CLAUDE_COMPAT_FILE_NAME)
        ? CLAUDE_COMPAT_FILE_NAME
        : RULES_FILE_NAME,
    scope: "workspace",
    enabled: !state.disabled.includes(wsId),
    path: wsFile,
    bytes: byteLength(wsContent),
    content: wsContent,
  });

  return entries;
}

/** 规则条目 → mergeRules 输入（全局在前，项目在后）。 */
export function ruleSourcesFromEntries(entries: RuleEntryState[]): RuleSource[] {
  return entries
    .map((entry) => ({
      scope: entry.scope,
      path: entry.path,
      enabled: entry.enabled,
      content: entry.content,
    }))
    .sort((a, b) => (a.scope === b.scope ? 0 : a.scope === "global" ? -1 : 1));
}

export function currentRulesPrompt(deps: SettingsDeps): string {
  return rulesForPrompt(mergeRules(ruleSourcesFromEntries(readRuleEntries(deps))));
}

/* ───────────────────────── 供应商探测目标校验（SSRF） ───────────────────────── */

export type ProbeTargetResult = { ok: true; url: URL } | { ok: false; message: string };

/**
 * 模型服务探测目标校验（策略与通用 web_fetch 不同）：
 *   · 允许回环（本地 Ollama / llama-server 是合法目标，端口任意）；
 *   · 拒绝其他私网 / 链路本地 / 元数据地址（169.254.169.254 等）；
 *   · 仅允许 http/https；解析结果为空或混有回环+公网（疑似 DNS rebinding）一律拒绝。
 * 为什么单独一套：通用抓取的「禁回环」会在本地模型场景误杀，而「全放行」又会被拿来打内网。
 */
export async function validateProbeTarget(
  platform: Pick<LoopsoarPlatform, "net"> | undefined,
  baseUrl: string,
): Promise<ProbeTargetResult> {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { ok: false, message: "SSRF 拦截：baseUrl 不是合法 URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, message: `SSRF 拦截：模型服务仅允许 http/https（当前 ${url.protocol}）` };
  }
  if (url.username || url.password) {
    return { ok: false, message: "SSRF 拦截：baseUrl 不允许携带用户名/密码" };
  }
  const host = url.hostname;
  if (!host) return { ok: false, message: "SSRF 拦截：baseUrl 缺少主机名" };

  if (isIpLiteral(host)) {
    if (isLoopbackIp(host)) return { ok: true, url };
    if (isPrivateOrReservedIp(host)) {
      return { ok: false, message: `SSRF 拦截：拒绝探测内部/保留地址（${host}）` };
    }
    return { ok: true, url };
  }
  // localhost / *.localhost：本地模型服务常见目标，显式允许
  if (isLoopbackHostname(host)) return { ok: true, url };
  if (isBlockedHostname(host)) {
    return { ok: false, message: `SSRF 拦截：拒绝探测内部主机名（${host}）` };
  }

  const net = platform?.net;
  if (!net || typeof net.resolveIps !== "function") {
    // 未装配 DNS 适配器（单元测试/纯配置校验）：交给后续请求层兜底，避免在这里误杀合法配置
    return { ok: true, url };
  }
  let ips: string[] = [];
  try {
    const list = await net.resolveIps(host);
    if (Array.isArray(list)) ips = list.map((ip) => String(ip ?? "").trim()).filter((ip) => ip.length > 0);
  } catch {
    ips = [];
  }
  if (ips.length === 0) {
    return { ok: false, message: `SSRF 拦截：无法解析模型服务主机名（${host}）` };
  }
  const internal = ips.find((ip) => !isLoopbackIp(ip) && isPrivateOrReservedIp(ip));
  if (internal) {
    return { ok: false, message: `SSRF 拦截：模型服务主机名解析到内部/保留地址（${internal}）` };
  }
  const loopbacks = ips.filter((ip) => isLoopbackIp(ip));
  if (loopbacks.length > 0 && loopbacks.length !== ips.length) {
    return { ok: false, message: "SSRF 拦截：模型服务主机名解析结果混有回环与非回环地址（疑似 DNS 重绑定）" };
  }
  return { ok: true, url };
}

/* ───────────────────────── 供应商连通性测试 ───────────────────────── */

async function testProvider(
  deps: SettingsDeps,
  cfg: ProviderConfig,
  headerTemplates?: Record<string, string>,
  apiFormat?: "auto" | "openai" | "anthropic",
): Promise<{ ok: boolean; status?: number; latencyMs?: number; message: string }> {
  // 第一道门：探测目标本身不许指向内网（回环本地模型除外）
  const target = await validateProbeTarget(deps.platform, cfg.baseUrl);
  if (!target.ok) return { ok: false, message: target.message };

  // 密钥解析：加密库（活跃供应商）优先，环境变量兜底；测试任意配置时复用该密钥
  const activeId = deps.providers?.active()?.id;
  const apiKey = (activeId ? (deps.secrets?.get(activeId) ?? "") : "") || resolveApiKeyFromEnv(deps.env);
  const effectiveHeaders = withProviderDefaults(cfg.provider, cfg.baseUrl, headerTemplates);
  // 与 index.ts 装配的真实客户端同一端点规则：显式 apiFormat 优先，auto 按 baseUrl 推断
  const format = !apiFormat || apiFormat === "auto" ? inferApiFormat(cfg.baseUrl) : apiFormat;
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const anthropic = format === "anthropic";
  const url = anthropic ? `${base.replace(/\/v1$/, "")}/messages` : `${base}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  const startedAt = Date.now();
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "Loopsoar/1.0",
      ...(apiKey
        ? anthropic
          ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
          : { Authorization: `Bearer ${apiKey}` }
        : anthropic
          ? { "anthropic-version": "2023-06-01" }
          : {}),
      ...renderHeaderTemplates(effectiveHeaders, {
        provider: cfg.provider,
        model: cfg.model,
        sessionId: "test-provider",
        requestId: randomUUID(),
        timestamp: new Date().toISOString(),
      }),
    };
    const body = anthropic
      ? { model: cfg.model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }
      : { model: cfg.model, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false };
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      // 不跟随重定向：探测目标已校验，跟随 3xx 等于把校验让给服务端（SSRF 绕过口）
      redirect: "manual",
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      const bodyText = (await response.text()).slice(0, 200);
      return { ok: false, status: response.status, latencyMs, message: `HTTP ${response.status}：${bodyText}` };
    }
    return {
      ok: true,
      status: response.status,
      latencyMs,
      message: `连接成功（${latencyMs}ms${apiKey ? "" : "；未配置密钥，可能被服务端拒绝"}）`,
    };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      latencyMs,
      message: message.includes("abort") ? "连接超时（8s）" : `连接失败：${message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ───────────────────────────────── 注册 ───────────────────────────────── */

export function registerSettingsDomain(deps: SettingsDeps): void {
  const paths = settingsPaths(deps);

  // ── 供应商（多配置列表） ──
  const activeProvider = () => deps.providers?.active() ?? null;
  /** 解析某供应商密钥：加密库优先，环境变量兜底。 */
  const resolveKey = (providerId?: string): { key: string; source: "stored" | "env" | null } => {
    const stored = providerId ? (deps.secrets?.get(providerId) ?? "") : "";
    if (stored) return { key: stored, source: "stored" };
    const envKey = resolveApiKeyFromEnv(deps.env);
    return { key: envKey, source: envKey ? "env" : null };
  };
  const keyStatus = (providerId: string) => {
    const stored = deps.secrets?.has(providerId) ?? false;
    const resolved = resolveKey(providerId);
    return {
      hasKey: resolved.key.length > 0,
      keyHint: stored ? (deps.secrets?.hint(providerId) ?? null) : null,
      keySource: resolved.source,
      storageMode: deps.secrets?.storageMode() ?? "unavailable",
    };
  };

  handleTrusted(deps, "settings:listProviders", () => ({
    items: (deps.providers?.list() ?? []).map((item) => ({ ...item, ...keyStatus(item.id) })),
    activeId: activeProvider()?.id ?? null,
  }));

  handleTrusted(deps, "settings:upsertProvider", (payload) => {
    const p = payload as {
      id?: string;
      provider: string;
      baseUrl: string;
      model: string;
      apiFormat?: "auto" | "openai" | "anthropic";
      rpm?: number;
      headers?: Record<string, string>;
      models?: Parameters<ProviderStore["upsert"]>[0]["models"];
    };
    if (!deps.providers) throw new Error("供应商存储未装配");
    const item = deps.providers.upsert(p);
    deps.onProvidersChanged?.();
    return { item, items: deps.providers.list(), activeId: deps.providers.active()?.id ?? null };
  });

  handleTrusted(deps, "settings:removeProvider", (payload) => {
    const p = payload as { id: string };
    const removed = deps.providers?.remove(p.id) ?? false;
    if (removed) deps.onProvidersChanged?.();
    return { removed, items: deps.providers?.list() ?? [], activeId: deps.providers?.active()?.id ?? null };
  });

  // ── API Key（加密保存；不回传明文） ──
  handleTrusted(deps, "settings:setApiKey", (payload) => {
    const p = payload as { apiKey: string; providerId?: string };
    if (!deps.secrets) throw new Error("密钥库未装配");
    const providerId = p.providerId ?? activeProvider()?.id;
    if (!providerId) throw new Error("请先保存供应商配置，再设置 API Key");
    const record = deps.secrets.set(providerId, p.apiKey);
    deps.onProvidersChanged?.();
    return { saved: true, hint: record.hint, storageMode: deps.secrets.storageMode() };
  });

  handleTrusted(deps, "settings:clearApiKey", (payload) => {
    const p = payload as { providerId?: string };
    const providerId = p.providerId ?? activeProvider()?.id;
    if (!providerId) return { cleared: false };
    const cleared = deps.secrets?.clear(providerId) ?? false;
    deps.onProvidersChanged?.();
    return { cleared };
  });

  handleTrusted(deps, "settings:setActiveProvider", (payload) => {
    const p = payload as { id: string };
    const ok = deps.providers?.setActive(p.id) ?? false;
    if (ok) deps.onProvidersChanged?.();
    return { ok, activeId: deps.providers?.active()?.id ?? null };
  });

  handleTrusted(deps, "settings:getProvider", async () => {
    const active = activeProvider();
    if (active) {
      const cfg: ProviderConfig = { provider: active.provider, baseUrl: active.baseUrl, model: active.model };
      const status = keyStatus(active.id);
      const usability = providerUsability(cfg, status.hasKey ? "x" : "");
      return {
        configured: true,
        provider: active.provider,
        baseUrl: active.baseUrl,
        model: active.model,
        usable: usability.usable,
        reason: usability.reason ?? null,
        id: active.id,
        apiFormat: active.apiFormat ?? "auto",
        rpm: active.rpm ?? null,
        models: active.models ?? [],
        ...status,
      };
    }
    const cfg = await loadProviderConfig(deps.platform, deps.configDir);
    const apiKey = resolveApiKeyFromEnv(deps.env);
    const usability = providerUsability(cfg, apiKey);
    return {
      configured: cfg !== null,
      provider: cfg?.provider ?? null,
      baseUrl: cfg?.baseUrl ?? null,
      model: cfg?.model ?? null,
      hasApiKey: apiKey.length > 0,
      usable: usability.usable,
      reason: usability.reason ?? null,
    };
  });

  handleTrusted(deps, "settings:setProvider", async (payload) => {
    const cfg = validateProviderConfig(payload);
    writeJsonFile(paths.provider, cfg);
    // 同步进多供应商列表（保持单一数据源），并立即重建 LLM 客户端。
    // 关键：切模型时若目标就是当前活跃供应商，必须原地更新 model，
    // 否则每次换模型都会 upsert 出一条新供应商（模型菜单出现重复供应商）。
    if (deps.providers) {
      // 命中任意已有供应商（不只 active）：保留其请求头/模型清单/apiFormat/rpm，只改 model
      const existing = deps.providers.list().find((candidate) => isSameProviderTarget(candidate, cfg));
      const item = existing
        ? deps.providers.upsert({ ...existing, model: cfg.model })
        : deps.providers.upsert({ provider: cfg.provider, baseUrl: cfg.baseUrl, model: cfg.model });
      deps.providers.setActive(item.id);
      deps.onProvidersChanged?.();
    }
    deps.onProviderSaved?.(cfg);
    const apiKey = resolveApiKeyFromEnv(deps.env);
    const usability = providerUsability(cfg, apiKey);
    return { saved: true, config: cfg, usable: usability.usable, reason: usability.reason ?? null };
  });

  handleTrusted(deps, "settings:clearProvider", () => {
    try {
      if (fs.existsSync(paths.provider)) fs.unlinkSync(paths.provider);
      const active = activeProvider();
      if (active && deps.providers) {
        deps.providers.remove(active.id);
        deps.onProvidersChanged?.();
      }
    } catch {
      throw new Error("删除供应商配置失败");
    }
    deps.onProviderCleared?.();
    return { cleared: true };
  });

  handleTrusted(deps, "settings:testProvider", async (payload) => {
    const raw = payload as { headers?: Record<string, string>; apiFormat?: "auto" | "openai" | "anthropic" };
    const cfg = validateProviderConfig(payload);
    return testProvider(deps, cfg, raw.headers, raw.apiFormat);
  });

  // ── 通用偏好 / 存储位置 ──
  handleTrusted(deps, "settings:getPreferences", () => ({
    preferences: loadPreferences(deps.configDir),
    defaults: DEFAULT_PREFERENCES,
    searchUrlExample: searchUrlFor("bing", "loopsoar"),
    locations: {
      dataDir: deps.dataDir,
      configDir: deps.configDir,
      rulesDir: paths.globalRulesDir,
      sessionsFile: paths.sessionsFile,
      defaultMemoryFile: paths.memoryFile,
      workspaceRoot: deps.workspaceRoot,
    },
  }));

  handleTrusted(deps, "settings:setPreferences", (payload) => {
    const preferences = mergePreferences(payload);
    writeJsonFile(paths.preferences, preferences);
    deps.onPreferencesSaved?.(preferences);
    return { saved: true, preferences };
  });

  // ── 权限 ──
  handleTrusted(deps, "settings:getPermissions", () => ({
    permissions: loadPermissions(deps.configDir),
    categories: PERMISSION_CATEGORIES,
    workspaceRoot: deps.workspaceRoot,
  }));

  handleTrusted(deps, "settings:setPermissions", (payload) => {
    const permissions = mergePermissions(payload);
    writeJsonFile(paths.permissions, permissions);
    return { saved: true, permissions };
  });

  // ── 规则（逐条增删） ──
  handleTrusted(deps, "settings:getRules", () => {
    const entries = readRuleEntries(deps);
    return {
      maxFileBytes: RULES_MAX_FILE_BYTES,
      maxTotalBytes: RULES_MAX_TOTAL_BYTES,
      entries,
      merged: mergeRules(ruleSourcesFromEntries(entries)),
      claudeCompat: fs.existsSync(path.join(deps.workspaceRoot, CLAUDE_COMPAT_FILE_NAME)),
      guardrail: rulesForPrompt({ text: "…", included: [], skipped: [], totalBytes: 0 }).split("\n")[0],
    };
  });

  handleTrusted(deps, "settings:setRules", (payload) => {
    const data = payload as {
      entries: { name?: string; scope: "global" | "workspace"; enabled: boolean; content: string }[];
      deleted?: string[];
    };
    const state = loadRulesState(deps.configDir);
    const disabled = new Set(state.disabled);
    const errors: string[] = [];
    let totalBytes = 0;
    const pendingWrites: { file: string; content: string }[] = [];

    for (const entry of data.entries ?? []) {
      const content = entry.content ?? "";
      const entryErrors = validateRuleContent(content).map(
        (e) => `${entry.scope === "global" ? "全局规则" : "项目规则"}「${entry.name ?? RULES_FILE_NAME}」：${e}`,
      );
      errors.push(...entryErrors);
      totalBytes += byteLength(content);

      let file: string;
      let name: string;
      if (entry.scope === "global") {
        name = (entry.name ?? "").trim();
        if (!RULE_FILE_RE.test(name)) {
          errors.push(`全局规则文件名「${name || "(空)"}」不合法（仅字母数字中文 . _ -，需 .md 结尾）`);
          continue;
        }
        file = path.join(paths.globalRulesDir, name);
      } else {
        name = RULES_FILE_NAME;
        file = paths.workspaceRules;
      }
      const id = `${entry.scope}:${name}`;
      if (entry.enabled) disabled.delete(id);
      else disabled.add(id);
      pendingWrites.push({ file, content });
    }

    // 删除条目（workspace 的删除 = 清空内容，保留文件；global 直接删文件）
    for (const key of data.deleted ?? []) {
      const [scope, ...rest] = key.split(":");
      const name = rest.join(":");
      if (scope === "global" && RULE_FILE_RE.test(name)) {
        const file = path.join(paths.globalRulesDir, name);
        try {
          if (fs.existsSync(file)) fs.unlinkSync(file);
        } catch {
          errors.push(`删除全局规则「${name}」失败`);
        }
      } else if (scope === "workspace") {
        pendingWrites.push({ file: paths.workspaceRules, content: "" });
      }
      disabled.delete(key);
    }

    if (totalBytes > RULES_MAX_TOTAL_BYTES) {
      errors.push(`规则总量超限：${totalBytes} 字节（上限 ${RULES_MAX_TOTAL_BYTES} 字节）`);
    }
    if (errors.length > 0) {
      throw new Error(`规则保存被拒绝：${errors.join("；")}`);
    }

    fs.mkdirSync(paths.globalRulesDir, { recursive: true });
    for (const write of pendingWrites) {
      fs.mkdirSync(path.dirname(write.file), { recursive: true });
      fs.writeFileSync(write.file, write.content, "utf8");
    }
    writeJsonFile(paths.rulesState, { disabled: [...disabled] });

    const entries = readRuleEntries(deps);
    return { saved: true, entries, merged: mergeRules(ruleSourcesFromEntries(entries)) };
  });

  // ── 原生路径选择（文件/文件夹） ──
  handleTrusted(deps, "dialog:pickPath", async (payload) => {
    const p = payload as { kind: "file" | "directory"; title?: string };
    if (!deps.pickPath) return { canceled: true, path: null };
    const picked = await deps.pickPath(p.kind, p.title);
    return { canceled: picked === null, path: picked };
  });

  // ── 模型列表（用于输入区模型选择弹层，不跳转） ──
  handleTrusted(deps, "settings:listModels", async (payload) => {
    const raw = payload as {
      provider: string;
      baseUrl: string;
      model?: string;
      apiFormat?: "auto" | "openai" | "anthropic";
      apiKey?: string;
      headers?: Record<string, string>;
    };
    const cfg = validateProviderConfig({ provider: raw.provider, baseUrl: raw.baseUrl, model: raw.model || "default" });
    // SSRF 门：模型服务地址可以指向本机回环，但不能指向内网/链路本地/元数据服务
    const target = await validateProbeTarget(deps.platform, cfg.baseUrl);
    if (!target.ok) return { models: [], error: target.message };
    const activeId = deps.providers?.active()?.id;
    // 密钥优先级：表单刚输入的（未保存）> 活跃供应商已保存 > 环境变量
    const typedKey = typeof raw.apiKey === "string" ? raw.apiKey.trim() : "";
    const apiKey = typedKey || (activeId ? (deps.secrets?.get(activeId) ?? "") : "") || resolveApiKeyFromEnv(deps.env);
    const isAnthropic =
      raw.apiFormat === "anthropic" || (raw.apiFormat !== "openai" && /anthropic|claude/i.test(cfg.baseUrl));
    const modelsBase = cfg.baseUrl.replace(/\/+$/, "");
    const modelsUrl = isAnthropic
      ? `${modelsBase.replace(/\/v1$/, "")}/v1/models`
      : /\/v1$/.test(modelsBase)
        ? `${modelsBase}/models`
        : `${modelsBase}/v1/models`;
    const headers: Record<string, string> = {
      "User-Agent": "Loopsoar/1.0",
      ...(apiKey
        ? isAnthropic
          ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
          : { Authorization: `Bearer ${apiKey}` }
        : isAnthropic
          ? { "anthropic-version": "2023-06-01" }
          : {}),
      ...renderHeaderTemplates(withProviderDefaults(cfg.provider, cfg.baseUrl, raw.headers), {
        provider: cfg.provider,
        model: cfg.model,
        sessionId: "model-list-probe",
        requestId: randomUUID(),
        timestamp: new Date().toISOString(),
      }),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(modelsUrl, { headers, redirect: "manual", signal: controller.signal });
      if (!response.ok) {
        const bodyText = (await response.text().catch(() => "")).slice(0, 200);
        return { models: [], error: `HTTP ${response.status}${bodyText ? `：${bodyText}` : ""}` };
      }
      const data = (await response.json()) as { data?: Record<string, unknown>[]; models?: Record<string, unknown>[] };
      const rows = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
      const options = { provider: cfg.provider, baseUrl: cfg.baseUrl };
      const models: ModelSpec[] = [];
      // capabilityMeta：告诉渲染层「哪些字段来自上游、哪些只是内置表推断」，
      // 让设置面板能按「用户显式手填 > 上游实时值 > 内置推断」合并，而不是被本地缓存覆盖。
      const capabilityMeta: Record<string, { upstreamFields: string[]; inferredCaps: Record<string, unknown> }> = {};
      for (const row of rows.slice(0, 500)) {
        const spec = enrichModelSpec(row, options);
        if (typeof spec.id !== "string" || spec.id.length === 0) continue;
        if (models.length >= 200) break;
        models.push(spec);
        const sources = describeCapabilitySources(row, options);
        capabilityMeta[spec.id] = {
          upstreamFields: [...sources.upstreamFields],
          inferredCaps: { ...sources.inferredCaps },
        };
      }
      return { models, capabilityMeta, error: null };
    } catch (err) {
      return {
        models: [],
        error: err instanceof Error ? (err.message.includes("abort") ? "获取模型列表超时（8s）" : err.message) : "获取失败",
      };
    } finally {
      clearTimeout(timer);
    }
  });

  // ── 诊断 / 关于 ──
  handleTrusted(deps, "settings:diagnostics", () => {
    const prefs = loadPreferences(deps.configDir);
    return {
      paths: {
        dataDir: deps.dataDir,
        configDir: deps.configDir,
        rulesDir: paths.globalRulesDir,
        workspaceRoot: prefs.workspaceRoot || deps.workspaceRoot,
        downloadDir: prefs.downloadDir || "(系统下载文件夹)",
        memoryFile: prefs.memoryStorePath || paths.memoryFile,
        sessionsFile: paths.sessionsFile,
      },
      versions: {
        app: deps.appVersion,
        electron: process.versions.electron ?? "—",
        chrome: process.versions.chrome ?? "—",
        node: process.versions.node,
      },
      extra: {
        secretStorageMode: deps.secrets?.storageMode() ?? "unavailable",
        secretFileMode: deps.secrets?.fileMode() ?? null,
        activeProvider: deps.providers?.active()?.id ?? null,
        activeHasKey: deps.providers?.active() ? (deps.secrets?.has(deps.providers.active()!.id) ?? false) : false,
        ...(deps.diagnosticsExtra?.() ?? {}),
      },
    };
  });

  handleTrusted(deps, "settings:about", () => ({
    name: "Loopsoar",
    version: deps.appVersion,
    appId: "com.loopsoar.app",
    protocol: "loopsoar://",
    electron: process.versions.electron ?? "—",
    node: process.versions.node,
    brandAssetSource: "前期准备/brand/quilt-inf（官方 ∞ 破环·化片）",
    license: "内部构建（未发布）",
  }));
}
