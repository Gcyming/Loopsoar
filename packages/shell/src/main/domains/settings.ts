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
import { compileRuleGuards } from "loopsoar-core/rules/guard";
import { compileCommandGuards } from "loopsoar-core/rules/commandGuard";
import { analyzeRuleConflicts } from "loopsoar-core/rules/health";
import { buildRuleChecklist, type Checklist } from "loopsoar-core/rules/checklist";
import { APP_ID, APP_NAME, APP_VERSION, PROTOCOL } from "../../shared/brand.js";
import type { RuleHit } from "../ruleStats.js";
import type { RuleHistoryStore } from "../ruleHistory.js";
import { withProviderDefaults } from "../providerDefaults.js";
import { resolveModelsUrl } from "../providerModels.js";
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
  type Preferences,
} from "loopsoar-core/preferences";
import { buildSearchUrl } from "loopsoar-contracts/omnibox";
import { PERMISSION_CATEGORIES, PERMISSION_LEVELS, mergePermissions, type Permissions } from "loopsoar-core/permissions";
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
import { TraceStore } from "../traceStore.js";
import { exportDataBackup, exportDiagnostics } from "../dataExport.js";

export interface SettingsDeps extends TrustedIpcDeps {
  platform: LoopsoarPlatform;
  dataDir: string;
  configDir: string;
  /** 工作区根（项目规则的查找起点）；可在设置里改，改后由装配层回调更新。 */
  workspaceRoot: string;
  /** 已挂载工作区：项目规则按工作区选择、按会话注入；未注入时退回 workspaceRoot 单项目。 */
  workspaces?: { list(): { id: string; name: string; root: string }[]; activeId(): string | null };
  /** 规则守卫命中统计（可选）；缺省时设置页显示空。 */
  ruleStats?: { list(): RuleHit[]; recordInjection?(texts: string[]): void };
  ruleHistory?: RuleHistoryStore;
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
  /** 在系统文件管理器中打开目录（由 index 注入；返回空串表示成功）。 */
  openPath?: (target: string) => Promise<string>;
  /** 多供应商配置（providers.json）；未注入时回退旧单配置文件。 */
  providers?: ProviderStore;
  /** 供应商增删改/切换活跃后回调（装配层重建 LLM 客户端）。 */
  onProvidersChanged?: () => void;
  /** 加密密钥库（API Key 输入与隔离存储；永不回传明文）。 */
  secrets?: SecretStore;
  /** Electron crashDumps 目录（诊断包附带 minidump；缺省则不附）。 */
  crashDumpsDir?: string;
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

/**
 * 原子写：先写同目录临时文件再 rename。
 *
 * 为什么必须原子：preferences.json / permissions.json 是整个应用的启动输入，
 * 直接覆盖写在「写到一半进程被杀 / 磁盘满」时会留下半截 JSON。以前靠 readJsonFile 的
 * 解析容错兜底，但**结构合法、字段非法**（例如 agentMaxRounds 被写成字符串）仍然会让
 * mergePreferences 抛错 → 启动直接失败。原子写把「写坏」的概率降到接近零。
 */
function writeJsonFile(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  // fsync 再 rename：只做 rename 的话，掉电后 rename 可能先落盘、内容还在页缓存，
  // 结果是一个「存在但为空」的配置——比半截 JSON 更难诊断。顺序必须是 写 → fsync → rename。
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2), "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/**
 * 坏配置隔离：把无法解析的配置文件改名留证，让下次启动回到默认值而不是反复失败。
 * 失败（只读盘/权限）不改主流程——配置读不出来也不该阻断启动。
 */
function quarantineConfig(file: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  try {
    if (fs.existsSync(file)) fs.renameSync(file, `${file}.invalid-${Date.now()}`);
  } catch {
    // 改名失败：仍以默认值继续，不抛错
  }
  console.warn(`[Loopsoar] 配置文件非法，已回到默认值：${file}（${detail}）`);
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

/**
 * 读偏好：**total function**，任何磁盘状态都必须返回一份可用偏好。
 *
 * 为什么不在 mergePreferences 里放宽：保存路径（settings:setPreferences）必须对非法输入
 * 严格报错，否则用户改坏一个字段会被静默吞掉；容错只属于「从磁盘读」这一侧。
 * 这里抛错 = 白屏，代价远大于「这次用默认值」。
 */
export function loadPreferences(configDir: string): Preferences {
  const file = path.join(configDir, "preferences.json");
  try {
    return mergePreferences(readJsonFile(file) ?? {});
  } catch (err) {
    quarantineConfig(file, err);
    return mergePreferences({});
  }
}

export function loadPermissions(configDir: string): Permissions {
  const file = path.join(configDir, "permissions.json");
  try {
    return mergePermissions(readJsonFile(file) ?? {});
  } catch (err) {
    quarantineConfig(file, err);
    return mergePermissions({});
  }
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
  /** 项目规则所属工作区（缺省 = 旧行为：settings.workspaceRoot）。 */
  workspaceId?: string;
  workspaceRoot?: string;
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

export function readRuleEntries(deps: SettingsDeps, workspaceId?: string): RuleEntryState[] {
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

  // 项目规则：AGENTS.md（无则 CLAUDE.md 兼容）；按工作区解析，缺省退回 workspaceRoot
  const workspace = workspaceId ? deps.workspaces?.list().find((item) => item.id === workspaceId) ?? null : null;
  const root = workspace?.root ?? deps.workspaceRoot;
  const agents = path.join(root, RULES_FILE_NAME);
  const claude = path.join(root, CLAUDE_COMPAT_FILE_NAME);
  const wsFile = fs.existsSync(agents) ? agents : fs.existsSync(claude) ? claude : agents;
  let wsContent = "";
  try {
    if (fs.existsSync(wsFile)) wsContent = fs.readFileSync(wsFile, "utf8");
  } catch {
    wsContent = "";
  }
  const wsId = workspace ? `workspace:${workspace.id}:${RULES_FILE_NAME}` : `workspace:${RULES_FILE_NAME}`;
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
    workspaceId: workspace?.id,
    workspaceRoot: root,
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

function checklistFor(entries: RuleEntryState[]): Checklist {
  const enabled = entries.filter((entry) => entry.enabled && entry.content.trim());
  const sources = enabled.map((entry) => ({ id: entry.id, scope: entry.scope, name: entry.name, text: entry.content }));
  const guards = compileRuleGuards(enabled.map((entry) => ({ id: entry.id, text: entry.content })));
  // 冲突项不进清单：让模型同时看到「必须 A」和「不要 A」只会更困惑。
  const conflicts = analyzeRuleConflicts(sources);
  const excluded = [
    ...guards.map((guard) => guard.rule),
    ...conflicts.flatMap((conflict) => [conflict.a.text, conflict.b.text]),
  ];
  return buildRuleChecklist(sources, excluded);
}

export function currentRulesPrompt(deps: SettingsDeps, workspaceId?: string): string {
  const entries = readRuleEntries(deps, workspaceId);
  const merged = rulesForPrompt(mergeRules(ruleSourcesFromEntries(entries)));
  const checklist = checklistFor(entries);
  // 只统计真正进入 prompt 的规则行；命中/注入构成效能分母。
  deps.ruleStats?.recordInjection?.(
    entries
      .filter((entry) => entry.enabled && entry.content.trim())
      .flatMap((entry) => entry.content.split(/\r?\n/))
      .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
      .filter((line) => line.length >= 4 && !line.startsWith("#"))
      .slice(0, 200),
  );
  return checklist.text ? merged + "\n\n" + checklist.text : merged;
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
  probeKey?: { id?: string; apiKey?: string },
): Promise<{ ok: boolean; status?: number; latencyMs?: number; message: string }> {
  // 第一道门：探测目标本身不许指向内网（回环本地模型除外）
  const target = await validateProbeTarget(deps.platform, cfg.baseUrl);
  if (!target.ok) return { ok: false, message: target.message };

  /*
   * 密钥解析（2026-11-09 修复「切密钥后测试全部 403 误判」）：
   *   ① 表单里刚输入的密钥（未保存）优先——用户点「测试连接」时测的必须是他刚填的那把；
   *   ② 被测供应商自己的已保存密钥（payload.id / provider+baseUrl 唯一匹配）；
   *   ③ 环境变量兜底。
   * 绝不能再回退「活动供应商」的密钥：那会把 A 的 Key 发给 B 的端点，
   * 测试必然 403/401，用户误以为新 Key 无效（本次报障根因）。
   */
  const explicitKey = probeKey?.apiKey?.trim() ?? "";
  const matched =
    deps.providers?.list().find((item) => {
      if (probeKey?.id) return item.id === probeKey.id;
      return item.provider === cfg.provider && item.baseUrl === cfg.baseUrl;
    }) ?? null;
  const storedKey = matched ? (deps.secrets?.get(matched.id) ?? "") : "";
  const apiKey = explicitKey || storedKey || resolveApiKeyFromEnv(deps.env);
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
    // 列表只需要「有没有 key / 来源 / 掩码」，不要为每个供应商解密完整密钥：
    // 旧实现走 resolveKey → secrets.get（DPAPI 解密 + 读文件），供应商多时列表会明显变慢。
    const envKey = resolveApiKeyFromEnv(deps.env);
    return {
      hasKey: stored || Boolean(envKey),
      keyHint: stored ? (deps.secrets?.hint(providerId) ?? null) : null,
      keySource: stored ? "stored" : envKey ? "env" : null,
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

  handleTrusted(deps, "settings:testProvider", async (payload) => {
    const raw = payload as {
      headers?: Record<string, string>;
      apiFormat?: "auto" | "openai" | "anthropic";
      id?: string;
      apiKey?: string;
    };
    const cfg = validateProviderConfig(payload);
    return testProvider(deps, cfg, raw.headers, raw.apiFormat, { id: raw.id, apiKey: raw.apiKey });
  });

  // ── 通用偏好 / 存储位置 ──
  handleTrusted(deps, "settings:getPreferences", () => ({
    preferences: loadPreferences(deps.configDir),
    defaults: DEFAULT_PREFERENCES,
    searchUrlExample: buildSearchUrl("loopsoar", "bing"),
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
    levels: PERMISSION_LEVELS,
    workspaceRoot: deps.workspaceRoot,
  }));

  handleTrusted(deps, "settings:setPermissions", (payload) => {
    const permissions = mergePermissions(payload);
    writeJsonFile(paths.permissions, permissions);
    return { saved: true, permissions };
  });

  // ── 规则（逐条增删） ──
  handleTrusted(deps, "settings:getRules", () => {
    const activeWorkspaceId = deps.workspaces?.activeId() ?? undefined;
    const entries = readRuleEntries(deps, activeWorkspaceId);
    return {
      maxFileBytes: RULES_MAX_FILE_BYTES,
      maxTotalBytes: RULES_MAX_TOTAL_BYTES,
      entries,
      merged: mergeRules(ruleSourcesFromEntries(entries)),
      claudeCompat: entries.some((entry) => entry.scope === "workspace" && entry.name === CLAUDE_COMPAT_FILE_NAME),
      guards: compileRuleGuards(entries.filter((entry) => entry.enabled && entry.content.trim()).map((entry) => ({ id: entry.id, text: entry.content }))),
      commandGuards: compileCommandGuards(entries.filter((entry) => entry.enabled && entry.content.trim()).map((entry) => ({ id: entry.id, text: entry.content }))),
      conflicts: analyzeRuleConflicts(
        entries
          .filter((entry) => entry.enabled && entry.content.trim())
          .map((entry) => ({ id: entry.id, scope: entry.scope, name: entry.name, text: entry.content })),
      ),
      stats: deps.ruleStats?.list() ?? [],
      checklist: checklistFor(entries),
      workspaces: deps.workspaces?.list() ?? [],
      activeWorkspaceId: activeWorkspaceId ?? null,
      guardrail: rulesForPrompt({ text: "…", included: [], skipped: [], totalBytes: 0 }).split("\n")[0],
    };
  });

  /** 读取某个工作区的项目规则（设置页切换项目时按需加载）。 */
  handleTrusted(deps, "settings:getWorkspaceRule", (payload) => {
    const workspaceId = (payload as { workspaceId?: string }).workspaceId ?? "";
    const workspace = deps.workspaces?.list().find((item) => item.id === workspaceId);
    if (!workspace) throw new Error("工作区不存在或未挂载");
    const agents = path.join(workspace.root, RULES_FILE_NAME);
    const claude = path.join(workspace.root, CLAUDE_COMPAT_FILE_NAME);
    const file = fs.existsSync(agents) ? agents : fs.existsSync(claude) ? claude : agents;
    let content = "";
    try {
      if (fs.existsSync(file)) content = fs.readFileSync(file, "utf8");
    } catch {
      content = "";
    }
    const id = `workspace:${workspace.id}:${RULES_FILE_NAME}`;
    const state = loadRulesState(deps.configDir);
    const entries = readRuleEntries(deps, workspace.id);
    return {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceRoot: workspace.root,
      id,
      name: file.endsWith(CLAUDE_COMPAT_FILE_NAME) ? CLAUDE_COMPAT_FILE_NAME : RULES_FILE_NAME,
      path: file,
      exists: fs.existsSync(file),
      enabled: !state.disabled.includes(id),
      content,
      // 合并预览跟随所选项目，否则切换项目后下方仍显示活动项目的规则。
      merged: mergeRules(ruleSourcesFromEntries(entries)),
      guards: compileRuleGuards(entries.filter((entry) => entry.enabled && entry.content.trim()).map((entry) => ({ id: entry.id, text: entry.content }))),
      commandGuards: compileCommandGuards(entries.filter((entry) => entry.enabled && entry.content.trim()).map((entry) => ({ id: entry.id, text: entry.content }))),
      conflicts: analyzeRuleConflicts(
        entries
          .filter((entry) => entry.enabled && entry.content.trim())
          .map((entry) => ({ id: entry.id, scope: entry.scope, name: entry.name, text: entry.content })),
      ),
      checklist: checklistFor(entries),
    };
  });

  handleTrusted(deps, "settings:setRules", (payload) => {
    const data = payload as {
      entries: {
        name?: string;
        scope: "global" | "workspace";
        enabled: boolean;
        content: string;
        workspaceId?: string;
      }[];
      deleted?: string[];
    };
    const state = loadRulesState(deps.configDir);
    const disabled = new Set(state.disabled);
    const errors: string[] = [];
    let totalBytes = 0;
    const pendingWrites: { file: string; content: string }[] = [];
    const deletions: { file: string; before: string }[] = [];

    for (const entry of data.entries ?? []) {
      const content = entry.content ?? "";
      const entryErrors = validateRuleContent(content).map(
        (e) => `${entry.scope === "global" ? "全局规则" : "项目规则"}「${entry.name ?? RULES_FILE_NAME}」：${e}`,
      );
      errors.push(...entryErrors);
      totalBytes += byteLength(content);

      let file: string;
      let name: string;
      let entryId: string | null = null;
      if (entry.scope === "global") {
        name = (entry.name ?? "").trim();
        if (!RULE_FILE_RE.test(name)) {
          errors.push(`全局规则文件名「${name || "(空)"}」不合法（仅字母数字中文 . _ -，需 .md 结尾）`);
          continue;
        }
        file = path.join(paths.globalRulesDir, name);
      } else {
        const workspace = entry.workspaceId
          ? deps.workspaces?.list().find((item) => item.id === entry.workspaceId)
          : null;
        if (entry.workspaceId && !workspace) {
          errors.push(`项目规则的工作区「${entry.workspaceId}」不存在或未挂载`);
          continue;
        }
        name = RULES_FILE_NAME;
        file = path.join(workspace?.root ?? deps.workspaceRoot, RULES_FILE_NAME);
        entryId = workspace
          ? `workspace:${workspace.id}:${name}`
          : `workspace:${name}`;
      }
      const id = entryId ?? `${entry.scope}:${name}`;
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
          if (fs.existsSync(file)) {
            deletions.push({ file, before: fs.readFileSync(file, "utf8") });
            fs.unlinkSync(file);
          }
        } catch {
          errors.push(`删除全局规则「${name}」失败`);
        }
      } else if (scope === "workspace") {
        const workspace = rest.length >= 2 ? deps.workspaces?.list().find((item) => item.id === rest[0]) : undefined;
        const root = workspace?.root ?? deps.workspaceRoot;
        pendingWrites.push({ file: path.join(root, RULES_FILE_NAME), content: "" });
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
    const revisions: { path: string; before: string; after: string }[] = [];
    for (const write of pendingWrites) {
      fs.mkdirSync(path.dirname(write.file), { recursive: true });
      let before = "";
      try {
        if (fs.existsSync(write.file)) before = fs.readFileSync(write.file, "utf8");
      } catch {
        before = "";
      }
      if (before !== write.content) revisions.push({ path: write.file, before, after: write.content });
      fs.writeFileSync(write.file, write.content, "utf8");
    }
    for (const deletion of deletions) {
      if (deletion.before) revisions.push({ path: deletion.file, before: deletion.before, after: "" });
    }
    let stateBefore = "";
    try {
      if (fs.existsSync(paths.rulesState)) stateBefore = fs.readFileSync(paths.rulesState, "utf8");
    } catch {
      stateBefore = "";
    }
    writeJsonFile(paths.rulesState, { disabled: [...disabled] });
    try {
      const stateAfter = fs.readFileSync(paths.rulesState, "utf8");
      if (stateBefore !== stateAfter) revisions.push({ path: paths.rulesState, before: stateBefore, after: stateAfter });
    } catch {
      // 读不到状态文件就不记录这一项
    }
    if (revisions.length > 0) {
      deps.ruleHistory?.add({
        action: "save",
        summary: "保存 " + revisions.length + " 个规则文件",
        files: revisions,
      });
    }

    const entries = readRuleEntries(deps, deps.workspaces?.activeId() ?? undefined);
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
    const modelsUrl = resolveModelsUrl(cfg.baseUrl, isAnthropic);
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
  /** 诊断快照（设置页与诊断包共用同一份数据，避免两处口径漂移）。 */
  const diagnosticsSnapshot = (): Record<string, unknown> => {
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
  };
  handleTrusted(deps, "settings:diagnostics", () => diagnosticsSnapshot());

  /** 在资源管理器/访达中打开数据目录。 */
  handleTrusted(deps, "settings:openDataDir", async () => {
    if (!deps.openPath) return { ok: false, error: "当前环境不支持打开目录" };
    const error = await deps.openPath(deps.dataDir);
    return error ? { ok: false, error } : { ok: true };
  });

  /**
   * 打开随包的法律文档（安装器里也有一份）：打包态在 resources/docs，
   * 开发态回退仓库根目录。缺文件时返回可读错误，不抛。
   */
  handleTrusted(deps, "settings:openDoc", async (payload) => {
    if (!deps.openPath) return { ok: false, error: "当前环境不支持打开文档" };
    const { doc } = payload as { doc: "license" | "privacy" };
    const file = doc === "license" ? "LICENSE" : "PRIVACY.md";
    const candidates = [
      path.join(process.resourcesPath ?? "", "docs", file),
      path.join(process.cwd(), file),
      path.join(process.cwd(), "..", file),
    ];
    const found = candidates.find((candidate) => {
      try {
        return fs.existsSync(candidate);
      } catch {
        return false;
      }
    });
    if (!found) return { ok: false, error: `未找到 ${file}` };
    const error = await deps.openPath(found);
    return error ? { ok: false, error } : { ok: true, path: found };
  });

  /** 选择目标目录后复制用户数据（失败返回可读错误，不抛给渲染层）。 */
  const resolveTarget = async (payload: unknown, title: string): Promise<string | null> => {
    const p = (payload ?? {}) as { targetDir?: string };
    if (p.targetDir?.trim()) return path.resolve(p.targetDir.trim());
    if (!deps.pickPath) return null;
    return deps.pickPath("directory", title);
  };

  handleTrusted(deps, "settings:exportBackup", async (payload) => {
    const target = await resolveTarget(payload, "选择数据备份保存位置");
    if (!target) return { canceled: true };
    const result = await exportDataBackup({
      dataDir: deps.dataDir,
      targetDir: target,
      version: deps.appVersion,
    });
    return { canceled: false, ...result };
  });

  handleTrusted(deps, "settings:exportDiagnostics", async (payload) => {
    const target = await resolveTarget(payload, "选择诊断包保存位置");
    if (!target) return { canceled: true };
    const result = await exportDiagnostics({
      dataDir: deps.dataDir,
      targetDir: target,
      version: deps.appVersion,
      diagnostics: diagnosticsSnapshot(),
      crashDumpsDir: deps.crashDumpsDir,
    });
    return { canceled: false, ...result };
  });

  /**
   * 运行轨迹面板：从 dataDir/traces 直接读当前会话的 JSONL（只读）。
   * 不经过装配层单例：TraceStore 无内存态，每次读盘即可，避免为一个只读视图改 index.ts。
   */
  handleTrusted(deps, "settings:traces", (payload) => {
    const p = payload as { sessionId: string; limit?: number };
    return new TraceStore(path.join(deps.dataDir, "traces")).report(p.sessionId, p.limit ?? 50);
  });

  handleTrusted(deps, "settings:about", () => ({
    name: APP_NAME,
    version: deps.appVersion,
    appId: APP_ID,
    protocol: `${PROTOCOL}://`,
    electron: process.versions.electron ?? "—",
    node: process.versions.node,
    brandAssetSource: "app icon（官方 Lp 火花图标）",
    license: `内测构建 v${APP_VERSION}（未公开发布）`,
  }));
}
