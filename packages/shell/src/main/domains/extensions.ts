/**
 * extensions 域：「万物皆插件」的本地扩展管理（发现/启停/卸载）。
 * 只暴露安全操作；扩展的运行时加载由 core/plugin + 后续 ext-loader 承担。
 */
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";
import type { ExtensionHost } from "../extensions.js";

export interface ExtensionsDeps extends TrustedIpcDeps {
  extensions?: ExtensionHost;
  /** 打开扩展目录（index 注入 shell.openPath，避免此文件 import electron）。 */
  openExtensionsDir?: () => Promise<boolean>;
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
    };
  });

  handleTrusted(deps, "extensions:setEnabled", (payload) => {
    const p = payload as { id: string; enabled: boolean };
    const item = deps.extensions?.setEnabled(p.id, p.enabled) ?? null;
    deps.push?.("extensions:updated", { id: p.id, enabled: p.enabled });
    return { ok: item !== null, extension: item };
  });

  handleTrusted(deps, "extensions:remove", (payload) => {
    const p = payload as { id: string };
    const removed = deps.extensions?.remove(p.id) ?? false;
    deps.push?.("extensions:updated", { id: p.id, removed });
    return { removed };
  });

  handleTrusted(deps, "extensions:openDir", async () => {
    const ok = (await deps.openExtensionsDir?.()) ?? false;
    return { ok, dir: deps.extensions?.dirPath() ?? "" };
  });
}
