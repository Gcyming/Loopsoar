/**
 * plugin 域：插件列表 / 启停 / 重新扫描（ADR-0011 产品化）。
 *
 * 职责边界：
 *  - PluginStore 负责「磁盘发现 + 清单校验 + 启用状态持久化」；
 *  - PluginRuntime 负责「子进程生命周期 + 工具桥接」；
 *  - 本域只做 IPC 适配与两者合并：UI 拿到一份 {id,name,version,origin,builtin,enabled,state,tools,error} 列表。
 *
 * 失效安全：启停失败不抛异常，返回 { ok:false, error }；内置系统插件只读（store 层拒绝）。
 */
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";
import type { PluginEntry, PluginStore } from "../pluginStore.js";
import type { PluginRuntime, PluginRuntimeStatus } from "../pluginRuntime.js";

/** UI 侧状态语义（与 packages/ui/src/types.d.ts 的 PluginInfo.state 对齐）。 */
export type PluginState = "loaded" | "disabled" | "error" | "idle";

export interface PluginInfoDto {
  id: string;
  name: string;
  version: string;
  /** builtin=内核系统插件；local=本地安装插件（origin=user/agent 统一归为 local）。 */
  origin: "builtin" | "local";
  builtin: boolean;
  enabled: boolean;
  state: PluginState;
  description?: string;
  tools: Array<{ name: string; description?: string }>;
  error?: string;
}

export interface PluginDeps extends TrustedIpcDeps {
  plugins: PluginStore;
  /** 运行时未装配时，列表仍可展示（state=idle），启停仅落盘不启动进程。 */
  runtime?: PluginRuntime;
  push?: (event: string, payload: unknown) => void;
}

/** 插件列表项：store 的静态信息 + runtime 的动态状态合并。 */
export function pluginInfoOf(entry: PluginEntry, status: PluginRuntimeStatus | null): PluginInfoDto {
  const state = pluginStateOf(entry, status);
  return {
    id: entry.id,
    name: entry.manifest.name,
    version: entry.manifest.version,
    origin: entry.manifest.origin === "builtin" ? "builtin" : "local",
    builtin: entry.builtin,
    enabled: entry.enabled,
    state,
    ...(entry.manifest.description ? { description: entry.manifest.description } : {}),
    tools: state === "loaded" && status ? status.toolInfos.map((info) => ({ ...info })) : [],
    ...(state === "error" && status?.error ? { error: status.error } : {}),
  };
}

function pluginStateOf(entry: PluginEntry, status: PluginRuntimeStatus | null): PluginState {
  if (entry.builtin) return "loaded"; // 系统根常驻（只读、不可停用）
  if (!entry.enabled) return "disabled";
  if (!entry.main) return "idle"; // 纯声明式插件没有运行进程
  if (!status) return "idle";
  if (status.state === "error") return "error";
  if (status.state === "ready") return "loaded";
  return "idle"; // starting / idle
}

export function registerPluginDomain(deps: PluginDeps): void {
  const listPlugins = (): PluginInfoDto[] =>
    deps.plugins.list().map((entry) => pluginInfoOf(entry, deps.runtime?.status(entry.id) ?? null));

  handleTrusted(deps, "plugin:list", () => ({
    plugins: listPlugins(),
    // 坏清单/重复 id 等扫描问题：UI 可展示「跳过原因」，避免用户以为插件"消失"了
    skipped: deps.plugins.listSkipped(),
  }));

  handleTrusted(deps, "plugin:setEnabled", async (payload) => {
    const p = payload as { id: string; enabled: boolean };
    const result = deps.plugins.setEnabled(p.id, p.enabled);
    if (!result.ok) return { ok: false, error: result.error, plugins: listPlugins() };
    // 启用 → 拉起子进程并桥接工具；停用 → 精确注销工具并终止进程（失败以状态呈现，不抛）
    if (deps.runtime) {
      if (p.enabled) await deps.runtime.start(p.id);
      else deps.runtime.stop(p.id);
    }
    deps.push?.("plugins:updated", { action: p.enabled ? "enabled" : "disabled", id: p.id });
    return { ok: true, plugins: listPlugins() };
  });

  handleTrusted(deps, "plugin:reload", async () => {
    const scan = deps.plugins.reload();
    // 重新扫描后按新清单/启用状态重建运行进程（移除的插件不再占用子进程与工具名）
    if (deps.runtime) await deps.runtime.sync();
    deps.push?.("plugins:updated", { action: "reload", total: scan.plugins, skipped: scan.skipped.length });
    return { plugins: listPlugins(), skipped: scan.skipped };
  });
}
