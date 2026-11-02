/**
 * extensions 域：「万物皆插件」的本地扩展管理（发现/启停/卸载）。
 * 只暴露安全操作；扩展的运行时加载由 extensionRuntime.ts（子进程 worker）承担。
 */
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";
import type { ExtensionHost } from "../extensions.js";
import type { ExtensionRuntimeStatus } from "../extensionRuntime.js";

export interface ExtensionsDeps extends TrustedIpcDeps {
  extensions?: ExtensionHost;
  /** 打开扩展目录（index 注入 shell.openPath，避免此文件 import electron）。 */
  openExtensionsDir?: () => Promise<boolean>;
  /** 扩展运行时（可选；未装配时仅做发现/启停）。 */
  extensionStatus?: () => Record<string, ExtensionRuntimeStatus>;
  startExtension?: (id: string) => Promise<ExtensionRuntimeStatus>;
  stopExtension?: (id: string) => ExtensionRuntimeStatus;
  push?: (event: string, payload: unknown) => void;
}

export function registerExtensionsDomain(deps: ExtensionsDeps): void {
  handleTrusted(deps, "extensions:list", () => {
    if (!deps.extensions) return { extensions: [], dir: "", skipped: [] };
    const scan = deps.extensions.scan();
    return {
      extensions: deps.extensions.list(),
      dir: deps.extensions.dirPath(),
      skipped: scan.skipped,
      runtime: deps.extensionStatus?.() ?? {},
    };
  });

  handleTrusted(deps, "extensions:setEnabled", (payload) => {
    const p = payload as { id: string; enabled: boolean };
    const item = deps.extensions?.setEnabled(p.id, p.enabled) ?? null;
    // 启停即加载/卸载运行时（扩展进程隔离；失败不抛给 UI，状态在 runtime 里）
    let runtime: ExtensionRuntimeStatus | undefined;
    if (item) {
      if (p.enabled) {
        void deps.startExtension?.(p.id).then((status) => {
          deps.push?.("extensions:updated", { id: p.id, enabled: true, runtime: status });
        });
      } else {
        runtime = deps.stopExtension?.(p.id);
      }
    }
    deps.push?.("extensions:updated", { id: p.id, enabled: p.enabled });
    return { ok: item !== null, extension: item, runtime };
  });

  handleTrusted(deps, "extensions:start", async (payload) => {
    const p = payload as { id: string };
    const status = (await deps.startExtension?.(p.id)) ?? { state: "error" as const, tools: [], error: "扩展运行时未装配" };
    deps.push?.("extensions:updated", { id: p.id, runtime: status });
    return { status, runtime: deps.extensionStatus?.() ?? {} };
  });

  handleTrusted(deps, "extensions:stop", (payload) => {
    const p = payload as { id: string };
    const status = deps.stopExtension?.(p.id) ?? { state: "idle" as const, tools: [] };
    deps.push?.("extensions:updated", { id: p.id, runtime: status });
    return { status, runtime: deps.extensionStatus?.() ?? {} };
  });

  handleTrusted(deps, "extensions:remove", (payload) => {
    const p = payload as { id: string };
    deps.stopExtension?.(p.id);
    const removed = deps.extensions?.remove(p.id) ?? false;
    deps.push?.("extensions:updated", { id: p.id, removed });
    return { removed };
  });

  handleTrusted(deps, "extensions:openDir", async () => {
    const ok = (await deps.openExtensionsDir?.()) ?? false;
    return { ok, dir: deps.extensions?.dirPath() ?? "" };
  });
}
