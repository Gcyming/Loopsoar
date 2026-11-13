/**
 * 设置 · 终端环境：自检终端配置档与常见 CLI 依赖。
 *
 * 目的：让用户清楚看到「本机有哪些 shell / 解释器 / 工具链、版本、是否能为 Loopsoar 终端所用」，
 * 缺什么按 installHint 安装后点「重新检测」。探测由主进程 terminal:diagnose 完成（只读、5s 超时）。
 */
import * as React from "react";
import { BRAND } from "./theme.js";
import { Icon } from "./Icon.js";
import { useT } from "./i18n.js";
import { useLoopsoarApi } from "./useLoopsoarApi.js";
import type { TerminalDiagnostics } from "./types.js";

const S = {
  intro: { fontSize: 12, color: BRAND.linenMuted, lineHeight: 1.7, marginBottom: 14 },
  summary: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" as const, marginBottom: 12 },
  pill: { fontSize: 11, padding: "2px 8px", borderRadius: 999, border: `1px solid ${BRAND.border}`, color: BRAND.linenMuted },
  okPill: { color: BRAND.teal, borderColor: "rgba(45,212,191,0.4)" },
  errPill: { color: BRAND.danger, borderColor: "rgba(248,113,113,0.45)" },
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
  table: { display: "flex", flexDirection: "column" as const, gap: 6, marginTop: 10 },
  row: {
    display: "grid",
    gridTemplateColumns: "minmax(110px, 0.9fr) 70px minmax(120px, 1.4fr) minmax(180px, 2fr)",
    gap: 8,
    alignItems: "center",
    padding: "8px 10px",
    borderRadius: 9,
    border: `1px solid ${BRAND.border}`,
    background: BRAND.inkRaised,
    fontSize: 11.5,
  },
  head: { fontSize: 10.5, color: BRAND.linenFaint, letterSpacing: 0.3 },
  name: { color: BRAND.linen, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 },
  version: { color: BRAND.linenMuted, fontFamily: "ui-monospace, Consolas, monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  hint: { color: BRAND.linenFaint, lineHeight: 1.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  errHint: { color: BRAND.danger, lineHeight: 1.5 },
  sectionTitle: { fontSize: 12, fontWeight: 600, color: BRAND.linen, marginTop: 18 },
  notice: { fontSize: 11.5, color: BRAND.ochreHover, marginTop: 10, lineHeight: 1.6 },
  err: { fontSize: 11.5, color: BRAND.danger, marginTop: 10, lineHeight: 1.6 },
};

export default function TerminalDiagnosticsSection(): React.ReactElement {
  const api = useLoopsoarApi();
  const tr = useT();
  const [data, setData] = React.useState<TerminalDiagnostics | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async (): Promise<void> => {
    if (!api) return;
    setLoading(true);
    setError(null);
    try {
      setData(await api.terminal.diagnose());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [api]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const shellProfiles = data?.profiles.filter((profile) => profile.kind === "shell") ?? [];
  const otherProfiles = data?.profiles.filter((profile) => profile.kind !== "shell") ?? [];

  return (
    <div data-testid="settings-terminal-env">
      <div style={S.intro}>{tr("settings.terminalEnv.intro")}</div>
      <div style={S.summary}>
        {data ? (
          <>
            <span style={S.pill}>{`${data.platform} · ${data.arch} · ${data.release}`}</span>
            <span style={S.pill}>{tr("settings.terminalEnv.defaultShell", { shell: data.defaultShell })}</span>
            <span style={{ ...S.pill, ...(data.ready ? S.okPill : S.errPill) }}>
              {data.ready ? tr("settings.terminalEnv.ready") : tr("settings.terminalEnv.notReady")}
            </span>
          </>
        ) : null}
        <button type="button" style={{ ...S.btn, marginLeft: "auto" }} disabled={loading} onClick={() => void refresh()} data-testid="terminal-env-recheck">
          <Icon name="reload" size={13} />
          {loading ? tr("settings.terminalEnv.checking") : tr("settings.terminalEnv.recheck")}
        </button>
      </div>
      {error ? <div style={S.err}>{tr("settings.terminalEnv.checkFailed", { error })}</div> : null}

      <div style={S.sectionTitle}>{tr("settings.terminalEnv.shells")}</div>
      <div style={S.table}>
        <div style={{ ...S.row, ...S.head, background: "transparent", borderColor: "transparent" }}>
          <span>{tr("settings.terminalEnv.colProfile")}</span>
          <span>{tr("settings.terminalEnv.colStatus")}</span>
          <span>{tr("settings.terminalEnv.colVersion")}</span>
          <span>{tr("settings.terminalEnv.colHint")}</span>
        </div>
        {shellProfiles.map((profile) => (
          <div key={profile.key} style={S.row} data-testid={`terminal-profile-${profile.key}`}>
            <span style={S.name}>
              <Icon name="terminal" size={12} />
              {profile.label}
            </span>
            <span style={profile.available ? S.okPill : S.errPill}>{profile.available ? tr("settings.terminalEnv.available") : tr("settings.terminalEnv.missing")}</span>
            <span style={S.version} title={profile.description}>{profile.version ?? "—"}</span>
            <span style={profile.available ? S.hint : S.errHint} title={profile.detail ?? profile.description}>{profile.available ? profile.description : profile.detail ?? profile.description}</span>
          </div>
        ))}
      </div>

      <div style={S.sectionTitle}>{tr("settings.terminalEnv.runtimes")}</div>
      <div style={S.table}>
        {otherProfiles.map((profile) => (
          <div key={profile.key} style={S.row} data-testid={`terminal-profile-${profile.key}`}>
            <span style={S.name}>
              <Icon name="terminal" size={12} />
              {profile.label}
            </span>
            <span style={profile.available ? S.okPill : S.errPill}>{profile.available ? tr("settings.terminalEnv.available") : tr("settings.terminalEnv.missing")}</span>
            <span style={S.version} title={profile.description}>{profile.version ?? "—"}</span>
            <span style={profile.available ? S.hint : S.errHint} title={profile.detail ?? profile.description}>{profile.available ? profile.description : profile.detail ?? profile.description}</span>
          </div>
        ))}
      </div>

      <div style={S.sectionTitle}>{tr("settings.terminalEnv.cliTools")}</div>
      <div style={S.table}>
        {(data?.tools ?? []).map((tool) => (
          <div key={tool.key} style={S.row} data-testid={`terminal-tool-${tool.key}`}>
            <span style={S.name}>
              <Icon name="terminal" size={12} />
              {tool.label}
            </span>
            <span style={tool.available ? S.okPill : S.errPill}>{tool.available ? tr("settings.terminalEnv.available") : tr("settings.terminalEnv.missing")}</span>
            <span style={S.version} title={tool.version}>{tool.version ?? tool.command}</span>
            <span style={tool.available ? S.hint : S.errHint} title={tool.installHint}>{tool.available ? tool.command : tool.installHint}</span>
          </div>
        ))}
      </div>
      <div style={S.intro}>{tr("settings.terminalEnv.note")}</div>
    </div>
  );
}
