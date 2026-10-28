/**
 * settings 域：设置面板的全部读写（通用 / 权限 / 供应商 / 规则 / 诊断 / 关于）。
 * 文件布局（%APPDATA%\loopsoar 或 LOOPSOAR_DATA_DIR 覆盖）：
 *   config/provider.json     模型服务商（非机密；apiKey 只走环境变量）
 *   config/preferences.json  通用偏好
 *   config/permissions.json  权限策略
 *   config/rules.json        规则文件启用状态
 *   rules/AGENTS.md          全局规则（用户级，不入 Git）
 *   <workspace>/AGENTS.md    项目规则（随项目仓库共享）
 * 安全纪律：apiKey 永不落盘、永不回传；规则内容注入前经 core/rules 校验与护栏。
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
  mergeRules,
  rulesForPrompt,
  validateRuleContent,
  type RuleSource,
} from "loopsoar-core/rules";
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";

export interface SettingsDeps extends TrustedIpcDeps {
  platform: LoopsoarPlatform;
  dataDir: string;
  configDir: string;
  /** 工作区根（项目规则的查找起点）。 */
  workspaceRoot: string;
  env: Record<string, string | undefined>;
  /** 应用版本（由 index.ts 注入，避免本域 import electron）。 */
  appVersion: string;
  /** 诊断附加信息（由装配层提供，避免设置域反向依赖其它服务）。 */
  diagnosticsExtra?: () => Record<string, unknown>;
}

export interface SettingsPaths {
  provider: string;
  preferences: string;
  permissions: string;
  rulesState: string;
  globalRules: string;
}

export function settingsPaths(deps: Pick<SettingsDeps, "configDir" | "dataDir">): SettingsPaths {
  return {
    provider: path.join(deps.configDir, "provider.json"),
    preferences: path.join(deps.configDir, "preferences.json"),
    permissions: path.join(deps.configDir, "permissions.json"),
    rulesState: path.join(deps.configDir, "rules.json"),
    globalRules: path.join(deps.dataDir, "rules", RULES_FILE_NAME),
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

/** 读取 provider 配置；不存在/损坏 → null（首启即正常态）。 */
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

/** 读取偏好（缺省补默认）。 */
export function loadPreferences(configDir: string): Preferences {
  return mergePreferences(readJsonFile(path.join(configDir, "preferences.json")) ?? {});
}

/** 读取权限策略（缺省补默认）。 */
export function loadPermissions(configDir: string): Permissions {
  return mergePermissions(readJsonFile(path.join(configDir, "permissions.json")) ?? {});
}

interface RulesState {
  globalEnabled: boolean;
  workspaceEnabled: boolean;
}

function loadRulesState(configDir: string): RulesState {
  const raw = readJsonFile(path.join(configDir, "rules.json")) as Partial<RulesState> | null;
  return { globalEnabled: raw?.globalEnabled ?? true, workspaceEnabled: raw?.workspaceEnabled ?? true };
}

function readTextIfExists(file: string): { exists: boolean; content: string } {
  try {
    if (!fs.existsSync(file)) return { exists: false, content: "" };
    return { exists: true, content: fs.readFileSync(file, "utf8") };
  } catch {
    return { exists: false, content: "" };
  }
}

/** 规则文件现场：全局（数据目录）+ 项目（工作区根，缺失时兼容 CLAUDE.md）。 */
export function readRulesSnapshot(deps: SettingsDeps): {
  global: { path: string; exists: boolean; enabled: boolean; content: string; bytes: number };
  workspace: { path: string; exists: boolean; enabled: boolean; content: string; bytes: number };
  merged: ReturnType<typeof mergeRules>;
} {
  const paths = settingsPaths(deps);
  const state = loadRulesState(deps.configDir);

  const globalFile = readTextIfExists(paths.globalRules);
  const workspaceAgents = path.join(deps.workspaceRoot, RULES_FILE_NAME);
  const workspaceClaude = path.join(deps.workspaceRoot, CLAUDE_COMPAT_FILE_NAME);
  const workspaceFile = fs.existsSync(workspaceAgents)
    ? { path: workspaceAgents, ...readTextIfExists(workspaceAgents) }
    : { path: workspaceClaude, ...readTextIfExists(workspaceClaude) };

  const sources: RuleSource[] = [
    { scope: "global", path: paths.globalRules, enabled: state.globalEnabled, content: globalFile.content },
    { scope: "workspace", path: workspaceFile.path, enabled: state.workspaceEnabled, content: workspaceFile.content },
  ];
  const merged = mergeRules(sources);

  const bytes = (s: string): number => new TextEncoder().encode(s).length;
  return {
    global: {
      path: paths.globalRules,
      exists: globalFile.exists,
      enabled: state.globalEnabled,
      content: globalFile.content,
      bytes: bytes(globalFile.content),
    },
    workspace: {
      path: workspaceFile.path,
      exists: workspaceFile.exists,
      enabled: state.workspaceEnabled,
      content: workspaceFile.content,
      bytes: bytes(workspaceFile.content),
    },
    merged,
  };
}

/** 供 ChatService 注入的规则文本（装配层启动/保存后调用）。 */
export function currentRulesPrompt(deps: SettingsDeps): string {
  return rulesForPrompt(readRulesSnapshot(deps).merged);
}

/** 供应商连通性测试：最小请求（1 token），8s 超时；不打印/不回传密钥。 */
async function testProvider(
  deps: SettingsDeps,
  cfg: ProviderConfig,
): Promise<{ ok: boolean; status?: number; latencyMs?: number; message: string }> {
  const apiKey = resolveApiKeyFromEnv(deps.env);
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

export function registerSettingsDomain(deps: SettingsDeps): void {
  const paths = settingsPaths(deps);

  // ── 供应商 ────────────────────────────────────────────────
  handleTrusted(deps, "settings:getProvider", async () => {
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
    const apiKey = resolveApiKeyFromEnv(deps.env);
    const usability = providerUsability(cfg, apiKey);
    return { saved: true, config: cfg, usable: usability.usable, reason: usability.reason ?? null };
  });

  handleTrusted(deps, "settings:testProvider", async (payload) => {
    const cfg = validateProviderConfig(payload);
    return testProvider(deps, cfg);
  });

  // ── 通用偏好 ─────────────────────────────────────────────
  handleTrusted(deps, "settings:getPreferences", () => ({
    preferences: loadPreferences(deps.configDir),
    defaults: DEFAULT_PREFERENCES,
    searchUrlExample: searchUrlFor("bing", "loopsoar"),
  }));

  handleTrusted(deps, "settings:setPreferences", (payload) => {
    const preferences = mergePreferences(payload);
    writeJsonFile(paths.preferences, preferences);
    return { saved: true, preferences };
  });

  // ── 权限 ─────────────────────────────────────────────────
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

  // ── 规则（AGENTS.md） ────────────────────────────────────
  handleTrusted(deps, "settings:getRules", () => {
    const snapshot = readRulesSnapshot(deps);
    return {
      maxFileBytes: RULES_MAX_FILE_BYTES,
      global: snapshot.global,
      workspace: snapshot.workspace,
      merged: snapshot.merged,
      claudeCompat: fs.existsSync(path.join(deps.workspaceRoot, CLAUDE_COMPAT_FILE_NAME)),
      guardrail: rulesForPrompt({ text: "…", included: [], skipped: [], totalBytes: 0 }).split("\n")[0],
    };
  });

  handleTrusted(deps, "settings:setRules", (payload) => {
    const data = payload as {
      global: { enabled: boolean; content: string };
      workspace: { enabled: boolean; content: string };
    };
    // 逐文件校验（大小/二进制），任一非法整体拒绝（不写入半截规则）
    const errors = [
      ...validateRuleContent(data.global.content).map((e) => `全局规则：${e}`),
      ...validateRuleContent(data.workspace.content).map((e) => `项目规则：${e}`),
    ];
    if (errors.length > 0) {
      throw new Error(`规则保存被拒绝：${errors.join("；")}`);
    }
    fs.mkdirSync(path.dirname(paths.globalRules), { recursive: true });
    fs.writeFileSync(paths.globalRules, data.global.content, "utf8");
    const workspaceFile = path.join(deps.workspaceRoot, RULES_FILE_NAME);
    fs.writeFileSync(workspaceFile, data.workspace.content, "utf8");
    writeJsonFile(paths.rulesState, {
      globalEnabled: data.global.enabled,
      workspaceEnabled: data.workspace.enabled,
    });
    const snapshot = readRulesSnapshot(deps);
    return { saved: true, merged: snapshot.merged };
  });

  // ── 诊断 / 关于 ──────────────────────────────────────────
  handleTrusted(deps, "settings:diagnostics", () => ({
    paths: {
      dataDir: deps.dataDir,
      configDir: deps.configDir,
      rulesDir: path.dirname(paths.globalRules),
      workspaceRoot: deps.workspaceRoot,
    },
    versions: {
      app: deps.appVersion,
      electron: process.versions.electron ?? "—",
      chrome: process.versions.chrome ?? "—",
      node: process.versions.node,
    },
    extra: deps.diagnosticsExtra?.() ?? {},
  }));

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
