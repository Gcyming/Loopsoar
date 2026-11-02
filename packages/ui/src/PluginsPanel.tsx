/**
 * 插件管理面板（设置 · 能力 · 插件）：列表 / 启用开关 / 重新扫描 / 错误展示。
 *
 * 数据全部经 window.loopsoarAPI 的 plugin 域（list/setEnabled/reload）+ plugins:updated 事件；
 * 组件不碰 Node、不 import electron。插件运行时由主进程负责（子进程隔离/工具桥接），
 * 面板只呈现状态：builtin（系统根，只读）、loaded（运行中）、disabled、error（含原因）。
 *
 * 「打开插件目录」：契约目前没有 plugin:openDir 通道，因此这里做**特性探测**——
 * 宿主补上该通道（api.plugin.openDir）后按钮自动出现，无需再改本组件；未提供时只显示目录约定提示。
 */
import * as React from "react";
import { BADGE, BRAND } from "./theme.js";
import { Icon } from "./Icon.js";
import { useLoopsoarApi } from "./useLoopsoarApi.js";
import { useT } from "./i18n.js";
import type { LoopsoarAPI, PluginInfo } from "./types.js";

export interface PluginsPanelProps {
  api: LoopsoarAPI | null;
  onNotice?: (text: string) => void;
}

/** 可选能力：契约补上 plugin:openDir 后自动启用「打开插件目录」按钮。 */
interface PluginDirCapable {
  openDir?: () => Promise<{ ok: boolean; dir: string }>;
}

interface PluginSkipItem {
  dir: string;
  reason: string;
}

/** 插件状态 → i18n key（渲染时用 tr 查表，语言切换即时生效）。 */
const STATE_KEY: Record<PluginInfo["state"], string> = {
  loaded: "plugins.state.loaded",
  disabled: "plugins.state.disabled",
  idle: "plugins.state.idle",
  error: "plugins.state.error",
};

function stateStyle(state: PluginInfo["state"]): React.CSSProperties {
  if (state === "loaded") return BADGE.ok;
  if (state === "error") {
    return { ...BADGE.warn, color: BRAND.danger, background: "rgba(248,113,113,0.14)" };
  }
  return BADGE.neutral;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 读可选字段（skipped 等新增字段不在旧类型里时也兼容）。 */
function readSkipped(value: unknown): PluginSkipItem[] {
  if (!value || typeof value !== "object") return [];
  const skipped = (value as { skipped?: unknown }).skipped;
  if (!Array.isArray(skipped)) return [];
  return skipped
    .filter((item): item is PluginSkipItem => Boolean(item) && typeof item === "object" && typeof (item as PluginSkipItem).reason === "string")
    .slice(0, 20);
}

export default function PluginsPanel({ api, onNotice }: PluginsPanelProps): React.ReactElement {
  const fallbackApi = useLoopsoarApi();
  const tr = useT();
  /** 优先用宿主传入的 api（Settings 已持有），独立挂载时回退 preload 暴露的全局 API。 */
  const client = api ?? fallbackApi;

  const [plugins, setPlugins] = React.useState<PluginInfo[]>([]);
  const [skipped, setSkipped] = React.useState<PluginSkipItem[]>([]);
  const [loading, setLoading] = React.useState(false);
  /** 正在操作中的插件 id（或 "reload"/"openDir"）：按钮级防重入。 */
  const [busy, setBusy] = React.useState("");
  const [error, setError] = React.useState("");

  const notify = React.useCallback(
    (text: string): void => {
      onNotice?.(text);
    },
    [onNotice],
  );

  const refresh = React.useCallback(
    async (silent = false): Promise<void> => {
      if (!client) return;
      if (!silent) setLoading(true);
      try {
        const result = await client.plugin.list();
        setPlugins(result?.plugins ?? []);
        setSkipped(readSkipped(result));
        setError("");
      } catch (err) {
        setError(errorText(err));
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [client],
  );

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  // 主进程「启用/停用/重载」后广播 plugins:updated：面板静默重拉，多入口状态一致
  React.useEffect(() => {
    if (!client) return;
    return client.on("plugins:updated", () => {
      void refresh(true);
    });
  }, [client, refresh]);

  const toggle = (plugin: PluginInfo): void => {
    if (!client || plugin.builtin) return;
    setBusy(plugin.id);
    void client.plugin
      .setEnabled({ id: plugin.id, enabled: !plugin.enabled })
      .then((result) => {
        if (result.plugins) setPlugins(result.plugins);
        if (!result.ok) notify(result.error ?? tr("plugins.opFailed"));
        else notify(plugin.enabled ? tr("plugins.disabledNotice", { name: plugin.name }) : tr("plugins.enabledNotice", { name: plugin.name }));
      })
      .catch((err: unknown) => notify(tr("plugins.opError", { error: errorText(err) })))
      .finally(() => setBusy(""));
  };

  const reload = (): void => {
    if (!client) return;
    setBusy("reload");
    void client.plugin
      .reload()
      .then((result) => {
        setPlugins(result?.plugins ?? []);
        setSkipped(readSkipped(result));
        notify(tr("plugins.reloaded"));
      })
      .catch((err: unknown) => notify(tr("plugins.reloadFailed", { error: errorText(err) })))
      .finally(() => setBusy(""));
  };

  const openDir = (): void => {
    const opener = (client?.plugin as unknown as PluginDirCapable | undefined)?.openDir;
    if (!client || typeof opener !== "function") return;
    setBusy("openDir");
    void opener
      .call(client.plugin)
      .then((result) => {
        if (!result?.ok) notify(result?.dir ? tr("plugins.openDirFailedDir", { dir: result.dir }) : tr("plugins.openDirFailed"));
      })
      .catch((err: unknown) => notify(tr("plugins.openDirError", { error: errorText(err) })))
      .finally(() => setBusy(""));
  };

  const dirOpener = (client?.plugin as unknown as PluginDirCapable | undefined)?.openDir;
  const canOpenDir = typeof dirOpener === "function";
  const disabled = Boolean(busy) || !client;

  return (
    <div style={styles.root}>
      <div style={styles.toolbar}>
        <span style={styles.hintInline}>
          {tr("plugins.hintBefore")}
          <code style={styles.code}>plugin__&lt;id&gt;__&lt;tool&gt;</code>
          {tr("plugins.hintAfter")}
        </span>
        <span style={styles.spacer} />
        {canOpenDir ? (
          <button type="button" className="btn-ghost" style={styles.btn} disabled={disabled} onClick={openDir}>
            <Icon name="folders" size={13} /> {busy === "openDir" ? tr("plugins.opening") : tr("plugins.openDirBtn")}
          </button>
        ) : null}
        <button type="button" className="btn-ghost" style={styles.btn} disabled={disabled} onClick={reload}>
          <Icon name="reload" size={13} /> {busy === "reload" ? tr("plugins.scanning") : tr("plugins.rescan")}
        </button>
      </div>

      {error ? <div style={styles.errorLine}>{tr("plugins.loadFailed", { error })}</div> : null}
      {loading && plugins.length === 0 ? <div style={styles.empty}>{tr("plugins.loading")}</div> : null}

      {skipped.length > 0 ? (
        <div style={styles.skippedBox}>
          <div style={styles.skippedTitle}>
            <Icon name="warning" size={13} style={{ color: BRAND.ochreHover }} /> {tr("plugins.skippedTitle", { count: skipped.length })}
          </div>
          {skipped.map((item, index) => (
            <div key={`${item.dir}-${index}`} style={styles.skippedRow}>
              <span style={styles.skippedDir} title={item.dir}>{item.dir}</span>
              <span style={styles.skippedReason}>{item.reason}</span>
            </div>
          ))}
        </div>
      ) : null}

      {plugins.length === 0 && !loading ? (
        <div style={styles.empty}>
          {tr("plugins.emptyBefore")}
          <code style={styles.code}>plugins/&lt;id&gt;/plugin.json</code>
          {tr("plugins.emptyAfter")}
          {canOpenDir ? null : tr("plugins.emptyDirHint")}
        </div>
      ) : null}

      <div style={styles.list}>
        {plugins.map((plugin) => {
          const isBusy = busy === plugin.id;
          return (
            <div key={plugin.id} style={{ ...styles.card, ...(plugin.builtin ? styles.cardBuiltin : {}) }}>
              <div style={styles.cardHead}>
                <Icon name="puzzle" size={15} style={{ color: plugin.builtin ? BRAND.ochre : BRAND.linenMuted }} />
                <span style={styles.name} title={plugin.name}>{plugin.name}</span>
                <span style={styles.version}>v{plugin.version}</span>
                <span style={{ ...BADGE.neutral, ...(plugin.builtin ? { color: BRAND.ochre, borderColor: "rgba(200,118,60,0.45)" } : {}) }}>
                  {plugin.builtin ? tr("plugins.builtin") : tr("plugins.local")}
                </span>
                <span style={stateStyle(plugin.state)}>{tr(STATE_KEY[plugin.state] ?? "plugins.state.idle")}</span>
                <span style={styles.spacer} />
                <button
                  type="button"
                  className={plugin.enabled ? "btn-ghost" : "btn-primary"}
                  style={plugin.enabled ? styles.btn : styles.btnPrimary}
                  disabled={disabled || plugin.builtin}
                  title={
                    plugin.builtin
                      ? tr("plugins.builtinTitle")
                      : plugin.enabled
                        ? tr("plugins.disableTitle")
                        : tr("plugins.enableTitle")
                  }
                  onClick={() => toggle(plugin)}
                >
                  {isBusy ? tr("plugins.working") : plugin.enabled ? tr("plugins.disable") : tr("plugins.enable")}
                </button>
              </div>

              <div style={styles.idLine}>id: {plugin.id}</div>
              {plugin.description ? <div style={styles.desc}>{plugin.description}</div> : null}
              {plugin.state === "error" && plugin.error ? (
                <div style={styles.errorLine}>{tr("plugins.errorLabel", { error: plugin.error })}</div>
              ) : null}
              {plugin.tools.length > 0 ? (
                <div style={styles.toolsRow}>
                  <span style={styles.toolsLabel}>{tr("plugins.tools")}</span>
                  {plugin.tools.slice(0, 8).map((tool) => (
                    <span key={tool.name} style={styles.toolChip} title={tool.description ?? tool.name}>
                      {tool.name}
                    </span>
                  ))}
                  {plugin.tools.length > 8 ? <span style={styles.toolMore}>+{plugin.tools.length - 8}</span> : null}
                </div>
              ) : plugin.enabled && plugin.state !== "disabled" ? (
                <div style={styles.toolsNone}>{plugin.state === "loaded" ? tr("plugins.noTools") : tr("plugins.noRuntimeTools")}</div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div style={styles.footnote}>
        {tr("plugins.footnoteBefore")}
        <code style={styles.code}>plugins/&lt;id&gt;/plugin.json</code>
        {tr("plugins.footnoteAfter")}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: "grid", gap: 10 },
  toolbar: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  hintInline: { fontSize: 11, lineHeight: 1.6, color: BRAND.linenFaint, flex: "1 1 320px", minWidth: 0 },
  spacer: { flex: 1 },
  btn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    padding: "5px 11px",
    borderRadius: 7,
    border: `1px solid ${BRAND.border}`,
    background: "rgba(255,255,255,0.035)",
    color: BRAND.linenMuted,
    fontSize: 12,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  btnPrimary: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    padding: "5px 12px",
    borderRadius: 7,
    border: "1px solid transparent",
    background: BRAND.ochre,
    color: BRAND.ink,
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  code: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 10.5,
    padding: "0 4px",
    borderRadius: 4,
    background: "rgba(255,255,255,0.05)",
    color: BRAND.linenMuted,
  },
  empty: { fontSize: 11.5, lineHeight: 1.7, color: BRAND.linenFaint, padding: "6px 2px" },
  errorLine: { fontSize: 11, lineHeight: 1.6, color: BRAND.danger, wordBreak: "break-word" },
  skippedBox: {
    border: `1px solid rgba(200,118,60,0.35)`,
    borderRadius: 9,
    background: "rgba(200,118,60,0.08)",
    padding: "8px 10px",
    display: "grid",
    gap: 4,
  },
  skippedTitle: { display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 700, color: BRAND.ochreHover },
  skippedRow: { display: "flex", gap: 8, fontSize: 10.5, lineHeight: 1.5, minWidth: 0 },
  skippedDir: {
    color: BRAND.linenFaint,
    flexShrink: 0,
    maxWidth: "40%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  skippedReason: { color: BRAND.linenMuted, minWidth: 0, wordBreak: "break-word" },
  list: { display: "grid", gap: 8 },
  card: {
    border: `1px solid ${BRAND.border}`,
    borderRadius: 10,
    background: "rgba(255,255,255,0.015)",
    padding: "10px 12px",
    display: "grid",
    gap: 5,
  },
  cardBuiltin: { background: "rgba(200,118,60,0.05)", borderColor: "rgba(200,118,60,0.28)" },
  cardHead: { display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" },
  name: { fontSize: 13, fontWeight: 700, color: BRAND.linen, maxWidth: "42%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  version: { fontSize: 10.5, color: BRAND.linenFaint },
  idLine: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 10,
    color: BRAND.linenFaint,
    wordBreak: "break-all",
  },
  desc: { fontSize: 11.5, lineHeight: 1.6, color: BRAND.linenMuted },
  toolsRow: { display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" },
  toolsLabel: { fontSize: 10, color: BRAND.linenFaint, marginRight: 2 },
  toolChip: {
    fontSize: 10,
    padding: "1px 6px",
    borderRadius: 6,
    background: "rgba(94,234,212,0.10)",
    color: BRAND.teal,
    border: "1px solid rgba(94,234,212,0.22)",
  },
  toolMore: { fontSize: 10, color: BRAND.linenFaint },
  toolsNone: { fontSize: 10.5, color: BRAND.linenFaint },
  footnote: { fontSize: 10, lineHeight: 1.6, color: BRAND.linenFaint, borderTop: `1px solid ${BRAND.border}`, paddingTop: 6 },
};
