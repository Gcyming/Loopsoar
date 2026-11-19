/**
 * 设置 · 记忆分区。
 *
 * 从 Settings.tsx 的巨型 `body` useMemo 中拆出：记忆有独立的列表/图谱/回放/回顾状态，
 * 继续留在父组件里会导致任何一次记忆筛选都依赖父级 memo 的依赖数组（旧实现漏列
 * `memWs`/`replayAt` 等状态，切工作区或拖时间轴时面板不刷新）。这里让组件自持状态，
 * 仅通过 props 使用 api、偏好和全局通知。
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { BADGE, BRAND } from "./theme.js";
import {
  Area,
  Btn,
  CategoryCombo,
  Combo,
  Head,
  In,
  S,
  Stat,
  memoryBlock,
  memoryFormGrid,
} from "./settingsUi.js";
import MemoryGraphView from "./MemoryGraphView.js";
import { useT } from "./i18n.js";
import type {
  LocationsInfo,
  LoopsoarAPI,
  MemoryGraphNodeView,
  MemoryGraphResult,
  MemoryListResult,
  Preferences,
} from "./types.js";

interface MemoryReview {
  suggestions: { id: string; title: string; content: string }[];
  merges: { ids: string[]; reason: string }[];
  applied: number;
  available: boolean;
}

export default function MemorySettingsSection({
  api,
  prefs,
  locations,
  onPrefsChange,
  onSavePrefs,
  onNotice,
  onError,
}: {
  api: LoopsoarAPI;
  prefs: Preferences | null;
  locations: LocationsInfo | null;
  onPrefsChange: (next: Preferences) => void;
  /** 保存当前偏好（换记忆库后要等 relocate 完成再刷新列表）。 */
  onSavePrefs: () => Promise<void>;
  onNotice: (text: string) => void;
  onError: (error: unknown) => void;
}): React.JSX.Element {
  const tr = useT();
  const [mem, setMem] = useState<MemoryListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [mForm, setMForm] = useState({
    content: "",
    category: "general",
    importance: "5",
    tags: "",
    workspaceId: "",
  });
  const [memPage, setMemPage] = useState(1);
  const [memJump, setMemJump] = useState("");
  const [mEdit, setMEdit] = useState<{ id: string; content: string } | null>(null);
  const [review, setReview] = useState<MemoryReview | null>(null);
  /** 记忆面板的查看范围（D1）：只影响展示，召回隔离在壳层。 */
  const [memWs, setMemWs] = useState<string>("all");
  /** 记忆图谱（E-M0）：随 mem 刷新一起更新（增删改后自动重画）。 */
  const [memGraph, setMemGraph] = useState<MemoryGraphResult | null>(null);
  const [graphSel, setGraphSel] = useState<MemoryGraphNodeView | null>(null);
  /** M4 时间回放：null = 现在；否则显示该时刻的图谱（事实按诞生时间上桌，已失效的变空心）。 */
  const [replayAt, setReplayAt] = useState<number | null>(null);
  /** 时间轴范围：最早条目的时间 → 现在。 */
  const [replayDomain, setReplayDomain] = useState<{ from: number; to: number } | null>(null);

  const ok = onNotice;
  const bad = onError;

  useEffect(() => {
    let cancelled = false;
    void api.memory
      .list()
      .then((value) => {
        if (!cancelled) setMem(value);
      })
      .catch(bad)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, bad]);

  // 启动后的索引核对在后台进行：轮询到 idle 为止，让「最终一致窗口」可见并自动消失。
  useEffect(() => {
    if (!mem?.reconciling || !api) return;
    const timer = window.setTimeout(() => {
      void api.memory
        .list()
        .then(setMem)
        .catch(() => undefined);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [api, mem]);

  useEffect(() => {
    if (!api || !mem) return;
    // 拖动时间轴时 120ms 防抖，避免每帧都过 IPC；回到「现在」立即刷新。
    const timer = setTimeout(() => {
      void api.memory
        .graph(replayAt === null ? undefined : { at: replayAt })
        .then(setMemGraph)
        .catch(() => setMemGraph(null));
    }, replayAt === null ? 0 : 120);
    return () => clearTimeout(timer);
  }, [api, mem, replayAt]);

  useEffect(() => {
    if (!mem) {
      setReplayDomain(null);
      return;
    }
    const times = mem.facts.map((f) => f.updatedAt).filter((t) => Number.isFinite(t));
    setReplayDomain(times.length > 0 ? { from: Math.min(...times), to: Date.now() } : null);
  }, [mem]);

  // E-M2：记忆使用事件（工具检索命中 / 新增 / 删除）→ 刷新面板与图谱，图组件据此做脉冲反馈。
  useEffect(() => {
    return api.on("memory:updated", () => {
      void api.memory
        .list()
        .then(setMem)
        .catch(() => undefined);
    });
  }, [api]);

  const addMemory = useCallback(async () => {
    if (!mForm.content.trim()) return;
    const tags = mForm.tags
      .split(/[,，\s]+/)
      .map((tag) => tag.replace(/^#/, "").trim())
      .filter(Boolean)
      .slice(0, 10);
    const importance = Math.min(10, Math.max(1, Number(mForm.importance) || 5));
    try {
      await api.memory.add({
        content: mForm.content.trim(),
        category: mForm.category.trim() || "general",
        importance,
        ...(tags.length > 0 ? { tags } : {}),
        ...(mForm.workspaceId.trim() ? { workspaceId: mForm.workspaceId.trim() } : {}),
      });
      setMForm({ content: "", category: "general", importance: "5", tags: "", workspaceId: "" });
      setMem(await api.memory.list());
      ok(tr("settings.memory.added"));
    } catch (e) {
      bad(e);
    }
  }, [api, mForm, ok, bad, tr]);

  const saveMemEdit = useCallback(async () => {
    if (!mEdit) return;
    try {
      await api.memory.update({ id: mEdit.id, content: mEdit.content });
      setMEdit(null);
      setMem(await api.memory.list());
    } catch (e) {
      bad(e);
    }
  }, [api, mEdit, bad]);

  const body = useMemo((): React.JSX.Element => {
    if (loading) return <div style={S.muted}>{tr("settings.loading")}</div>;
    if (!mem) return <div style={S.muted}>{tr("settings.readFailed")}</div>;

    const workspaceIds = Object.keys(mem.stats.byWorkspace ?? {});
    const shownFacts = mem.facts.filter(
      (f) => memWs === "all" || (f.workspaceId ?? "default") === memWs,
    );
    const memPageSize = 10;
    const memTotalPages = Math.max(1, Math.ceil(shownFacts.length / memPageSize));
    const memPageSafe = Math.min(Math.max(1, memPage), memTotalPages);
    const pageFacts = shownFacts.slice((memPageSafe - 1) * memPageSize, memPageSafe * memPageSize);
    const pageNumbers = Array.from({ length: memTotalPages }, (_, index) => index + 1).filter(
      (page) => memTotalPages <= 7 || page === 1 || page === memTotalPages || Math.abs(page - memPageSafe) <= 2,
    );
    const categoryOptions = [
      ...new Set([
        ...mem.facts.map((fact) => fact.category),
        "general",
        "convention",
        "lesson",
        "fact",
        "preference",
        "episode",
      ]),
    ].filter(Boolean);
    const tagOptions = [...new Set(mem.facts.flatMap((fact) => fact.tags))].filter(Boolean).sort();
    const workspaceOptions = [...new Set([...workspaceIds, "default"])].filter(Boolean);
    const importanceOptions = Array.from({ length: 10 }, (_, index) => String(index + 1));
    const categoryLabel = (key: string): string => tr(`settings.memory.category.${key}`);
    // 召回理由码 → 人读文案（方案 P2：UI 解释「为什么召回这条」）
    const REASON_KEYS: Record<string, string> = {
      lexical: "settings.memory.reason.lexical",
      exact: "settings.memory.reason.exact",
      activation: "settings.memory.reason.activation",
      graph: "settings.memory.reason.graph",
      "cold-start": "settings.memory.reason.coldStart",
      "band:L2": "settings.memory.reason.bandL2",
      tag: "settings.memory.reason.tag",
    };
    const reasonLabel = (reason: string): string => {
      const key = REASON_KEYS[reason];
      return key ? tr(key) : reason;
    };

    return (
      <div>
        <Head t={tr("settings.memory.head")} h={tr("settings.memory.headHint")} />
        {mem.lastRecall && mem.lastRecall.at > 0 ? (
          <div style={{ fontSize: 11, color: BRAND.linenFaint, marginBottom: 6 }}>
            {tr("settings.memory.lastRecallHint", { time: new Date(mem.lastRecall.at).toLocaleTimeString() })}
          </div>
        ) : null}
        <MemoryGraphView data={memGraph} height={360} onSelect={setGraphSel} />
        {replayDomain ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "6px 0 2px" }}>
            <span style={S.tag}>
              {replayAt === null
                ? tr("settings.memory.replayNow")
                : tr("settings.memory.replayAt", { time: new Date(replayAt).toLocaleString() })}
            </span>
            <input
              type="range"
              data-testid="memory-replay"
              min={replayDomain.from}
              max={replayDomain.to}
              step={3_600_000}
              value={replayAt ?? replayDomain.to}
              onChange={(event) => {
                const next = Number(event.target.value);
                setReplayAt(next >= replayDomain.to - 3_600_000 ? null : next);
              }}
              style={{ flex: 1, accentColor: "#c8763c" }}
              title={tr("settings.memory.replayHint")}
            />
            {replayAt !== null ? (
              <Btn label={tr("settings.memory.replayReset")} small onClick={() => setReplayAt(null)} />
            ) : null}
          </div>
        ) : null}
        {graphSel ? (
          (() => {
            const detail = graphSel.factId ? mem.facts.find((f) => f.id === graphSel.factId) ?? null : null;
            const related = detail ? detail.links.map((id) => mem.facts.find((f) => f.id === id)).filter(Boolean) : [];
            return (
              <div className="panel-card" style={S.card}>
                <div style={S.rowBetween}>
                  <span style={S.meta}>
                    <span style={BADGE.neutral}>{detail ? categoryLabel(detail.category) : graphSel.kind}</span>
                    <span style={S.tag}>{graphSel.workspaceId}</span>
                    {detail ? <span style={S.tag}>{tr("settings.memory.importance", { value: detail.importance })}</span> : null}
                    {graphSel.band !== "L1" ? <span style={S.tag}>{graphSel.band}</span> : null}
                    {graphSel.superseded ? <span style={S.tag}>{tr("settings.memory.superseded")}</span> : null}
                  </span>
                  <Btn label={tr("settings.close")} small onClick={() => setGraphSel(null)} />
                </div>
                <div style={S.memText}>{detail?.content ?? graphSel.label}</div>
                {detail ? (
                  <div style={S.note}>
                    {new Date(detail.updatedAt).toLocaleString()} · {detail.trust ?? "user"}
                    {detail.sessionId ? ` · ${tr("settings.memory.nodeSession")} ${detail.sessionId.slice(0, 12)}` : ""}
                  </div>
                ) : null}
                {related.length > 0 ? (
                  <div style={S.note}>
                    {tr("settings.memory.related")}：
                    {related.map((item) => (item ? item.content.slice(0, 24) : "")).join(" / ")}
                  </div>
                ) : null}
              </div>
            );
          })()
        ) : (
          <div style={S.note}>{tr("settings.memory.graphHint")}</div>
        )}
        <div style={S.stats}>
          <Stat l={tr("settings.memory.items")} v={mem.stats.active} />
          <Stat l={tr("settings.memory.archived")} v={mem.stats.archived} />
          <Stat l={tr("settings.memory.links")} v={mem.stats.links} />
          <Stat l={tr("settings.memory.invalidated")} v={mem.stats.invalidated ?? 0} />
        </div>
        <div style={memoryBlock}>
          <div style={S.meta}>{tr("settings.memory.store")}</div>
          <div style={S.fieldHint}>{tr("settings.memory.storeHint")}</div>
          <div style={S.rowEnd}>
            <In
              v={prefs?.memoryStorePath ?? ""}
              ph={locations?.defaultMemoryFile ?? ""}
              style={{ maxWidth: "none", flex: 1 }}
              on={(x) => {
                if (prefs) onPrefsChange({ ...prefs, memoryStorePath: x });
              }}
            />
            <Btn
              label={tr("settings.browse")}
              small
              onClick={() => {
                void api.dialog
                  .pickPath({ kind: "file", title: tr("settings.storage.pickMemory") })
                  .then((r) => {
                    if (r.path && prefs) onPrefsChange({ ...prefs, memoryStorePath: r.path });
                  });
              }}
            />
            <Btn
              label={tr("settings.save")}
              small
              primary
              onClick={() => {
                void onSavePrefs().then(async () => {
                  // 换库是异步的：等 relocate 完成再刷新，避免读到旧库
                  await new Promise((resolve) => setTimeout(resolve, 400));
                  setMem(await api.memory.list());
                });
              }}
            />
          </div>
        </div>
        <div style={S.note}>{tr("settings.memory.vaultHint")}</div>
        {mem.reconciling ? <div style={S.note}>{tr("settings.memory.reconciling")}</div> : null}
        {workspaceIds.length > 1 ? (
          <div style={S.btns}>
            <Btn label={tr("settings.memory.wsAll")} small primary={memWs === "all"} onClick={() => { setMemWs("all"); setMemPage(1); }} />
            {workspaceIds.map((ws) => (
              <Btn key={ws} label={ws} small primary={memWs === ws} onClick={() => { setMemWs(ws); setMemPage(1); }} />
            ))}
          </div>
        ) : null}
        <div style={S.btns}>
          <Btn
            label={tr("settings.memory.consolidate")}
            onClick={() =>
              void api.memory.consolidate().then(async () => {
                setMem(await api.memory.list());
              })
            }
          />
          <Btn
            label={tr("settings.memory.exportMd")}
            onClick={() =>
              void api.memory
                .exportMarkdown()
                .then((r) => ok(tr("settings.memory.exported", { count: r.count, path: r.path })))
                .catch(bad)
            }
          />
          <Btn label={tr("settings.memory.review")} onClick={() => void api.memory.review().then(setReview).catch(bad)} />
          <Btn label={tr("settings.memory.clearAll")} onClick={() => void api.memory.clear().then(async () => setMem(await api.memory.list()))} />
        </div>
        {review ? (
          <div className="panel-card" style={S.card}>
            <div style={S.rowBetween}>
              <span style={S.meta}>
                {review.available
                  ? tr("settings.memory.reviewTitle", { count: review.suggestions.length })
                  : tr("settings.memory.reviewUnavailable")}
              </span>
              {review.suggestions.length > 0 ? (
                <Btn
                  label={tr("settings.memory.reviewApply")}
                  primary
                  small
                  onClick={() =>
                    void api.memory
                      .review({ apply: true })
                      .then(async (result) => {
                        setReview(null);
                        setMem(await api.memory.list());
                        ok(tr("settings.memory.reviewApplied", { count: result.applied }));
                      })
                      .catch(bad)
                  }
                />
              ) : null}
            </div>
            {review.suggestions.map((item) => (
              <div key={item.id} style={S.memText}>
                <span style={S.muted}>{item.content.slice(0, 50)}…</span> → <b>{item.title}</b>
              </div>
            ))}
            {review.merges.length > 0 ? (
              <div style={{ marginTop: 8 }}>
                <div style={S.rowBetween}>
                  <span style={S.meta}>{tr("settings.memory.mergeTitle", { count: review.merges.length })}</span>
                  <Btn
                    label={tr("settings.memory.mergeApply")}
                    small
                    onClick={() =>
                      void api.memory
                        .merge({ groups: review.merges.map((item) => ({ ids: item.ids, reason: item.reason })) })
                        .then(async (result) => {
                          setReview(null);
                          setMem(await api.memory.list());
                          ok(tr("settings.memory.mergeApplied", { count: result.merged }));
                        })
                        .catch(bad)
                    }
                  />
                </div>
                {review.merges.map((item, index) => (
                  <div key={index} style={S.memText}>
                    <span style={S.muted}>
                      {item.ids
                        .map((id) => mem.facts.find((fact) => fact.id === id)?.content.slice(0, 40) ?? id)
                        .join(" ｜ ")}
                    </span>{" "}
                    <b>{item.reason}</b>
                  </div>
                ))}
              </div>
            ) : null}
            {review.available && review.suggestions.length === 0 && review.merges.length === 0 ? <div style={S.muted}>{tr("settings.memory.reviewEmpty")}</div> : null}
          </div>
        ) : null}
        <div style={memoryBlock}>
          <div style={S.meta}>{tr("settings.memory.addTitle")}</div>
          <div style={S.fieldHint}>{tr("settings.memory.addHint")}</div>
          <div style={S.col}>
            <Area v={mForm.content} rows={2} full ph={tr("settings.memory.addContentPh")} on={(x) => setMForm({ ...mForm, content: x })} />
            <div style={memoryFormGrid}>
              <CategoryCombo
                value={mForm.category}
                onChange={(x) => setMForm({ ...mForm, category: x })}
                options={categoryOptions}
                labelOf={categoryLabel}
                placeholder={tr("settings.memory.addCategoryPh")}
              />
              <Combo v={mForm.importance} ph={tr("settings.memory.addImportancePh")} on={(x) => setMForm({ ...mForm, importance: x })} options={importanceOptions} />
              <div />
              <Combo v={mForm.tags} ph={tr("settings.memory.addTagsPh")} on={(x) => setMForm({ ...mForm, tags: x })} options={tagOptions} />
              <Combo v={mForm.workspaceId} ph={tr("settings.memory.addWorkspacePh")} on={(x) => setMForm({ ...mForm, workspaceId: x })} options={workspaceOptions} />
              <Btn label={tr("settings.add")} primary onClick={() => void addMemory()} />
            </div>
          </div>
        </div>
        {shownFacts.length === 0 ? <div style={S.dashed}>{tr("settings.memory.empty")}</div> : pageFacts.map((f) => (
          <div key={f.id} className="panel-card" style={S.card}>
            <div style={S.rowBetween}>
              <span style={S.meta}><span style={BADGE.neutral}>{categoryLabel(f.category)}</span>{f.workspaceId ? <span style={S.tag}>{f.workspaceId}</span> : null}<span style={S.tag}>{tr("settings.memory.importance", { value: f.importance })}</span>{f.tags.map((t) => <span key={t} style={S.tag}>#{t}</span>)}
                {(mem.lastRecall?.reasons[f.id] ?? []).map((reason) => (
                  <span key={reason} style={{ ...S.tag, color: BRAND.ochreHover, borderColor: "rgba(var(--ls-accent-rgb, 200, 118, 60),0.45)" }}>{reasonLabel(reason)}</span>
                ))}</span>
              <span style={S.icons}>
                {mEdit?.id === f.id ? <>
                  <Btn label={tr("settings.save")} small onClick={() => void saveMemEdit()} /><Btn label={tr("settings.cancel")} small onClick={() => setMEdit(null)} />
                </> : <Btn label={tr("settings.edit")} small onClick={() => setMEdit({ id: f.id, content: f.content })} />}
                <Btn label={tr("settings.delete")} small onClick={() => void api.memory.delete({ id: f.id }).then(async () => setMem(await api.memory.list()))} />
              </span>
            </div>
            {mEdit?.id === f.id ? <Area v={mEdit.content} rows={2} on={(x) => setMEdit({ id: f.id, content: x })} /> : <div style={S.memText}>{f.content}</div>}
          </div>
        ))}
        {shownFacts.length > memPageSize ? (
          <div style={S.btns}>
            <Btn label="‹" small onClick={() => setMemPage(Math.max(1, memPageSafe - 1))} />
            {pageNumbers.map((page) => (
              <Btn key={page} label={String(page)} small primary={page === memPageSafe} onClick={() => setMemPage(page)} />
            ))}
            <Btn label="›" small onClick={() => setMemPage(Math.min(memTotalPages, memPageSafe + 1))} />
            <span style={S.meta}>{tr("settings.memory.pageInfo", { page: memPageSafe, total: memTotalPages, count: shownFacts.length })}</span>
            <In v={memJump} ph={tr("settings.memory.pageJump")} on={setMemJump} style={{ width: 72, flex: "0 0 auto" }} />
            <Btn
              label={tr("settings.memory.pageGo")}
              small
              onClick={() => {
                const target = Math.trunc(Number(memJump));
                if (Number.isFinite(target) && target >= 1) setMemPage(Math.min(memTotalPages, target));
                setMemJump("");
              }}
            />
          </div>
        ) : null}
      </div>
    );
  }, [
    loading, mem, memWs, memPage, memJump, mEdit, review, memGraph, graphSel, replayAt, replayDomain,
    prefs, locations, mForm, tr, api, ok, bad, onPrefsChange, onSavePrefs, addMemory, saveMemEdit,
  ]);

  return body;
}
