/**
 * extensions 域：扩展的发现/启停/安装/更新/回滚/信任/市场。
 *
 * 事务边界：
 *   · 安装/回滚/市场安装前先停掉运行中的 worker，完成后再按“启用意图”重启；
 *   · 启停走 ExtensionHost 的依赖闭包/级联语义，运行时只消费最终 effective enabled；
 *   · 任何认证失败都返回结构化错误，不抛给渲染层（UI 需要展示原因）。
 */
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";
import type { ExtensionHost } from "../extensions.js";
import type { ExtensionRuntimeStatus } from "../extensionRuntime.js";
import { installExtension, rollbackExtension, type InstallResult } from "../extensionInstaller.js";
import { ExtensionMarket } from "../extensionMarket.js";
import { fingerprintPublicKey } from "loopsoar-core/extensionSignature";
import { loadPreferences, savePreferencesPatch } from "./settings.js";

export interface ExtensionsDeps extends TrustedIpcDeps {
  extensions?: ExtensionHost;
  /** 打开扩展目录（index 注入 shell.openPath，避免此文件 import electron）。 */
  openExtensionsDir?: () => Promise<boolean>;
  /** 原生选择扩展目录/zip（index 注入 dialog；空 sourcePath 时调用）。 */
  pickExtensionSource?: () => Promise<string | null>;
  /** 配置目录（市场 registry 地址持久化在 preferences.json）。 */
  configDir?: string;
  /** 扩展运行时（可选；未装配时仅做发现/启停）。 */
  extensionStatus?: () => Record<string, ExtensionRuntimeStatus>;
  startExtension?: (id: string) => Promise<ExtensionRuntimeStatus>;
  stopExtension?: (id: string) => ExtensionRuntimeStatus;
  /** 应用/扩展富 UI → 扩展 worker 的视图消息。 */
  sendExtensionViewMessage?: (id: string, viewId: string, message: unknown) => boolean;
  push?: (event: string, payload: unknown) => void;
}

function stoppedIds(deps: ExtensionsDeps): string[] {
  return Object.keys(deps.extensionStatus?.() ?? {});
}

async function restartEnabled(deps: ExtensionsDeps): Promise<void> {
  if (!deps.extensions || !deps.startExtension) return;
  for (const item of deps.extensions.list()) {
    if (item.enabled) await deps.startExtension(item.manifest.id);
  }
}

/** 市场撤销/签名失效后，已运行的 worker 必须立刻停；不能只把列表状态改成 blocked。 */
function stopBlocked(deps: ExtensionsDeps): void {
  if (!deps.extensions || !deps.stopExtension) return;
  for (const item of deps.extensions.list()) {
    if (item.info?.certification === "blocked") deps.stopExtension(item.manifest.id);
  }
}

export function registerExtensionsDomain(deps: ExtensionsDeps): void {
  const market = deps.extensions
    ? new ExtensionMarket({
        host: deps.extensions,
        registryUrl: () => (deps.configDir ? loadPreferences(deps.configDir).extensionsRegistryUrl ?? "" : ""),
        catalogPublicKey: () => (deps.configDir ? loadPreferences(deps.configDir).extensionsRegistryPublicKey ?? "" : ""),
      })
    : null;

  const trustView = () =>
    deps.extensions
      ? {
          policy: deps.extensions.trust().policy(),
          keys: deps.extensions.trust().list(),
        }
      : { policy: "warn" as const, keys: [] };

  handleTrusted(deps, "extensions:list", () => {
    if (!deps.extensions) return { extensions: [], dir: "", skipped: [], trust: trustView(), hooks: null };
    const scan = deps.extensions.scan();
    stopBlocked(deps);
    const prefs = deps.configDir ? loadPreferences(deps.configDir) : null;
    return {
      extensions: deps.extensions.list(),
      dir: deps.extensions.dirPath(),
      skipped: scan.skipped,
      runtime: deps.extensionStatus?.() ?? {},
      /** 扩展贡献点（loops/themes + 冲突）：启停后由 ExtensionHost.onChange 同步。 */
      contributions: deps.extensions.contributions?.() ?? null,
      trust: trustView(),
      revocations: deps.extensions.revocationsList(),
      market: {
        registryUrl: prefs?.extensionsRegistryUrl ?? "",
        publicKey: prefs?.extensionsRegistryPublicKey ?? "",
      },
      host: {
        apiVersion: deps.extensions.list()[0]?.info?.compatibility.hostApiVersion ?? "2.0.0",
        version: deps.extensions.hostVersionValue(),
      },
    };
  });

  handleTrusted(deps, "extensions:setEnabled", async (payload) => {
    const p = payload as { id: string; enabled: boolean };
    const item = deps.extensions?.setEnabled(p.id, p.enabled) ?? null;
    const autoEnabled = deps.extensions?.lastAutoEnabled ?? [];
    const cascadeDisabled = deps.extensions?.lastCascadeDisabled ?? [];
    let runtime: ExtensionRuntimeStatus | undefined;
    if (item) {
      if (p.enabled) {
        // 依赖必须先于依赖者启动（host 返回的 lastAutoEnabled 已是拓扑序）。
        for (const id of [...autoEnabled, p.id]) {
          const status = await deps.startExtension?.(id);
          if (id === p.id) runtime = status;
        }
      } else {
        for (const id of [...cascadeDisabled, p.id]) deps.stopExtension?.(id);
        runtime = deps.stopExtension?.(p.id);
      }
    }
    deps.push?.("extensions:updated", {
      id: p.id,
      enabled: item?.enabled ?? false,
      ...(autoEnabled.length > 0 ? { autoEnabled } : {}),
      ...(cascadeDisabled.length > 0 ? { cascadeDisabled } : {}),
    });
    return {
      ok: item !== null,
      error: item ? undefined : (deps.extensions?.lastEnableError ?? "扩展启停失败"),
      extension: item,
      runtime,
      autoEnabled,
      cascadeDisabled,
    };
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
    for (const id of stoppedIds(deps)) if (id === p.id) deps.stopExtension?.(id);
    const removed = deps.extensions?.remove(p.id) ?? false;
    for (const id of deps.extensions?.lastCascadeDisabled ?? []) deps.stopExtension?.(id);
    deps.push?.("extensions:updated", { id: p.id, removed, cascadeDisabled: deps.extensions?.lastCascadeDisabled ?? [] });
    return {
      removed,
      error: removed ? undefined : (deps.extensions?.lastEnableError ?? "卸载失败"),
      cascadeDisabled: deps.extensions?.lastCascadeDisabled ?? [],
    };
  });

  handleTrusted(deps, "extensions:openDir", async () => {
    const ok = (await deps.openExtensionsDir?.()) ?? false;
    return { ok, dir: deps.extensions?.dirPath() ?? "" };
  });

  handleTrusted(deps, "extensions:install", async (payload) => {
    const p = payload as { sourcePath: string; allowUntrusted?: boolean; activate?: boolean; force?: boolean };
    if (!deps.extensions) return { ok: false, error: "扩展宿主未装配", warnings: [] } satisfies InstallResult;
    let sourcePath = p.sourcePath.trim();
    if (!sourcePath) sourcePath = (await deps.pickExtensionSource?.()) ?? "";
    if (!sourcePath) return { ok: false, canceled: true, error: "已取消选择", warnings: [] } satisfies InstallResult;

    // 安装会替换目录：先停 worker，避免旧代码继续跑；失败后按启用意图恢复。
    for (const id of stoppedIds(deps)) deps.stopExtension?.(id);
    const result = installExtension(
      deps.extensions,
      { path: sourcePath },
      {
        ...(p.allowUntrusted ? { allowUntrusted: true } : {}),
        ...(p.activate !== undefined ? { activate: p.activate } : {}),
        ...(p.force ? { force: true } : {}),
      },
    );
    if (result.ok && result.id && p.activate === true) {
      const enabled = deps.extensions.setEnabled(result.id, true);
      if (!enabled) {
        result.warnings.push(`安装成功，但启用失败：${deps.extensions.lastEnableError ?? "认证未通过"}`);
      }
    }
    if (result.ok) await restartEnabled(deps);
    else await restartEnabled(deps);
    deps.push?.("extensions:updated", { id: result.id, installed: result.ok, version: result.version });
    return result;
  });

  handleTrusted(deps, "extensions:rollback", async (payload) => {
    const p = payload as { id: string; allowUntrusted?: boolean };
    if (!deps.extensions) return { ok: false, error: "扩展宿主未装配", warnings: [] } satisfies InstallResult;
    const wasEnabled = deps.extensions.isEnabledIntent(p.id);
    deps.stopExtension?.(p.id);
    const result = rollbackExtension(deps.extensions, p.id, undefined, {
      activate: wasEnabled,
      ...(p.allowUntrusted ? { allowUntrusted: true } : {}),
    });
    if (result.ok) await restartEnabled(deps);
    else await restartEnabled(deps);
    deps.push?.("extensions:updated", { id: p.id, rolledBack: result.ok, version: result.version });
    return result;
  });

  handleTrusted(deps, "extensions:trustKey", (payload) => {
    const p = payload as { fingerprint: string; publicKey: string; publisher?: string };
    if (!deps.extensions) return { ok: false, error: "扩展宿主未装配" };
    const trusted = deps.extensions.trust().trust(p);
    if (!trusted.ok) return { ok: false, error: trusted.error, trust: trustView() };
    deps.extensions.scan();
    deps.push?.("extensions:updated", { trustChanged: true });
    return { ok: true, trust: trustView() };
  });

  handleTrusted(deps, "extensions:untrustKey", (payload) => {
    const p = payload as { fingerprint: string };
    if (!deps.extensions) return { ok: false, error: "扩展宿主未装配" };
    const removed = deps.extensions.trust().untrust(p.fingerprint);
    deps.extensions.scan();
    // strict 策略下未信任扩展会被 effective disabled；停掉仍在跑的 worker。
    if (deps.extensions.trust().policy() === "strict") {
      for (const item of deps.extensions.list()) {
        if (!item.enabled) deps.stopExtension?.(item.manifest.id);
      }
    }
    deps.push?.("extensions:updated", { trustChanged: true });
    return { ok: removed, trust: trustView() };
  });

  handleTrusted(deps, "extensions:revokeKey", (payload) => {
    const p = payload as { fingerprint: string; reason?: string };
    if (!deps.extensions) return { ok: false, error: "扩展宿主未装配" };
    const result = deps.extensions.trust().revoke(p.fingerprint, p.reason);
    if (!result.ok) return { ok: false, error: result.error, trust: trustView() };
    deps.extensions.scan();
    stopBlocked(deps);
    deps.push?.("extensions:updated", { trustChanged: true });
    return { ok: true, trust: trustView() };
  });

  handleTrusted(deps, "extensions:setPolicy", (payload) => {
    const p = payload as { policy: "warn" | "strict" };
    if (!deps.extensions) return { ok: false, error: "扩展宿主未装配" };
    deps.extensions.trust().setPolicy(p.policy);
    deps.extensions.scan();
    if (p.policy === "strict") {
      for (const item of deps.extensions.list()) {
        if (!item.enabled) deps.stopExtension?.(item.manifest.id);
      }
    }
    deps.push?.("extensions:updated", { trustChanged: true });
    return { ok: true, trust: trustView() };
  });

  handleTrusted(deps, "extensions:verify", (payload) => {
    const p = payload as { id: string };
    if (!deps.extensions) return { ok: false, error: "扩展宿主未装配", extension: null };
    const item = deps.extensions.verify(p.id);
    return item ? { ok: true, extension: item } : { ok: false, error: "扩展不存在", extension: null };
  });

  handleTrusted(deps, "extensions:catalog", async (payload) => {
    const p = (payload ?? {}) as { refresh?: boolean };
    if (!market) return { registryUrl: "", plugins: [], fetchedAt: Date.now() };
    try {
      const catalog = await market.catalog(p.refresh === true);
      // 拉到撤销列表后 host 已重扫；这里再停掉仍在内运行的 blocked worker（kill switch）。
      stopBlocked(deps);
      return catalog;
    } catch (err) {
      deps.audit({ channel: "extensions:catalog", sender: "-", status: "rejected", reason: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  });

  handleTrusted(deps, "extensions:setRegistry", (payload) => {
    const p = payload as { url: string; publicKey?: string };
    if (!deps.configDir) return { ok: false, error: "配置目录未装配" };
    const url = p.url.trim();
    if (url && !/^https?:\/\//i.test(url)) return { ok: false, error: "registry 地址只允许 http(s)" };
    const publicKey = (p.publicKey ?? "").trim();
    if (publicKey) {
      try {
        fingerprintPublicKey(publicKey);
      } catch (err) {
        return { ok: false, error: `市场公钥无法解析：${err instanceof Error ? err.message : String(err)}` };
      }
    }
    savePreferencesPatch(deps.configDir, {
      extensionsRegistryUrl: url,
      ...(p.publicKey !== undefined ? { extensionsRegistryPublicKey: publicKey } : {}),
    });
    deps.push?.("extensions:updated", { registryUrl: url });
    return { ok: true, registryUrl: url, ...(publicKey ? { publicKeyFingerprint: fingerprintPublicKey(publicKey) } : {}) };
  });

  handleTrusted(deps, "extensions:installFromCatalog", async (payload) => {
    const p = payload as { id: string; version?: string; allowUntrusted?: boolean; activate?: boolean };
    if (!market || !deps.extensions) return { ok: false, error: "扩展市场未装配", warnings: [] } satisfies InstallResult;
    for (const id of stoppedIds(deps)) deps.stopExtension?.(id);
    let result: InstallResult;
    try {
      result = await market.install(p.id, p.version, {
        ...(p.allowUntrusted ? { allowUntrusted: true } : {}),
        ...(p.activate !== undefined ? { activate: p.activate } : {}),
      });
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err), warnings: [] };
    }
    if (result.ok && result.id && p.activate === true) {
      const enabled = deps.extensions.setEnabled(result.id, true);
      if (!enabled) result.warnings.push(`安装成功，但启用失败：${deps.extensions.lastEnableError ?? "认证未通过"}`);
    }
    await restartEnabled(deps);
    deps.push?.("extensions:updated", { id: p.id, installed: result.ok, version: result.version });
    return result;
  });

  handleTrusted(deps, "extensions:viewMessage", (payload) => {
    const p = payload as { id: string; viewId: string; message: unknown };
    const ok = deps.sendExtensionViewMessage?.(p.id, p.viewId, p.message) ?? false;
    return { ok };
  });
}
