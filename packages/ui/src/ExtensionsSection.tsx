/**
 * 设置 · 扩展：扩展列表、市场安装、兼容性/信任/依赖状态、启停与富 UI 面板。
 * 数据由本组件自取；外部只通过 onError 接收失败提示。
 */
import * as React from "react";
import { BADGE, BRAND } from "./theme.js";
import { useT } from "./i18n.js";
import { useLoopsoarApi } from "./useLoopsoarApi.js";
import { ExtensionViewFrame } from "./ExtensionViewFrame.js";
import type {
  ExtensionCatalogView,
  ExtensionContributionsState,
  ExtensionInstallResultView,
  ExtensionRuntimeStatus,
  ExtensionTrustStateView,
  InstalledExtension,
} from "./types.js";

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
  btnPrimary: { borderColor: BRAND.ochre, color: BRAND.ochre, fontWeight: 600 },
  btnSmall: { padding: "3px 8px", fontSize: 11.5 },
  input: {
    flex: 1,
    minWidth: 220,
    padding: "6px 9px",
    borderRadius: 7,
    border: `1px solid ${BRAND.border}`,
    background: BRAND.ink,
    color: BRAND.linen,
    fontSize: 12,
    fontFamily: "ui-monospace, Consolas, monospace",
  },
  errText: { fontSize: 11.5, color: BRAND.danger, lineHeight: 1.6, marginTop: 4 },
  okText: { fontSize: 11.5, color: BRAND.teal, lineHeight: 1.6, marginTop: 4 },
  warnText: { fontSize: 11.5, color: BRAND.ochre, lineHeight: 1.6, marginTop: 4 },
  dashed: { border: `1px dashed ${BRAND.border}`, borderRadius: 10, padding: 20, color: BRAND.linenFaint, fontSize: 12, textAlign: "center" as const },
  card: { border: `1px solid ${BRAND.border}`, borderRadius: 10, padding: 12, marginBottom: 10, background: BRAND.inkPanel },
  cardBlocked: { borderColor: BRAND.danger },
  sectionCard: { border: `1px solid ${BRAND.border}`, borderRadius: 10, padding: 12, marginBottom: 12, background: BRAND.ink },
  rowBetween: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 6 },
  meta: { display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" as const },
  metaTitle: { fontSize: 13, fontWeight: 700, color: BRAND.linen },
  tag: { fontSize: 10.5, color: BRAND.linenFaint, border: `1px solid ${BRAND.border}`, borderRadius: 999, padding: "1px 7px" },
  icons: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" as const, justifyContent: "flex-end" },
  providerVal: { color: BRAND.linen, fontFamily: "ui-monospace, Consolas, monospace", fontSize: 11, wordBreak: "break-all" as const },
  providerRows: { display: "flex", flexDirection: "column" as const, gap: 4, marginTop: 6 },
  providerRow: { display: "flex", gap: 8, fontSize: 11.5 },
  providerKey: { width: 64, flexShrink: 0, color: BRAND.linenFaint },
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
  trustBadge: {
    fontSize: 10.5,
    padding: "2px 7px",
    borderRadius: 999,
    border: `1px solid ${BRAND.danger}`,
    color: BRAND.danger,
  },
};

const CERT_STYLE: Record<string, React.CSSProperties> = {
  certified: { ...BADGE.ok, fontWeight: 700 },
  compatible: { ...BADGE.neutral, color: BRAND.linenMuted },
  unverified: { ...BADGE.warn },
  blocked: { ...BADGE.warn, color: BRAND.danger, background: "rgba(200,80,70,0.12)" },
};

function Head({ title, hint }: { title: string; hint: string }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: BRAND.linen }}>{title}</div>
      <div style={S.note}>{hint}</div>
    </div>
  );
}

function Btn({
  label,
  onClick,
  small,
  primary,
  disabled,
}: {
  label: string;
  onClick: () => void;
  small?: boolean;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      style={{ ...S.btn, ...(small ? S.btnSmall : {}), ...(primary ? S.btnPrimary : {}), opacity: disabled ? 0.5 : 1 }}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (next: boolean) => void }) {
  return (
    <button type="button" style={{ ...S.toggle, ...(value ? S.toggleOn : {}) }} onClick={() => onChange(!value)} aria-pressed={value}>
      <span style={{ ...S.knob, ...(value ? S.knobOn : {}) }} />
    </button>
  );
}

type PendingTrust =
  | { kind: "file"; sourcePath: string; force?: boolean; trust: NonNullable<ExtensionInstallResultView["requiresTrust"]> }
  | { kind: "catalog"; id: string; version?: string; trust: NonNullable<ExtensionInstallResultView["requiresTrust"]> }
  | { kind: "rollback"; id: string; trust: NonNullable<ExtensionInstallResultView["requiresTrust"]> };

export interface ExtensionsSectionProps {
  onError: (message: string) => void;
}

export default function ExtensionsSection({ onError }: ExtensionsSectionProps): React.ReactElement {
  const api = useLoopsoarApi();
  const tr = useT();
  const [extensions, setExtensions] = React.useState<InstalledExtension[]>([]);
  const [runtime, setRuntime] = React.useState<Record<string, ExtensionRuntimeStatus>>({});
  const [contributions, setContributions] = React.useState<ExtensionContributionsState | null>(null);
  const [trust, setTrust] = React.useState<ExtensionTrustStateView | null>(null);
  const [dir, setDir] = React.useState("");
  const [skips, setSkips] = React.useState<{ dir: string; reason: string }[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState("");
  const [pending, setPending] = React.useState<PendingTrust | null>(null);
  const [openView, setOpenView] = React.useState<{ id: string; viewId: string } | null>(null);
  const [catalog, setCatalog] = React.useState<ExtensionCatalogView | null>(null);
  const [registryInput, setRegistryInput] = React.useState("");
  const [registryKeyInput, setRegistryKeyInput] = React.useState("");
  const [marketError, setMarketError] = React.useState("");
  const [marketBusy, setMarketBusy] = React.useState(false);

  const load = React.useCallback(async (): Promise<void> => {
    if (!api) return;
    const result = await api.extensions.list();
    setExtensions(result.extensions);
    setDir(result.dir);
    setSkips(result.skipped);
    setRuntime(result.runtime ?? {});
    setContributions(result.contributions ?? null);
    setTrust(result.trust ?? null);
    setRegistryInput((current) => current || result.market?.registryUrl || "");
    setRegistryKeyInput((current) => current || result.market?.publicKey || "");
  }, [api]);

  const loadCatalog = React.useCallback(
    async (refresh: boolean): Promise<void> => {
      if (!api) return;
      setMarketBusy(true);
      setMarketError("");
      try {
        const result = await api.extensions.catalog({ refresh });
        setCatalog(result);
        setRegistryInput((current) => current || result.registryUrl || "");
      } catch (err) {
        setMarketError(err instanceof Error ? err.message : String(err));
      } finally {
        setMarketBusy(false);
      }
    },
    [api],
  );

  React.useEffect(() => {
    void load()
      .catch((err) => onError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [load, onError]);

  React.useEffect(() => {
    void loadCatalog(false);
  }, [loadCatalog]);

  React.useEffect(() => {
    if (!api) return;
    return api.on("extensions:updated", () => void load().catch(() => undefined));
  }, [api, load]);

  const run = (action: () => Promise<unknown>): void => {
    setBusy(true);
    void action()
      .then(load)
      .catch((err) => onError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  const toggle = (ext: InstalledExtension, enabled: boolean): void => {
    if (!api) return;
    setBusy(true);
    void api.extensions
      .setEnabled({ id: ext.manifest.id, enabled })
      .then(async (result) => {
        if (!result.ok) {
          onError(tr("settings.extensions.enableFailed", { error: result.error ?? tr("settings.unknown") }));
        } else {
          if (result.autoEnabled?.length) setNotice(tr("settings.extensions.autoEnabled", { ids: result.autoEnabled.join(", ") }));
          if (result.cascadeDisabled?.length) setNotice(tr("settings.extensions.cascadeDisabled", { ids: result.cascadeDisabled.join(", ") }));
        }
        await load();
      })
      .catch((err) => onError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  const handleInstallResult = async (result: ExtensionInstallResultView, pendingState: PendingTrust | null): Promise<void> => {
    if (result.ok) {
      setPending(null);
      setNotice(tr("settings.extensions.installDone", { name: result.id ?? "", version: result.version ?? "" }));
      await load();
      await loadCatalog(false);
      return;
    }
    if (result.canceled) {
      setNotice(tr("settings.extensions.installCanceled"));
      return;
    }
    if (result.requiresTrust && pendingState) {
      setPending(pendingState);
      return;
    }
    // 信任后重试仍失败：清除待确认，避免 UI 卡在弹层。
    setPending(null);
    onError(tr("settings.extensions.installFailed", { error: result.error ?? tr("settings.unknown") }));
  };

  const installFile = (): void => {
    if (!api) return;
    setBusy(true);
    void api.extensions
      .install({ sourcePath: "", activate: true })
      .then(async (result) => {
        const state: PendingTrust | null = result.requiresTrust
          ? { kind: "file", sourcePath: result.sourcePath ?? "", trust: result.requiresTrust }
          : null;
        await handleInstallResult(result, state);
      })
      .catch((err) => onError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  const installFromCatalog = (id: string, version?: string): void => {
    if (!api) return;
    setBusy(true);
    void api.extensions
      .installFromCatalog({ id, version, activate: true })
      .then(async (result) => {
        const state: PendingTrust | null = result.requiresTrust
          ? { kind: "catalog", id, version, trust: result.requiresTrust }
          : null;
        await handleInstallResult(result, state);
      })
      .catch((err) => onError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  const confirmPending = (): void => {
    if (!api || !pending) return;
    setBusy(true);
    const retry = async (): Promise<ExtensionInstallResultView> => {
      if (pending.kind === "file") {
        return api.extensions.install({ sourcePath: pending.sourcePath, activate: true, allowUntrusted: true, force: pending.force });
      }
      if (pending.kind === "rollback") {
        return api.extensions.rollback({ id: pending.id, allowUntrusted: true });
      }
      return api.extensions.installFromCatalog({
        id: pending.id,
        version: pending.version,
        activate: true,
        allowUntrusted: true,
      });
    };
    void (async () => {
      if (pending.trust.fingerprint) {
        const trusted = await api.extensions.trustKey({
          fingerprint: pending.trust.fingerprint,
          publicKey: pending.trust.publicKey,
          publisher: pending.trust.publisher,
        });
        if (!trusted.ok) {
          onError(trusted.error ?? tr("settings.extensions.installFailed", { error: "trust" }));
          return;
        }
        setTrust(trusted.trust ?? null);
      }
      const result = await retry();
      await handleInstallResult(result, null);
    })()
      .catch((err) => onError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  const trustExtension = (ext: InstalledExtension): void => {
    if (!api) return;
    const signature = ext.manifest.signature;
    const fingerprint = ext.info?.trust.fingerprint;
    if (!signature || !fingerprint) return;
    setBusy(true);
    void api.extensions
      .trustKey({ fingerprint, publicKey: signature.publicKey, publisher: ext.manifest.author })
      .then((result) => {
        if (!result.ok) onError(result.error ?? tr("settings.unknown"));
        setTrust(result.trust ?? null);
        return load();
      })
      .catch((err) => onError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  const rollback = (ext: InstalledExtension): void => {
    if (!api) return;
    setBusy(true);
    void api.extensions
      .rollback({ id: ext.manifest.id })
      .then(async (result) => {
        if (result.ok) {
          setNotice(tr("settings.extensions.rollbackDone", { version: result.version ?? "" }));
          await load();
          return;
        }
        if (result.requiresTrust) {
          setPending({ kind: "rollback", id: ext.manifest.id, trust: result.requiresTrust });
          return;
        }
        onError(tr("settings.extensions.installFailed", { error: result.error ?? tr("settings.unknown") }));
      })
      .catch((err) => onError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  const counts = React.useMemo(() => {
    const result = { total: extensions.length, certified: 0, unverified: 0, blocked: 0 };
    for (const ext of extensions) {
      const cert = ext.info?.certification ?? "compatible";
      if (cert === "certified") result.certified += 1;
      else if (cert === "blocked") result.blocked += 1;
      else if (cert === "unverified") result.unverified += 1;
    }
    return result;
  }, [extensions]);

  return (
    <div>
      <Head title={tr("settings.extensions.head")} hint={tr("settings.extensions.headHint")} />
      <div style={S.note}>
        {tr("settings.extensions.dir")}
        <code style={S.code}>{dir || "—"}</code>
      </div>
      <div style={S.note}>{tr("settings.extensions.stats", counts)}</div>
      <div style={S.btns}>
        <Btn label={tr("settings.extensions.install")} primary onClick={installFile} disabled={busy} />
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
      <div style={S.note}>{tr("settings.extensions.installHint")}</div>
      {notice ? <div style={S.okText}>{notice}</div> : null}
      {skips.length > 0 ? (
        <div style={S.note}>
          {tr("settings.extensions.skipped", { count: skips.length })}
          {skips.map((item) => (
            <div key={item.dir} style={S.errText}>
              {tr("settings.skipItem", { path: item.dir, reason: item.reason })}
            </div>
          ))}
        </div>
      ) : null}

      {pending ? (
        <div style={{ ...S.sectionCard, borderColor: BRAND.ochre }}>
          <div style={S.rowBetween}>
            <span style={S.metaTitle}>{tr("settings.extensions.confirmTrustTitle")}</span>
            <span style={S.tag}>{pending.trust.publisher ?? tr("settings.extensions.publisher")}</span>
          </div>
          <div style={S.warnText}>
            {pending.trust.fingerprint
              ? tr("settings.extensions.confirmTrustSignature")
              : tr("settings.extensions.confirmTrustUnsigned")}
          </div>
          {pending.trust.fingerprint ? (
            <div style={S.providerRow}>
              <span style={S.providerKey}>{tr("settings.extensions.fingerprint")}</span>
              <span style={S.providerVal}>{pending.trust.fingerprint}</span>
            </div>
          ) : null}
          <div style={S.btns}>
            <Btn
              label={
                pending.trust.fingerprint
                  ? tr("settings.extensions.confirmTrustAllow")
                  : tr("settings.extensions.confirmTrustUnsignedAllow")
              }
              primary
              disabled={busy}
              onClick={confirmPending}
            />
            <Btn label={tr("settings.extensions.confirmTrustCancel")} onClick={() => setPending(null)} />
          </div>
        </div>
      ) : null}

      {loading ? <div style={S.note}>…</div> : extensions.length === 0 ? (
        <div style={S.dashed}>{tr("settings.extensions.empty")}</div>
      ) : (
        extensions.map((ext) => {
          const status = runtime[ext.manifest.id] ?? { state: "idle", tools: [] };
          const info = ext.info;
          const cert = info?.certification ?? "compatible";
          const trustInfo = info?.trust;
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
          const views = ext.manifest.contributes?.views ?? [];
          const activeView = openView?.id === ext.manifest.id ? openView : null;
          return (
            <div key={ext.manifest.id} className="panel-card" style={{ ...S.card, ...(cert === "blocked" ? S.cardBlocked : {}) }}>
              <div style={S.rowBetween}>
                <span style={S.meta}>
                  <span style={S.metaTitle}>{ext.manifest.name}</span>
                  <span style={BADGE.neutral}>v{ext.manifest.version}</span>
                  <span style={CERT_STYLE[cert] ?? BADGE.neutral}>{tr(`settings.extensions.${cert}`)}</span>
                  <span style={S.tag}>API {ext.manifest.apiVersion}</span>
                  {ext.manifest.author ? <span style={S.tag}>{ext.manifest.author}</span> : null}
                  {trustInfo && trustInfo.status !== "trusted" ? (
                    <span style={trustInfo.status === "invalid" ? S.trustBadge : BADGE.warn}>
                      {tr(
                        trustInfo.status === "invalid"
                          ? "settings.extensions.invalidSignature"
                          : trustInfo.status === "untrusted"
                            ? "settings.extensions.untrusted"
                            : "settings.extensions.unsigned",
                      )}
                    </span>
                  ) : null}
                </span>
                <span style={S.icons}>
                  <label style={S.tag}>
                    <Toggle value={ext.enabled} onChange={(next) => toggle(ext, next)} />
                  </label>
                  {ext.manifest.main && ext.enabled ? (
                    status.state === "ready" ? (
                      <Btn label={tr("settings.stop")} small onClick={() => run(() => api!.extensions.stop({ id: ext.manifest.id }))} />
                    ) : (
                      <Btn label={tr("settings.start")} small onClick={() => run(() => api!.extensions.start({ id: ext.manifest.id }))} />
                    )
                  ) : null}
                  {info?.version?.previous ? <Btn label={tr("settings.extensions.rollback")} small onClick={() => rollback(ext)} /> : null}
                  <Btn label={tr("settings.extensions.verify")} small onClick={() => run(() => api!.extensions.verify({ id: ext.manifest.id }))} />
                  {trustInfo?.fingerprint && trustInfo.status !== "trusted" ? (
                    <Btn label={tr("settings.extensions.trustKey")} small onClick={() => trustExtension(ext)} />
                  ) : null}
                  <Btn label={tr("settings.uninstall")} small onClick={() => run(() => api!.extensions.remove({ id: ext.manifest.id }))} />
                </span>
              </div>
              {ext.manifest.description ? <div style={S.providerVal}>{ext.manifest.description}</div> : null}
              {info ? (
                <div style={S.providerRows}>
                  <div style={S.providerRow}>
                    <span style={S.providerKey}>{tr("settings.extensions.engine")}</span>
                    <span style={S.providerVal}>
                      {info.compatibility.engineRange ?? "—"} · host {info.compatibility.hostVersion} / API {info.compatibility.hostApiVersion}
                    </span>
                  </div>
                  {info.dependencies.dependents.length > 0 ? (
                    <div style={S.providerRow}>
                      <span style={S.providerKey}>{tr("settings.extensions.dependents")}</span>
                      <span style={S.providerVal}>{info.dependencies.dependents.join(" · ")}</span>
                    </div>
                  ) : null}
                  {info.dependencies.issues.length > 0 ? (
                    <div style={S.providerRow}>
                      <span style={S.providerKey}>{tr("settings.extensions.dependencies")}</span>
                      <span style={S.errText}>{info.dependencies.issues.join(" · ")}</span>
                    </div>
                  ) : null}
                  {info.compatibility.issues.length > 0 ? (
                    <div style={S.providerRow}>
                      <span style={S.providerKey}>{tr("settings.extensions.issues")}</span>
                      <span style={info.compatibility.errors > 0 ? S.errText : S.warnText}>
                        {info.compatibility.issues.map((issue) => issue.message).join(" · ")}
                      </span>
                    </div>
                  ) : null}
                  {trustInfo?.fingerprint ? (
                    <div style={S.providerRow}>
                      <span style={S.providerKey}>{tr("settings.extensions.fingerprint")}</span>
                      <span style={S.providerVal}>
                        {trustInfo.fingerprint} · {tr(`settings.extensions.${trustInfo.status}`)}
                      </span>
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div style={S.providerRows}>
                {ext.manifest.permissions && ext.manifest.permissions.length > 0 ? (
                  <div style={S.providerRow}>
                    <span style={S.providerKey}>{tr("settings.extensions.permissions")}</span>
                    <span style={S.providerVal}>{ext.manifest.permissions.join(" · ")}</span>
                  </div>
                ) : null}
                {ext.manifest.contributes?.commands && ext.manifest.contributes.commands.length > 0 ? (
                  <div style={S.providerRow}>
                    <span style={S.providerKey}>{tr("settings.extensions.commands")}</span>
                    <span style={S.providerVal}>
                      {ext.manifest.contributes.commands.map((command) => `/${ext.manifest.id}.${command.id}`).join(" · ")}
                    </span>
                  </div>
                ) : null}
                {ext.manifest.contributes?.instructions ? (
                  <div style={S.providerRow}>
                    <span style={S.providerKey}>{tr("settings.extensions.instructions")}</span>
                    <span style={S.providerVal}>
                      {tr("settings.bytes", { bytes: ext.manifest.contributes.instructions.length })}
                    </span>
                  </div>
                ) : null}
                {ext.manifest.contributes?.hooks?.length ? (
                  <div style={S.providerRow}>
                    <span style={S.providerKey}>hooks</span>
                    <span style={S.providerVal}>{ext.manifest.contributes.hooks.map((hook) => hook.event).join(" · ")}</span>
                  </div>
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
                {views.length > 0 ? (
                  <div style={S.providerRow}>
                    <span style={S.providerKey}>{tr("settings.extensions.views")}</span>
                    <span style={{ ...S.meta, gap: 6 }}>
                      {views.map((view) => (
                        <button
                          key={view.id}
                          type="button"
                          style={{ ...S.btn, ...S.btnSmall }}
                          disabled={!ext.enabled}
                          onClick={() =>
                            setOpenView((current) =>
                              current?.id === ext.manifest.id && current.viewId === view.id
                                ? null
                                : { id: ext.manifest.id, viewId: view.id },
                            )
                          }
                        >
                          {view.title}
                        </button>
                      ))}
                    </span>
                  </div>
                ) : null}
                <div style={S.providerRow}>
                  <span style={S.providerKey}>{tr("settings.extensions.run")}</span>
                  <span style={status.state === "error" ? S.errText : S.providerVal}>{statusLabel}</span>
                </div>
                {ext.info?.revocation ? (
                  <div style={S.providerRow}>
                    <span style={S.providerKey}>{tr("settings.extensions.revokedRow")}</span>
                    <span style={S.errText}>{ext.info.revocation.reason}</span>
                  </div>
                ) : null}
                {status.tools.length ? (
                  <div style={S.providerRow}>
                    <span style={S.providerKey}>{tr("settings.extensions.tools")}</span>
                    <span style={S.providerVal}>{status.tools.join(" · ")}</span>
                  </div>
                ) : null}
                <div style={S.providerRow}>
                  <span style={S.providerKey}>{tr("settings.extensions.dirRow")}</span>
                  <span style={S.providerVal}>{ext.dir}</span>
                </div>
              </div>
              {activeView ? (
                <>
                  <ExtensionViewFrame
                    api={api!}
                    extensionId={ext.manifest.id}
                    viewId={activeView.viewId}
                    title={views.find((view) => view.id === activeView.viewId)?.title ?? activeView.viewId}
                    entry={views.find((view) => view.id === activeView.viewId)?.entry ?? "index.html"}
                    defaultHeight={views.find((view) => view.id === activeView.viewId)?.height ?? 420}
                    onClose={() => setOpenView(null)}
                  />
                  <div style={S.note}>{tr("settings.extensions.viewSandbox")}</div>
                </>
              ) : null}
            </div>
          );
        })
      )}

      <div className="panel-card" style={S.sectionCard}>
        <div style={S.rowBetween}>
          <span style={S.metaTitle}>{tr("settings.extensions.market")}</span>
          <Btn
            label={tr("settings.extensions.refreshMarket")}
            small
            disabled={marketBusy}
            onClick={() => void loadCatalog(true)}
          />
        </div>
        <div style={S.note}>{tr("settings.extensions.marketHint")}</div>
        <div style={S.btns}>
          <input
            style={S.input}
            value={registryInput}
            placeholder={tr("settings.extensions.registryPlaceholder")}
            onChange={(event) => setRegistryInput(event.target.value)}
          />
          <Btn
            label={tr("settings.extensions.saveRegistry")}
            small
            disabled={busy || !registryInput.trim()}
            onClick={() => {
              if (!api) return;
              setBusy(true);
              void api.extensions
                .setRegistry({ url: registryInput.trim(), publicKey: registryKeyInput.trim() })
                .then(async (result) => {
                  if (!result.ok) onError(result.error ?? tr("settings.unknown"));
                  await loadCatalog(true);
                })
                .catch((err) => onError(err instanceof Error ? err.message : String(err)))
                .finally(() => setBusy(false));
            }}
          />
        </div>
        <input
          style={{ ...S.input, marginTop: 6 }}
          value={registryKeyInput}
          placeholder={tr("settings.extensions.registryKeyPlaceholder")}
          onChange={(event) => setRegistryKeyInput(event.target.value)}
        />
        <div style={S.note}>{tr("settings.extensions.registryKeyHint")}</div>
        {catalog?.signature ? (
          <div style={S.note}>
            {tr("settings.extensions.registrySignature", {
              status: tr(`settings.extensions.signature.${catalog.signature.status}`),
              fingerprint: catalog.signature.fingerprint ?? "-",
            })}
            {catalog.revoked ? ` · ${tr("settings.extensions.registryRevoked", { count: String(catalog.revoked) })}` : ""}
          </div>
        ) : null}
        {marketError ? <div style={S.errText}>{tr("settings.extensions.marketFailed", { error: marketError })}</div> : null}
        {marketBusy ? <div style={S.note}>…</div> : null}
        {!marketBusy && (!catalog || catalog.plugins.length === 0) ? (
          <div style={S.dashed}>{tr("settings.extensions.marketEmpty")}</div>
        ) : null}
        {catalog?.plugins.map((plugin) => {
          const latest = plugin.latestVersion;
          const installed = plugin.installedVersion;
          const update = plugin.updateAvailable && latest;
          return (
            <div key={plugin.id} style={{ borderTop: `1px solid ${BRAND.border}`, paddingTop: 8, marginTop: 8 }}>
              <div style={S.rowBetween}>
                <span style={S.meta}>
                  <span style={{ ...S.metaTitle, fontSize: 12.5 }}>{plugin.name}</span>
                  <span style={S.tag}>{plugin.id}</span>
                  {plugin.publisher ? <span style={S.tag}>{plugin.publisher}</span> : null}
                  {latest ? <span style={S.tag}>{tr("settings.extensions.latestVersion", { version: latest })}</span> : null}
                  {installed ? <span style={BADGE.neutral}>{tr("settings.extensions.installedVersion", { version: installed })}</span> : null}
                </span>
                {update ? (
                  <Btn
                    label={tr("settings.extensions.update", { version: latest })}
                    small
                    primary
                    disabled={busy}
                    onClick={() => installFromCatalog(plugin.id, latest)}
                  />
                ) : installed ? null : (
                  <Btn
                    label={tr("settings.extensions.install")}
                    small
                    primary
                    disabled={busy || !latest}
                    onClick={() => installFromCatalog(plugin.id, latest)}
                  />
                )}
              </div>
              {plugin.description ? <div style={S.note}>{plugin.description}</div> : null}
            </div>
          );
        })}
      </div>

      <div className="panel-card" style={S.sectionCard}>
        <div style={S.rowBetween}>
          <span style={S.metaTitle}>{tr("settings.extensions.trust")}</span>
          <span style={S.meta}>
            <span style={S.tag}>{tr("settings.extensions.trustPolicy")}</span>
            <Btn
              label={tr("settings.extensions.trustWarn")}
              small
              disabled={busy || trust?.policy === "warn"}
              onClick={() => {
                if (!api) return;
                void api.extensions.setPolicy({ policy: "warn" }).then((r) => setTrust(r.trust ?? null)).catch((err) => onError(String(err)));
              }}
            />
            <Btn
              label={tr("settings.extensions.trustStrict")}
              small
              disabled={busy || trust?.policy === "strict"}
              onClick={() => {
                if (!api) return;
                void api.extensions.setPolicy({ policy: "strict" }).then((r) => setTrust(r.trust ?? null)).catch((err) => onError(String(err)));
              }}
            />
          </span>
        </div>
        <div style={S.note}>{tr("settings.extensions.trustHint")}</div>
        {trust?.keys.length ? (
          trust.keys.map((key) => (
            <div key={key.fingerprint} style={{ ...S.providerRow, alignItems: "center" }}>
              <span style={{ ...S.providerVal, flex: 1 }}>
                {key.fingerprint}
                {key.publisher ? ` · ${key.publisher}` : ""}
                {key.revokedAt ? (
                  <span style={{ ...BADGE.warn, marginLeft: 6 }}>{tr("settings.extensions.keyRevoked")}</span>
                ) : key.notAfter && key.notAfter < Date.now() ? (
                  <span style={{ ...BADGE.warn, marginLeft: 6 }}>{tr("settings.extensions.keyExpired")}</span>
                ) : null}
              </span>
              {!key.revokedAt ? (
                <Btn
                  label={tr("settings.extensions.revokeKey")}
                  small
                  onClick={() => {
                    if (!api) return;
                    void api.extensions
                      .revokeKey({ fingerprint: key.fingerprint, reason: "用户手动撤销" })
                      .then((r) => {
                        if (!r.ok) onError(r.error ?? tr("settings.unknown"));
                        setTrust(r.trust ?? null);
                        return load();
                      })
                      .catch((err) => onError(String(err)));
                  }}
                />
              ) : null}
              <Btn
                label={tr("settings.extensions.untrustKey")}
                small
                onClick={() => {
                  if (!api) return;
                  void api.extensions
                    .untrustKey({ fingerprint: key.fingerprint })
                    .then((r) => {
                      setTrust(r.trust ?? null);
                      return load();
                    })
                    .catch((err) => onError(String(err)));
                }}
              />
            </div>
          ))
        ) : (
          <div style={S.note}>{tr("settings.extensions.noKeys")}</div>
        )}
      </div>

      {contributions &&
      (contributions.loops.length > 0 || contributions.themes.length > 0 || contributions.conflicts.length > 0) ? (
        <div className="panel-card" style={S.card}>
          <div style={S.rowBetween}>
            <span style={S.metaTitle}>{tr("settings.extensions.contributions")}</span>
            <span style={S.tag}>{tr("settings.extensions.contributionsHint")}</span>
          </div>
          {contributions.loops.map((loop) => (
            <div key={loop.id} style={S.providerRow}>
              <span style={S.providerKey}>{tr("settings.extensions.loops")}</span>
              <span style={S.providerVal}>
                {loop.name} · {loop.extensionName} · {loop.id}
              </span>
            </div>
          ))}
          {contributions.themes.map((theme) => (
            <div key={theme.id} style={S.providerRow}>
              <span style={S.providerKey}>{tr("settings.extensions.themes")}</span>
              <span style={S.providerVal}>
                {theme.name} · {theme.extensionName} · {theme.id}
              </span>
            </div>
          ))}
          {contributions.conflicts.map((conflict) => (
            <div key={conflict} style={S.errText}>
              {conflict}
            </div>
          ))}
        </div>
      ) : null}
      <div style={S.note}>{tr("settings.extensions.isolation")}</div>
    </div>
  );
}
