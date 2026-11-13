/**
 * 设置 · 浏览器扩展：安装/查看/卸载 Chrome/Edge 系扩展。
 *
 * 兼容性说明（Electron 官方子集）：
 *   · 支持未打包扩展（manifest v2/v3 的常见能力：content_scripts、background、storage、
 *     scripting、webRequest、devtools 等，详见 Electron Chrome Extension Support 文档）；
 *   · 不支持 Chrome 应用商店的全部 API；安装失败会在卡片上展示原因。
 */
import * as React from "react";
import { BRAND } from "./theme.js";
import { Icon } from "./Icon.js";
import { useT } from "./i18n.js";
import { useLoopsoarApi } from "./useLoopsoarApi.js";
import type { BrowserExtensionInfo } from "./types.js";

const S = {
  intro: { fontSize: 12, color: BRAND.linenMuted, lineHeight: 1.7, marginBottom: 14 },
  row: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" as const, marginBottom: 12 },
  input: {
    flex: 1,
    minWidth: 220,
    height: 30,
    padding: "0 10px",
    borderRadius: 8,
    border: `1px solid ${BRAND.border}`,
    background: BRAND.inkRaised,
    color: BRAND.linen,
    fontSize: 12,
    outline: "none",
  },
  btn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    height: 30,
    padding: "0 12px",
    borderRadius: 8,
    border: `1px solid ${BRAND.border}`,
    background: BRAND.inkRaised,
    color: BRAND.linen,
    fontSize: 12,
    cursor: "pointer",
  },
  btnPrimary: { borderColor: "rgba(200,118,60,0.55)", background: "rgba(200,118,60,0.16)", color: BRAND.ochreHover },
  card: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 6,
    padding: "10px 12px",
    marginTop: 8,
    borderRadius: 10,
    border: `1px solid ${BRAND.border}`,
    background: BRAND.inkRaised,
  },
  name: { fontSize: 12.5, fontWeight: 600, color: BRAND.linen, display: "flex", alignItems: "center", gap: 8 },
  meta: { fontSize: 11, color: BRAND.linenFaint, display: "flex", gap: 10, flexWrap: "wrap" as const },
  badge: { fontSize: 10, padding: "1px 6px", borderRadius: 999, border: `1px solid ${BRAND.border}`, color: BRAND.linenMuted },
  badgeErr: { color: BRAND.danger, borderColor: "rgba(248,113,113,0.45)" },
  notice: { fontSize: 11.5, color: BRAND.ochreHover, marginTop: 8, lineHeight: 1.6 },
  err: { fontSize: 11.5, color: BRAND.danger, marginTop: 8, lineHeight: 1.6 },
  empty: { padding: "16px 0", fontSize: 12, color: BRAND.linenFaint },
  ghostBtn: { ...{ border: "none", background: "transparent", color: BRAND.linenFaint, fontSize: 11, cursor: "pointer", padding: 2 } },
};

function sourceLabel(source: BrowserExtensionInfo["source"], tr: (k: string) => string): string {
  if (source === "store") return tr("settings.browserExtensions.sourceStore");
  if (source === "folder") return tr("settings.browserExtensions.sourceFolder");
  return tr("settings.browserExtensions.sourceBundled");
}

export default function BrowserExtensionsSection({ onOpenUrl }: { onOpenUrl?: (url: string) => void } = {}): React.ReactElement {
  const api = useLoopsoarApi();
  const tr = useT();
  const [items, setItems] = React.useState<BrowserExtensionInfo[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [storeUrl, setStoreUrl] = React.useState("");
  const [notice, setNotice] = React.useState<{ ok: boolean; text: string } | null>(null);

  /** 打开商店：优先交给上层（离开设置、直接显示页面）；独立使用时退回新标签页。 */
  const openStore = React.useCallback((url: string): void => {
    if (onOpenUrl) onOpenUrl(url);
    else void api?.browser.newTab({ url }).catch(() => undefined);
  }, [api, onOpenUrl]);

  const refresh = React.useCallback(async (): Promise<void> => {
    try {
      const result = await api?.browser.listExtensions();
      setItems(Array.isArray(result?.extensions) ? result.extensions : []);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [api]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const installFolder = async (): Promise<void> => {
    if (!api) return;
    const picked = await api.dialog.pickPath({ kind: "directory", title: tr("settings.browserExtensions.pickFolder") });
    if (picked.canceled || !picked.path) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await api.browser.installExtension({ path: picked.path });
      setNotice(result.ok ? { ok: true, text: tr("settings.browserExtensions.installed", { name: result.extension?.name ?? "" }) } : { ok: false, text: result.error ?? tr("settings.browserExtensions.failed") });
      await refresh();
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const installStore = async (): Promise<void> => {
    if (!api || !storeUrl.trim()) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await api.browser.installExtension({ url: storeUrl.trim() });
      setNotice(result.ok ? { ok: true, text: tr("settings.browserExtensions.installed", { name: result.extension?.name ?? "" }) } : { ok: false, text: result.error ?? tr("settings.browserExtensions.failed") });
      if (result.ok) setStoreUrl("");
      await refresh();
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (item: BrowserExtensionInfo): Promise<void> => {
    if (!api) return;
    if (!window.confirm(tr("settings.browserExtensions.removeConfirm", { name: item.name }))) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await api.browser.removeExtension({ id: item.id });
      setNotice(result.ok ? { ok: true, text: tr("settings.browserExtensions.removed", { name: item.name }) } : { ok: false, text: result.error ?? tr("settings.browserExtensions.failed") });
      await refresh();
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="settings-browser-extensions">
      <div style={S.intro}>{tr("settings.browserExtensions.intro")}</div>
      <div style={S.row}>
        <button
          type="button"
          style={{ ...S.btn, ...S.btnPrimary }}
          onClick={() => openStore("https://chromewebstore.google.com/")}
          data-testid="extension-open-store"
          data-variant="primary"
        >
          <Icon name="globe" size={13} />
          {tr("settings.browserExtensions.openStore")}
        </button>
        <button
          type="button"
          style={S.btn}
          onClick={() => openStore("https://microsoftedge.microsoft.com/addons/Microsoft-Edge-Extensions-Home")}
          data-testid="extension-open-edge-store"
        >
          <Icon name="browser-plugin" size={13} />
          {tr("settings.browserExtensions.openEdgeStore")}
        </button>
        <button type="button" style={S.btn} disabled={busy} onClick={() => void installFolder()} data-testid="extension-folder-install">
          <Icon name="folder" size={13} />
          {tr("settings.browserExtensions.installFolder")}
        </button>
      </div>
      <div style={{ ...S.intro, margin: "2px 0 8px" }}>{tr("settings.browserExtensions.orPaste")}</div>
      <div style={S.row}>
        <input
          style={S.input}
          value={storeUrl}
          onChange={(event) => setStoreUrl(event.target.value)}
          placeholder={tr("settings.browserExtensions.storePlaceholder")}
          data-testid="extension-store-input"
        />
        <button
          type="button"
          style={{ ...S.btn, opacity: busy ? 0.6 : 1 }}
          disabled={busy || !storeUrl.trim()}
          onClick={() => void installStore()}
          data-testid="extension-store-install"
        >
          <Icon name="cloud-upload" size={13} />
          {busy ? tr("settings.browserExtensions.working") : tr("settings.browserExtensions.installStore")}
        </button>
      </div>
      {notice ? <div style={notice.ok ? S.notice : S.err} data-testid="extension-notice">{notice.text}</div> : null}

      <div style={{ fontSize: 12, fontWeight: 600, color: BRAND.linen, marginTop: 16 }}>
        {tr("settings.browserExtensions.installedTitle", { count: items.length })}
      </div>
      {loading ? <div style={S.empty}>{tr("settings.browserExtensions.loading")}</div> : null}
      {!loading && items.length === 0 ? <div style={S.empty} data-testid="extension-empty">{tr("settings.browserExtensions.empty")}</div> : null}
      {items.map((item) => (
        <div key={item.id} style={S.card} data-testid={`extension-card-${item.id}`}>
          <div style={S.name}>
            <span>{item.name}</span>
            <span style={S.badge}>v{item.version}</span>
            <span style={S.badge}>{sourceLabel(item.source, tr)}</span>
            <span style={{ ...S.badge, ...(item.enabled ? null : S.badgeErr) }}>
              {item.enabled ? tr("settings.browserExtensions.enabled") : tr("settings.browserExtensions.disabled")}
            </span>
          </div>
          {item.description ? <div style={S.meta}>{item.description}</div> : null}
          <div style={S.meta}>
            <span>ID: {item.id}</span>
            <span>Manifest v{item.manifestVersion}</span>
            {item.dir ? <span title={item.dir}>{item.dir}</span> : null}
          </div>
          {item.error ? <div style={S.err}>{tr("settings.browserExtensions.loadError", { error: item.error })}</div> : null}
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button type="button" style={S.ghostBtn} disabled={busy} onClick={() => void remove(item)} data-testid={`extension-remove-${item.id}`}>
              {tr("settings.browserExtensions.remove")}
            </button>
          </div>
        </div>
      ))}
      <div style={S.intro}>{tr("settings.browserExtensions.compatNote")}</div>
    </div>
  );
}
