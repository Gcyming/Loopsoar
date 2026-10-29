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
import path from "node:path";
import type { LoopsoarPlatform } from "loopsoar-core/platform";
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

/** 从上游 /models 返回项中提取上下文/输出/视觉/思考/推理等级（兼容 OpenRouter 等常见字段）。 */
function enrichModelSpec(raw: Record<string, unknown>): {
  id: string;
  contextWindow?: number;
  maxOutput?: number;
  vision?: boolean;
  thinking?: boolean;
  thinkingEfforts?: string[];
} {
  const id = typeof raw.id === "string" ? raw.id : "";
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
  const contextWindow =
    num(raw.context_length) ??
    num(raw.context_window) ??
    num(raw.max_context_length) ??
    num((raw.top_provider as { context_length?: unknown } | undefined)?.context_length) ??
    num((raw.model_info as { context_length?: unknown } | undefined)?.context_length);
  const maxOutput =
    num(raw.max_output) ??
    num(raw.max_output_tokens) ??
    num(raw.max_completion_tokens) ??
    num((raw.top_provider as { max_completion_tokens?: unknown } | undefined)?.max_completion_tokens);
  const modalities = Array.isArray(raw.input_modalities) ? raw.input_modalities : [];
  const arch = raw.architecture as { input_modalities?: unknown[] } | undefined;
  const archModalities = Array.isArray(arch?.input_modalities) ? arch!.input_modalities : [];
  const vision =
    raw.vision === true ||
    raw.supports_vision === true ||
    modalities.includes("image") ||
    archModalities.includes("image");
  const reasoning = raw.reasoning as { supported_efforts?: unknown } | undefined;
  const effortsRaw = Array.isArray(raw.thinking_efforts)
    ? raw.thinking_efforts
    : Array.isArray(reasoning?.supported_efforts)
      ? (reasoning!.supported_efforts as unknown[])
      : undefined;
  const thinkingEfforts = effortsRaw?.filter((x): x is string => typeof x === "string").slice(0, 10);
  const thinking = raw.thinking === true || Boolean(reasoning) || (thinkingEfforts?.length ?? 0) > 0;
  return { id, contextWindow, maxOutput, vision, thinking, thinkingEfforts };
}

/* ───────────────────────── 供应商连通性测试 ───────────────────────── */

async function testProvider(
  deps: SettingsDeps,
  cfg: ProviderConfig,
): Promise<{ ok: boolean; status?: number; latencyMs?: number; message: string }> {
  // 密钥解析：加密库（活跃供应商）优先，环境变量兜底；测试任意配置时复用该密钥
  const activeId = deps.providers?.active()?.id;
  const apiKey = (activeId ? (deps.secrets?.get(activeId) ?? "") : "") || resolveApiKeyFromEnv(deps.env);
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false,
      }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      const body = (await response.text()).slice(0, 200);
      return { ok: false, status: response.status, latencyMs, message: `HTTP ${response.status}：${body}` };
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
    const p = payload as { id?: string; provider: string; baseUrl: string; model: string };
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
    // 同步进多供应商列表（保持单一数据源），并立即重建 LLM 客户端
    if (deps.providers) {
      const item = deps.providers.upsert({ provider: cfg.provider, baseUrl: cfg.baseUrl, model: cfg.model });
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
    const cfg = validateProviderConfig(payload);
    return testProvider(deps, cfg);
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
    };
    const cfg = validateProviderConfig({ provider: raw.provider, baseUrl: raw.baseUrl, model: raw.model || "default" });
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
    const headers: Record<string, string> = apiKey
      ? isAnthropic
        ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
        : { Authorization: `Bearer ${apiKey}` }
      : isAnthropic
        ? { "anthropic-version": "2023-06-01" }
        : {};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(modelsUrl, { headers, signal: controller.signal });
      if (!response.ok) {
        const bodyText = (await response.text().catch(() => "")).slice(0, 200);
        return { models: [], error: `HTTP ${response.status}${bodyText ? `：${bodyText}` : ""}` };
      }
      const data = (await response.json()) as { data?: Record<string, unknown>[]; models?: Record<string, unknown>[] };
      const rows = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
      const models = rows
        .slice(0, 500)
        .map((m) => enrichModelSpec(m))
        .filter((m) => typeof m.id === "string" && m.id.length > 0)
        .slice(0, 200);
      return { models, error: null };
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
      extra: deps.diagnosticsExtra?.() ?? {},
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
