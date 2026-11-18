/**
 * 设置 · 扩展：扩展列表、启停/卸载与运行状态。数据由本组件自取，避免设置页
 * 把所有扩展运行态都塞进顶层 state；外部只通过 onError 接收失败提示。
 */
import * as React from "react";
import { BADGE, BRAND } from "./theme.js";
import { useT } from "./i18n.js";
import { useLoopsoarApi } from "./useLoopsoarApi.js";
import type { ExtensionRuntimeStatus, InstalledExtension } from "./types.js";

const S = {
  note: { fontSize: 11.5, color: BRAND.linenFaint, lineHeight: 1.7, marginBottom: 8 },
  code: { fontFamily: "ui-monospace, Consolas, monospace", fontSize: 11, color: BRAND.linenMuted, marginLeft: 6 },
  btns: { display: "flex", alignItems: "center", gap: 10, paddingTop: 12, flexWrap: "wrap" as const },
  btn: {
    padding: "6px 12px",
    borderRadius: 7,
    border: `1px solid ${BRAND.borderStrong}`,
    background: "transparent",
    color: BRAND.linenMuted,
    fontSize: 12.5,
    cursor: "pointer",
  },
  btnSmall: { padding: "3px 8px", fontSize: 11.5 },
  errText: { fontSize: 11.5, color: BRAND.danger, lineHeight: 1.6, marginTop: 4 },
  dashed: { border: `1px dashed ${BRAND.border}`, borderRadius: 10, padding: 20, color: BRAND.linenFaint, fontSize: 12, textAlign: "center" as const },
  card: { border: `1px solid ${BRAND.border}`, borderRadius: 10, padding: 12, marginBottom: 10, background: BRAND.inkPanel },
  rowBetween: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 6 },
  meta: { display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" as const },
  metaTitle: { fontSize: 13, fontWeight: 700, color: BRAND.linen },
  tag: { fontSize: 10.5, color: BRAND.linenFaint, border: `1px solid ${BRAND.border}`, borderRadius: 999, padding: "1px 7px" },
  icons: { display: "flex", alignItems: "center", gap: 6 },
  providerVal: { color: BRAND.linen, fontFamily: "ui-monospace, Consolas, monospace", fontSize: 11, wordBreak: "break-all" as const },
  providerRows: { display: "flex", flexDirection: "column" as const, gap: 4, marginTop: 6 },
  providerRow: { display: "flex", gap: 8, fontSize: 11.5 },
  providerKey: { width: 54, flexShrink: 0, color: BRAND.linenFaint },
  toggle: {
    width: 40,
    height: 22,
    borderRadius: 11,
    border: `1px solid ${BRAND.borderStrong}`,
    background: BRAND.ink,
    padding: 2,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    transition: "background 140ms, border-color 140ms",
  },
  toggleOn: { background: BRAND.ochre, borderColor: BRAND.ochre },
  knob: { width: 16, height: 16, borderRadius: "50%", background: BRAND.linenMuted, transition: "transform 140ms ease, background 140ms" },
  knobOn: { transform: "translateX(18px)", background: BRAND.ink },
};

function Head({ title, hint }: { title: string; hint: string }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: BRAND.linen }}>{title}</div>
      <div style={S.note}>{hint}</div>
    </div>
  );
}

function Btn({ label, onClick, small }: { label: string; onClick: () => void; small?: boolean }) {
  return <button type="button" style={{ ...S.btn, ...(small ? S.btnSmall : {}) }} onClick={onClick}>{label}</button>;
}

function Toggle({ value, onChange }: { value: boolean; onChange: (next: boolean) => void }) {
  return (
    <button type="button" style={{ ...S.toggle, ...(value ? S.toggleOn : {}) }} onClick={() => onChange(!value)} aria-pressed={value}>
      <span style={{ ...S.knob, ...(value ? S.knobOn : {}) }} />
    </button>
  );
}

export interface ExtensionsSectionProps {
  onError: (message: string) => void;
}

export default function ExtensionsSection({ onError }: ExtensionsSectionProps): React.ReactElement {
  const api = useLoopsoarApi();
  const tr = useT();
  const [extensions, setExtensions] = React.useState<InstalledExtension[]>([]);
  const [runtime, setRuntime] = React.useState<Record<string, ExtensionRuntimeStatus>>({});
  const [dir, setDir] = React.useState("");
  const [skips, setSkips] = React.useState<{ dir: string; reason: string }[]>([]);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async (): Promise<void> => {
    if (!api) return;
    const result = await api.extensions.list();
    setExtensions(result.extensions);
    setDir(result.dir);
    setSkips(result.skipped);
    setRuntime(result.runtime ?? {});
  }, [api]);

  React.useEffect(() => {
    void load().finally(() => setLoading(false));
  }, [load]);

  React.useEffect(() => {
    if (!api) return;
    return api.on("extensions:updated", () => void load().catch(() => {}));
  }, [api, load]);

  const run = (action: () => Promise<unknown>): void => {
    void action()
      .then(load)
      .catch((err) => onError(err instanceof Error ? err.message : String(err)));
  };

  return (
    <div>
      <Head title={tr("settings.extensions.head")} hint={tr("settings.extensions.headHint")} />
      <div style={S.note}>{tr("settings.extensions.dir")}<code style={S.code}>{dir || "—"}</code></div>
      <div style={S.btns}>
        <Btn
          label={tr("settings.extensions.openDir")}
          onClick={() => {
            if (!api) return;
            void api.extensions.openDir().then((r) => {
              if (!r.ok) onError(tr("settings.extensions.openFailed", { dir: r.dir }));
            }).catch((err) => onError(err instanceof Error ? err.message : String(err)));
          }}
        />
        <Btn label={tr("settings.rescan")} onClick={() => run(load)} />
      </div>
      {skips.length > 0 ? (
        <div style={S.note}>
          {tr("settings.extensions.skipped", { count: skips.length })}
          {skips.map((item) => <div key={item.dir} style={S.errText}>{tr("settings.skipItem", { path: item.dir, reason: item.reason })}</div>)}
        </div>
      ) : null}
      {loading ? <div style={S.note}>…</div> : extensions.length === 0 ? (
        <div style={S.dashed}>{tr("settings.extensions.empty")}</div>
      ) : (
        extensions.map((ext) => {
          const status = runtime[ext.manifest.id] ?? { state: "idle", tools: [] };
          const statusLabel =
            status.state === "ready"
              ? tr("settings.extensions.loaded", { count: status.tools.length })
              : status.state === "starting"
                ? tr("settings.extensions.starting")
                : status.state === "error"
                  ? tr("settings.extensions.loadFailed", { error: status.error ?? tr("settings.unknown") })
                  : ext.manifest.main
                    ? tr("settings.extensions.notStarted")
                    : tr("settings.extensions.declarative");
          return (
            <div key={ext.manifest.id} className="panel-card" style={S.card}>
              <div style={S.rowBetween}>
                <span style={S.meta}>
                  <span style={S.metaTitle}>{ext.manifest.name}</span>
                  <span style={BADGE.neutral}>v{ext.manifest.version}</span>
                  {ext.manifest.author ? <span style={S.tag}>{ext.manifest.author}</span> : null}
                </span>
                <span style={S.icons}>
                  <label style={S.tag}><Toggle value={ext.enabled} onChange={(next) => run(() => api!.extensions.setEnabled({ id: ext.manifest.id, enabled: next }))} /></label>
                  {ext.manifest.main ? (
                    status.state === "ready" ? (
                      <Btn label={tr("settings.stop")} small onClick={() => run(() => api!.extensions.stop({ id: ext.manifest.id }))} />
                    ) : (
                      <Btn label={tr("settings.start")} small onClick={() => run(() => api!.extensions.start({ id: ext.manifest.id }))} />
                    )
                  ) : null}
                  <Btn label={tr("settings.uninstall")} small onClick={() => run(() => api!.extensions.remove({ id: ext.manifest.id }))} />
                </span>
              </div>
              {ext.manifest.description ? <div style={S.providerVal}>{ext.manifest.description}</div> : null}
              <div style={S.providerRows}>
                {ext.manifest.permissions && ext.manifest.permissions.length > 0 ? (
                  <div style={S.providerRow}><span style={S.providerKey}>{tr("settings.extensions.permissions")}</span><span style={S.providerVal}>{ext.manifest.permissions.join(" · ")}</span></div>
                ) : null}
                {ext.manifest.contributes?.commands && ext.manifest.contributes.commands.length > 0 ? (
                  <div style={S.providerRow}><span style={S.providerKey}>{tr("settings.extensions.commands")}</span><span style={S.providerVal}>{ext.manifest.contributes.commands.map((command) => `/${ext.manifest.id}.${command.id}`).join(" · ")}</span></div>
                ) : null}
                {ext.manifest.contributes?.instructions ? (
                  <div style={S.providerRow}><span style={S.providerKey}>{tr("settings.extensions.instructions")}</span><span style={S.providerVal}>{tr("settings.bytes", { bytes: ext.manifest.contributes.instructions.length })}</span></div>
                ) : null}
                {ext.manifest.contributes?.hooks?.length ? (
                  <div style={S.providerRow}><span style={S.providerKey}>hooks</span><span style={S.providerVal}>{ext.manifest.contributes.hooks.map((hook) => hook.event).join(" · ")}</span></div>
                ) : null}
                {ext.manifest.contributes?.ui?.map((panel) => (
                  <div key={panel.id} style={{ marginTop: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: BRAND.linen }}>{panel.title}</div>
                    {panel.description ? <div style={S.note}>{panel.description}</div> : null}
                    {panel.items?.map((item) => (
                      <div key={`${panel.id}-${item.label}`} style={S.providerRow}>
                        <span style={S.providerKey}>{item.label}</span>
                        <span style={S.providerVal}>{item.value}</span>
                      </div>
                    ))}
                  </div>
                ))}
                <div style={S.providerRow}><span style={S.providerKey}>{tr("settings.extensions.run")}</span><span style={status.state === "error" ? S.errText : S.providerVal}>{statusLabel}</span></div>
                {status.tools.length ? <div style={S.providerRow}><span style={S.providerKey}>{tr("settings.extensions.tools")}</span><span style={S.providerVal}>{status.tools.join(" · ")}</span></div> : null}
                <div style={S.providerRow}><span style={S.providerKey}>{tr("settings.extensions.dirRow")}</span><span style={S.providerVal}>{ext.dir}</span></div>
              </div>
            </div>
          );
        })
      )}
      <div style={S.note}>{tr("settings.extensions.isolation")}</div>
    </div>
  );
}
