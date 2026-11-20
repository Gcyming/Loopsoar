/**
 * 设置 · 运行轨迹：只读展示当前会话的 trace（工具耗时/失败、token、估算成本）。
 * 拆成独立组件的原因：Settings.tsx 已接近 1500 行守卫，读取与渲染逻辑不该继续堆在设置页。
 */
import * as React from "react";
import { BRAND } from "./theme.js";
import { useT } from "./i18n.js";
import type { LoopsoarAPI, TraceReportView } from "./types.js";

const S = {
  box: { border: `1px solid ${BRAND.border}`, borderRadius: 10, padding: 12, marginTop: 12, background: BRAND.inkPanel },
  title: { fontSize: 13, fontWeight: 700, color: BRAND.linen, marginBottom: 6 },
  hint: { fontSize: 11.5, color: BRAND.linenFaint, lineHeight: 1.7, marginBottom: 8 },
  chips: { display: "flex", flexWrap: "wrap" as const, gap: 8, marginBottom: 10 },
  chip: { border: `1px solid ${BRAND.border}`, borderRadius: 8, padding: "6px 9px", minWidth: 92 },
  chipKey: { fontSize: 10.5, color: BRAND.linenFaint },
  chipVal: { fontSize: 14, fontWeight: 700, color: BRAND.linen, fontFamily: "ui-monospace, Consolas, monospace" },
  btn: {
    padding: "5px 11px",
    borderRadius: 7,
    border: `1px solid ${BRAND.borderStrong}`,
    background: "transparent",
    color: BRAND.linenMuted,
    fontSize: 12,
    cursor: "pointer",
  },
  table: { width: "100%", borderCollapse: "collapse" as const, fontSize: 11.5 },
  th: { textAlign: "left" as const, color: BRAND.linenFaint, fontWeight: 600, padding: "3px 6px", borderBottom: `1px solid ${BRAND.border}` },
  td: { padding: "3px 6px", borderBottom: `1px solid ${BRAND.border}`, color: BRAND.linenMuted },
  mono: { fontFamily: "ui-monospace, Consolas, monospace", fontSize: 11 },
  event: { display: "flex", gap: 8, alignItems: "baseline", padding: "3px 0", borderBottom: `1px solid ${BRAND.border}` },
  time: { width: 62, flexShrink: 0, color: BRAND.linenFaint, fontFamily: "ui-monospace, Consolas, monospace", fontSize: 10.5 },
  kind: { width: 38, flexShrink: 0, fontSize: 10.5, color: BRAND.linenFaint },
  bad: { color: BRAND.danger },
  note: { fontSize: 10.5, color: BRAND.linenFaint, lineHeight: 1.6, marginTop: 8 },
  err: { fontSize: 11.5, color: BRAND.danger, lineHeight: 1.6 },
};

function money(value: number): string {
  if (!value) return "—";
  return `$${value < 0.01 ? value.toFixed(6) : value.toFixed(4)}`;
}

function clock(at: number): string {
  const d = new Date(at);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

export default function TraceSection({ api }: { api?: LoopsoarAPI }): React.ReactElement {
  const tr = useT();
  const [report, setReport] = React.useState<TraceReportView | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      const state = await api.chat.sessions();
      if (!state.currentId) {
        setReport(null);
        setError(tr("settings.traces.noSession"));
        return;
      }
      setReport(await api.settings.traces({ sessionId: state.currentId, limit: 50 }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [api, tr]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const summary = report?.summary;
  const costKnown = summary && (summary.inputTokens > 0 || summary.outputTokens > 0) && summary.costUsd > 0;
  const topTools = summary?.byTool.slice(0, 8) ?? [];
  const events = (report?.records ?? []).slice(-20).reverse();

  return (
    <div style={S.box}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={S.title}>{tr("settings.traces.head")}</div>
        <button type="button" style={S.btn} onClick={() => void load()} disabled={busy}>
          {busy ? tr("settings.traces.loading") : tr("settings.traces.refresh")}
        </button>
      </div>
      <div style={S.hint}>{tr("settings.traces.headHint")}</div>
      {error ? <div style={S.err}>{error}</div> : null}
      {!error && summary ? (
        <>
          <div style={S.chips}>
            <div style={S.chip}><div style={S.chipKey}>{tr("settings.traces.turns")}</div><div style={S.chipVal}>{summary.turns}</div></div>
            <div style={S.chip}><div style={S.chipKey}>{tr("settings.traces.tools")}</div><div style={S.chipVal}>{summary.toolCalls}</div></div>
            <div style={S.chip}><div style={S.chipKey}>{tr("settings.traces.failures")}</div><div style={{ ...S.chipVal, ...(summary.failures > 0 ? S.bad : {}) }}>{summary.failures}</div></div>
            <div style={S.chip}><div style={S.chipKey}>{tr("settings.traces.tokens")}</div><div style={S.chipVal}>{summary.tokens.toLocaleString()}</div></div>
            <div style={S.chip}><div style={S.chipKey}>{tr("settings.traces.cost")}</div><div style={S.chipVal}>{money(summary.costUsd)}</div></div>
          </div>
          <div style={S.hint}>
            {tr("settings.traces.model")}：<code style={S.mono}>{summary.model ?? "—"}</code>
            {" · "}
            {tr("settings.traces.split", { input: summary.inputTokens.toLocaleString(), output: summary.outputTokens.toLocaleString() })}
            {!costKnown && summary.tokens > 0 ? ` · ${tr("settings.traces.noPrice")}` : ""}
          </div>
          {summary.lastError ? <div style={S.err}>{tr("settings.traces.lastError")}：{summary.lastError}</div> : null}
          {topTools.length > 0 ? (
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>{tr("settings.traces.tool")}</th>
                  <th style={S.th}>{tr("settings.traces.calls")}</th>
                  <th style={S.th}>{tr("settings.traces.failed")}</th>
                  <th style={S.th}>{tr("settings.traces.avg")}</th>
                  <th style={S.th}>{tr("settings.traces.max")}</th>
                </tr>
              </thead>
              <tbody>
                {topTools.map((tool) => (
                  <tr key={tool.tool}>
                    <td style={{ ...S.td, ...S.mono }}>{tool.tool}</td>
                    <td style={S.td}>{tool.calls}</td>
                    <td style={{ ...S.td, ...(tool.failures > 0 ? S.bad : {}) }}>{tool.failures}</td>
                    <td style={S.td}>{tool.avgMs} ms</td>
                    <td style={S.td}>{tool.maxMs} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          <div style={{ ...S.title, marginTop: 12 }}>{tr("settings.traces.events")}</div>
          {events.length === 0 ? <div style={S.hint}>{tr("settings.traces.empty")}</div> : null}
          {events.map((event, index) => (
            <div key={`${event.at}-${index}`} style={S.event}>
              <span style={S.time}>{clock(event.at)}</span>
              <span style={S.kind}>{tr(`settings.traces.kind.${event.kind}`)}</span>
              <span style={{ ...S.mono, color: event.ok === false ? BRAND.danger : BRAND.linenMuted }}>
                {event.tool ?? event.error ?? event.note ?? "—"}
                {event.ms !== undefined ? ` · ${event.ms} ms` : ""}
                {event.kind === "turn" && event.costUsd !== undefined ? ` · ${money(event.costUsd)}` : ""}
              </span>
              {event.args ? <span style={{ ...S.hint, margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{event.args}</span> : null}
            </div>
          ))}
          <div style={S.note}>{report!.pricingNote}</div>
        </>
      ) : null}
    </div>
  );
}
