/**
 * 定时任务（自动巡航）设置页。
 *
 * 产品定位不是「再做一个 cron」：任务在**新会话**里运行，完成后保留完整轨迹与结果会话，
 * 用户可回看 Agent 当时怎么做的；关闭窗口到托盘后调度器仍常驻，这是桌面端才有的顺手体验。
 */
import * as React from "react";
import { BRAND } from "./theme.js";
import { useT } from "./i18n.js";
import { Area, Btn, Field, Head, In, Seg } from "./settingsUi.js";
import type { LoopsoarAPI } from "./types.js";
import type { ScheduleInput, ScheduleListResult, ScheduleRun, ScheduledTask } from "./scheduleTypes.js";

const WEEKDAYS: { id: number; key: string }[] = [
  { id: 1, key: "settings.schedule.mon" },
  { id: 2, key: "settings.schedule.tue" },
  { id: 3, key: "settings.schedule.wed" },
  { id: 4, key: "settings.schedule.thu" },
  { id: 5, key: "settings.schedule.fri" },
  { id: 6, key: "settings.schedule.sat" },
  { id: 7, key: "settings.schedule.sun" },
];

function blank(): ScheduleInput {
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return { title: "", prompt: "", frequency: "daily", time, date, weekdays: [1, 2, 3, 4, 5], enabled: true };
}

function asInput(task: ScheduledTask): ScheduleInput {
  return {
    id: task.id,
    title: task.title,
    prompt: task.prompt,
    frequency: task.frequency,
    time: task.time,
    ...(task.date ? { date: task.date } : {}),
    ...(task.weekdays ? { weekdays: task.weekdays } : {}),
    enabled: task.enabled,
  };
}

function fmt(ts?: number | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function SchedulesSection({ api, onError }: { api: LoopsoarAPI | null; onError: (err: unknown) => void }): React.JSX.Element {
  const tr = useT();
  const [data, setData] = React.useState<ScheduleListResult>({ tasks: [], runs: [], timezoneOffsetMinutes: 0 });
  const [form, setForm] = React.useState<ScheduleInput>(blank);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState("");

  const refresh = React.useCallback(async (): Promise<void> => {
    if (!api) return;
    try {
      setData(await api.schedule.list());
    } catch (err) {
      onError(err);
    }
  }, [api, onError]);

  React.useEffect(() => {
    void refresh();
    if (!api) return undefined;
    const off = api.on("schedule:updated", () => void refresh());
    return () => off?.();
  }, [api, refresh]);

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const save = (): void => {
    if (!api) return;
    if (!form.title.trim() || !form.prompt.trim()) {
      setNotice(tr("settings.schedule.needTitlePrompt"));
      return;
    }
    if (form.frequency === "once" && !form.date) {
      setNotice(tr("settings.schedule.needDate"));
      return;
    }
    if (form.frequency === "weekly" && !(form.weekdays ?? []).length) {
      setNotice(tr("settings.schedule.needWeekday"));
      return;
    }
    void run(async () => {
      const result = await api.schedule.save(form);
      if (!result.ok) {
        setNotice(result.error ?? tr("settings.schedule.saveFailed"));
        return;
      }
      setForm(blank());
      setEditing(null);
      setNotice(tr("settings.schedule.saved"));
      await refresh();
    });
  };

  const edit = (task: ScheduledTask): void => {
    setEditing(task.id);
    setForm(asInput(task));
    setNotice("");
  };

  const toggle = (task: ScheduledTask): void => {
    if (!api) return;
    void run(async () => {
      const result = await api.schedule.save({ ...asInput(task), enabled: !task.enabled });
      if (!result.ok) setNotice(result.error ?? tr("settings.schedule.saveFailed"));
      await refresh();
    });
  };

  const remove = (task: ScheduledTask): void => {
    if (!api) return;
    if (!window.confirm(tr("settings.schedule.confirmDelete", { title: task.title }))) return;
    void run(async () => {
      await api.schedule.delete({ id: task.id });
      if (editing === task.id) {
        setEditing(null);
        setForm(blank());
      }
      await refresh();
    });
  };

  const runNow = (task: ScheduledTask): void => {
    if (!api) return;
    void run(async () => {
      const result = await api.schedule.run({ id: task.id });
      setNotice(result.accepted ? tr("settings.schedule.runStarted") : result.error ?? tr("settings.schedule.runFailed"));
      await refresh();
    });
  };

  return (
    <div>
      <Head t={tr("settings.schedule.head")} h={tr("settings.schedule.headHint")} />

      <div style={styles.card}>
        <div style={styles.cardHead}>
          <strong style={styles.title}>{editing ? tr("settings.schedule.editTitle") : tr("settings.schedule.newTitle")}</strong>
          {editing ? (
            <Btn
              label={tr("settings.schedule.cancel")}
              small
              onClick={() => {
                setEditing(null);
                setForm(blank());
              }}
            />
          ) : null}
        </div>
        <Field l={tr("settings.schedule.title")}>
          <In v={form.title} ph={tr("settings.schedule.titlePh")} on={(v) => setForm({ ...form, title: v })} />
        </Field>
        <Field l={tr("settings.schedule.prompt")} h={tr("settings.schedule.promptHint")}>
          <Area v={form.prompt} rows={4} wide full ph={tr("settings.schedule.promptPh")} on={(v) => setForm({ ...form, prompt: v })} />
        </Field>
        <Field l={tr("settings.schedule.frequency")}>
          <Seg
            v={form.frequency}
            opts={[
              ["once", tr("settings.schedule.freqOnce")],
              ["daily", tr("settings.schedule.freqDaily")],
              ["weekdays", tr("settings.schedule.freqWeekdays")],
              ["weekly", tr("settings.schedule.freqWeekly")],
            ]}
            on={(v) => setForm({ ...form, frequency: v as ScheduleInput["frequency"] })}
          />
        </Field>
        <div style={styles.row}>
          {form.frequency === "once" ? (
            <Field l={tr("settings.schedule.date")}>
              <In v={form.date ?? ""} type="date" on={(v) => setForm({ ...form, date: v })} />
            </Field>
          ) : null}
          <Field l={tr("settings.schedule.time")}>
            <In v={form.time} type="time" on={(v) => setForm({ ...form, time: v })} />
          </Field>
        </div>
        {form.frequency === "weekly" ? (
          <Field l={tr("settings.schedule.weekdays")}>
            <div style={styles.days}>
              {WEEKDAYS.map((day) => {
                const active = (form.weekdays ?? []).includes(day.id);
                return (
                  <button
                    key={day.id}
                    type="button"
                    aria-pressed={active}
                    style={{ ...styles.day, ...(active ? styles.dayActive : {}) }}
                    onClick={() => {
                      const current = new Set(form.weekdays ?? []);
                      if (current.has(day.id)) current.delete(day.id);
                      else current.add(day.id);
                      setForm({ ...form, weekdays: [...current].sort((a, b) => a - b) });
                    }}
                  >
                    {tr(day.key)}
                  </button>
                );
              })}
            </div>
          </Field>
        ) : null}
        <div style={styles.actions}>
          <button
            type="button"
            style={{ ...styles.primary, opacity: busy ? 0.6 : 1 }}
            disabled={busy}
            onClick={save}
          >
            {editing ? tr("settings.schedule.saveEdit") : tr("settings.schedule.create")}
          </button>
          <span style={styles.muted}>{tr("settings.schedule.localTime")}</span>
        </div>
        {notice ? <div style={styles.notice}>{notice}</div> : null}
      </div>

      <div style={styles.sectionTitle}>{tr("settings.schedule.listTitle")}</div>
      {data.tasks.length === 0 ? (
        <div style={styles.empty}>{tr("settings.schedule.empty")}</div>
      ) : (
        <div style={styles.list}>
          {data.tasks.map((task) => (
            <div key={task.id} style={styles.task}>
              <div style={styles.taskMain}>
                <div style={styles.taskTop}>
                  <span style={{ ...styles.dot, background: task.enabled ? BRAND.ochre : BRAND.linenFaint }} />
                  <strong style={styles.taskTitle}>{task.title}</strong>
                  <span style={styles.badge}>{recurrenceLabel(task, tr)}</span>
                  {task.lastStatus === "running" ? <span style={styles.badge}>{tr("settings.schedule.running")}</span> : null}
                </div>
                <div style={styles.meta}>
                  {tr("settings.schedule.next")}：{task.enabled ? fmt(task.nextRunAt) : tr("settings.schedule.disabled")}
                  {task.lastRunAt ? ` · ${tr("settings.schedule.last")}：${fmt(task.lastRunAt)}` : ""}
                  {task.lastStatus ? ` · ${statusLabel(task.lastStatus, tr)}` : ""}
                </div>
                {task.lastSummary ? <div style={styles.summary}>{task.lastSummary}</div> : null}
              </div>
              <div style={styles.taskActions}>
                <button type="button" style={styles.action} disabled={busy} onClick={() => runNow(task)}>
                  {tr("settings.schedule.runNow")}
                </button>
                <button type="button" style={styles.action} disabled={busy} onClick={() => toggle(task)}>
                  {task.enabled ? tr("settings.schedule.pause") : tr("settings.schedule.resume")}
                </button>
                <button type="button" style={styles.action} disabled={busy} onClick={() => edit(task)}>
                  {tr("settings.schedule.edit")}
                </button>
                <button type="button" style={{ ...styles.action, color: BRAND.danger }} disabled={busy} onClick={() => remove(task)}>
                  {tr("settings.schedule.delete")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={styles.sectionTitle}>{tr("settings.schedule.history")}</div>
      {data.runs.length === 0 ? (
        <div style={styles.empty}>{tr("settings.schedule.noRuns")}</div>
      ) : (
        <div style={styles.list}>
          {data.runs.slice(0, 8).map((runItem) => (
            <RunRow key={runItem.id} run={runItem} tr={tr} />
          ))}
        </div>
      )}
    </div>
  );
}

function RunRow({ run, tr }: { run: ScheduleRun; tr: (key: string, vars?: Record<string, string | number>) => string }): React.JSX.Element {
  return (
    <div style={styles.run}>
      <div style={styles.runTop}>
        <strong style={styles.taskTitle}>{run.taskTitle}</strong>
        <span style={styles.badge}>{statusLabel(run.status, tr)}</span>
        <span style={styles.muted}>{fmt(run.startedAt)}</span>
      </div>
      <div style={styles.summary}>{run.error ?? run.summary ?? tr("settings.schedule.running")}</div>
    </div>
  );
}

function recurrenceLabel(task: ScheduledTask, tr: (key: string, vars?: Record<string, string | number>) => string): string {
  if (task.frequency === "once") return `${task.date ?? ""} ${task.time}`;
  if (task.frequency === "daily") return `${tr("settings.schedule.everyDay")} ${task.time}`;
  if (task.frequency === "weekdays") return `${tr("settings.schedule.freqWeekdays")} ${task.time}`;
  const names = (task.weekdays ?? []).map((id) => tr(WEEKDAYS.find((day) => day.id === id)?.key ?? "settings.schedule.mon"));
  return `${names.join(" / ")} ${task.time}`;
}

function statusLabel(status: ScheduledTask["lastStatus"] | ScheduleRun["status"], tr: (key: string) => string): string {
  if (status === "ok") return tr("settings.schedule.statusOk");
  if (status === "error") return tr("settings.schedule.statusError");
  if (status === "missed") return tr("settings.schedule.statusMissed");
  if (status === "running") return tr("settings.schedule.statusRunning");
  return tr("settings.schedule.statusNever");
}

const styles: Record<string, React.CSSProperties> = {
  card: { border: `1px solid ${BRAND.border}`, borderRadius: 12, padding: 16, background: BRAND.inkRaised, marginBottom: 18 },
  cardHead: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  title: { fontSize: 14, color: BRAND.linen },
  row: { display: "flex", gap: 12, flexWrap: "wrap" },
  actions: { display: "flex", alignItems: "center", gap: 12, marginTop: 12 },
  primary: {
    height: 32,
    padding: "0 16px",
    borderRadius: 8,
    border: "none",
    background: BRAND.ochre,
    color: BRAND.ink,
    fontWeight: 700,
    fontSize: 12.5,
    cursor: "pointer",
  },
  muted: { color: BRAND.linenFaint, fontSize: 12 },
  notice: { marginTop: 10, color: BRAND.ochreHover, fontSize: 12.5 },
  sectionTitle: { margin: "20px 0 10px", fontSize: 13, fontWeight: 700, color: BRAND.linen },
  empty: { color: BRAND.linenFaint, fontSize: 12.5, padding: "10px 0" },
  list: { display: "flex", flexDirection: "column", gap: 8 },
  task: {
    display: "flex",
    gap: 12,
    justifyContent: "space-between",
    padding: "12px 14px",
    borderRadius: 10,
    border: `1px solid ${BRAND.border}`,
    background: "rgba(255,255,255,0.015)",
  },
  taskMain: { minWidth: 0, flex: "1 1 auto" },
  taskTop: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  dot: { width: 7, height: 7, borderRadius: 99, flex: "none" },
  taskTitle: { color: BRAND.linen, fontSize: 13 },
  badge: {
    padding: "1px 7px",
    borderRadius: 99,
    border: `1px solid ${BRAND.border}`,
    color: BRAND.linenMuted,
    fontSize: 11,
  },
  meta: { marginTop: 6, color: BRAND.linenFaint, fontSize: 11.5 },
  summary: { marginTop: 5, color: BRAND.linenMuted, fontSize: 12, lineHeight: 1.5, overflowWrap: "anywhere" },
  taskActions: { display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap", justifyContent: "flex-end" },
  action: {
    border: "none",
    background: "transparent",
    color: BRAND.linenMuted,
    fontSize: 12,
    padding: "5px 7px",
    borderRadius: 6,
    cursor: "pointer",
  },
  days: { display: "flex", gap: 6, flexWrap: "wrap" },
  day: {
    minWidth: 44,
    height: 30,
    padding: "0 8px",
    borderRadius: 7,
    border: `1px solid ${BRAND.border}`,
    background: "transparent",
    color: BRAND.linenMuted,
    fontSize: 12,
    cursor: "pointer",
  },
  dayActive: { background: BRAND.ochreSoft, borderColor: BRAND.ochre, color: BRAND.linen },
  run: { padding: "10px 12px", borderRadius: 9, border: `1px solid ${BRAND.border}` },
  runTop: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
};

export default SchedulesSection;
