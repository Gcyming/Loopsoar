/**
 * 设置 · 规则分区。
 *
 * 规则有独立的草稿/候选/历史状态；此前全部挂在 Settings 的 `body` useMemo 里，
 * 且依赖数组漏了 `ruleCandidates`/`rulePending`/`candidateEdits`/`ruleHistory`，
 * 学习候选到达后不一定即时出现。拆出后由本组件自持状态并直接渲染。
 */
import React, { useCallback, useEffect, useState } from "react";
import { BADGE } from "./theme.js";
import { Btn, Head, RuleCard, S, SaveBtn } from "./settingsUi.js";
import { Icon } from "./Icon.js";
import type { DraftRule } from "./settingsModel.js";
import { useT } from "./i18n.js";
import type {
  LoopsoarAPI,
  RuleCandidateView,
  RuleRevisionView,
  RulesSnapshot,
} from "./types.js";

export default function RulesSettingsSection({
  api,
  onNotice,
  onError,
}: {
  api: LoopsoarAPI;
  onNotice: (text: string) => void;
  onError: (error: unknown) => void;
}): React.JSX.Element {
  const tr = useT();
  const [rules, setRules] = useState<RulesSnapshot | null>(null);
  const [drafts, setDrafts] = useState<DraftRule[]>([]);
  const [deleted, setDeleted] = useState<string[]>([]);
  const [ruleCandidates, setRuleCandidates] = useState<RuleCandidateView[]>([]);
  const [rulePending, setRulePending] = useState(0);
  const [candidateEdits, setCandidateEdits] = useState<Record<string, string>>({});
  const [candidateTargets, setCandidateTargets] = useState<Record<string, "workspace" | "global">>({});
  const [ruleHistory, setRuleHistory] = useState<RuleRevisionView[]>([]);
  const [loading, setLoading] = useState(true);

  const loadRuleCandidates = useCallback(async () => {
    try {
      const r = await api.rules.candidates();
      setRuleCandidates(r.candidates);
      setRulePending(r.pending);
    } catch {
      // 候选只是提示，失败不影响规则编辑
    }
  }, [api]);

  const loadRuleHistory = useCallback(async () => {
    try {
      const result = await api.rules.history({ limit: 20 });
      setRuleHistory(result.revisions);
    } catch {
      // 历史只是辅助信息
    }
  }, [api]);

  const applyRules = useCallback((r: RulesSnapshot) => {
    setRules(r);
    setDrafts(
      r.entries.map((x) => ({
        key: x.id,
        name: x.name,
        scope: x.scope,
        enabled: x.enabled,
        content: x.content,
        persisted: true,
        path: x.path,
        workspaceId: x.workspaceId,
        workspaceName: r.workspaces.find((w) => w.id === x.workspaceId)?.name,
        workspaceRoot: x.workspaceRoot,
      })),
    );
    setDeleted([]);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [ru, rc, rh] = await Promise.allSettled([
          api.settings.getRules(),
          api.rules.candidates(),
          api.rules.history({ limit: 20 }),
        ]);
        if (cancelled) return;
        if (ru.status === "fulfilled") applyRules(ru.value);
        if (rc.status === "fulfilled") {
          setRuleCandidates(rc.value.candidates);
          setRulePending(rc.value.pending);
        }
        if (rh.status === "fulfilled") setRuleHistory(rh.value.revisions);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, applyRules]);

  const loadRuleWorkspace = useCallback(async (key: string, workspaceId: string) => {
    try {
      const r = await api.settings.getWorkspaceRule({ workspaceId });
      setDrafts((v) =>
        v.map((d) =>
          d.key === key
            ? {
                ...d,
                workspaceId: r.workspaceId,
                workspaceName: r.workspaceName,
                workspaceRoot: r.workspaceRoot,
                name: r.name,
                path: r.path,
                content: r.content,
                enabled: r.enabled,
                persisted: r.exists,
              }
            : d,
        ),
      );
      setRules((prev) =>
        prev ? { ...prev, merged: r.merged, conflicts: r.conflicts, checklist: r.checklist } : prev,
      );
    } catch (e) {
      onError(e);
    }
  }, [api, onError]);

  const saveRules = useCallback(async () => {
    try {
      const r = await api.settings.setRules({
        entries: drafts.map((d) => ({
          name: d.name.trim(),
          scope: d.scope,
          enabled: d.enabled,
          content: d.content,
          ...(d.workspaceId ? { workspaceId: d.workspaceId } : {}),
        })),
        deleted,
      });
      // getRules 只带活动工作区；全局条目取最新的，项目草稿保留「当前选中的项目」再各自刷新，
      // 否则保存后面板会跳回活动项目。
      const fresh = await api.settings.getRules();
      const globals = fresh.entries
        .filter((x) => x.scope === "global")
        .map((x) => ({
          key: x.id,
          name: x.name,
          scope: x.scope,
          enabled: x.enabled,
          content: x.content,
          persisted: true,
          path: x.path,
        }));
      const projectDrafts = drafts.filter((d) => d.scope === "workspace");
      const loaded =
        projectDrafts.length > 0
          ? await Promise.all(
              projectDrafts.map((d) =>
                d.workspaceId ? api.settings.getWorkspaceRule({ workspaceId: d.workspaceId }) : Promise.resolve(null),
              ),
            )
          : [];
      const projects = projectDrafts.map((d, index) => {
        const hit = loaded[index];
        return hit
          ? {
              ...d,
              workspaceName: hit.workspaceName,
              workspaceRoot: hit.workspaceRoot,
              name: hit.name,
              path: hit.path,
              content: hit.content,
              enabled: hit.enabled,
              persisted: hit.exists,
            }
          : d;
      });
      setDrafts([...globals, ...projects]);
      setDeleted([]);
      const preview = loaded.find((x) => x !== null)?.merged ?? fresh.merged;
      setRules({ ...fresh, merged: preview });
      onNotice(tr("settings.rules.saved", { count: r.merged.included.length }));
    } catch (e) {
      onError(e);
    }
  }, [api, drafts, deleted, onNotice, onError, tr]);

  const refreshRulesAfterLearn = useCallback(async (candidate: RuleCandidateView) => {
    const workspaceId = candidate.workspaceId ?? rules?.activeWorkspaceId ?? undefined;
    const draft = workspaceId ? drafts.find((d) => d.scope === "workspace" && d.workspaceId === workspaceId) : undefined;
    if (workspaceId && draft) {
      await loadRuleWorkspace(draft.key, workspaceId);
      return;
    }
    const fresh = await api.settings.getRules();
    setRules((prev) => (prev ? { ...prev, entries: fresh.entries, merged: fresh.merged } : fresh));
  }, [api, rules?.activeWorkspaceId, drafts, loadRuleWorkspace]);

  const acceptRuleCandidate = useCallback(async (candidate: RuleCandidateView) => {
    try {
      const text = (candidateEdits[candidate.id] ?? candidate.text).trim();
      const target = candidateTargets[candidate.id] ?? (candidate.scopeHint === "global" ? "global" : "workspace");
      const r = await api.rules.acceptCandidate({ id: candidate.id, target, text });
      setCandidateEdits((prev) => {
        const next = { ...prev };
        delete next[candidate.id];
        return next;
      });
      setCandidateTargets((prev) => {
        const next = { ...prev };
        delete next[candidate.id];
        return next;
      });
      await loadRuleCandidates();
      await refreshRulesAfterLearn(candidate);
      onNotice(tr("settings.rules.learnedAccepted", { path: r.path }));
    } catch (err) {
      onError(err);
    }
  }, [api, candidateEdits, candidateTargets, loadRuleCandidates, refreshRulesAfterLearn, onNotice, onError, tr]);

  const learnFromSession = useCallback(async () => {
    try {
      const result = await api.rules.learnFromSession();
      await loadRuleCandidates();
      onNotice(tr("settings.rules.learnedFromSession", { scanned: result.scanned, added: result.added }));
    } catch (err) {
      onError(err);
    }
  }, [api, loadRuleCandidates, onNotice, onError, tr]);

  const dismissRuleCandidate = useCallback(async (candidate: RuleCandidateView) => {
    try {
      await api.rules.dismissCandidate({ id: candidate.id });
      await loadRuleCandidates();
      onNotice(tr("settings.rules.learnedDismissed"));
    } catch (err) {
      onError(err);
    }
  }, [api, loadRuleCandidates, onNotice, onError, tr]);

  const reviewSessionWithAi = useCallback(async () => {
    try {
      const result = await api.rules.reviewSession();
      await loadRuleCandidates();
      onNotice(tr("settings.rules.reviewedWithAi", { scanned: result.scanned, added: result.added }));
    } catch (err) {
      onError(err);
    }
  }, [api, loadRuleCandidates, onNotice, onError, tr]);

  const rollbackRule = useCallback(async (revision: RuleRevisionView) => {
    try {
      const result = await api.rules.rollback({ id: revision.id });
      await loadRuleHistory();
      applyRules(await api.settings.getRules());
      onNotice(tr("settings.rules.rollbackDone", { count: result.restored }));
    } catch (err) {
      onError(err);
    }
  }, [api, loadRuleHistory, applyRules, onNotice, onError, tr]);

  const addDraft = (scope: "global" | "workspace") => {
    const key = `new-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
    if (scope === "global") {
      setDrafts((v) => [
        ...v,
        {
          key,
          name: tr("settings.rules.defaultGlobalName"),
          scope,
          enabled: true,
          content: "",
          persisted: false,
          path: "",
        },
      ]);
      return;
    }
    const workspaceId = rules?.activeWorkspaceId ?? rules?.workspaces[0]?.id ?? "";
    const workspace = rules?.workspaces.find((w) => w.id === workspaceId);
    setDrafts((v) => [
      ...v,
      {
        key,
        name: "AGENTS.md",
        scope: "workspace",
        enabled: true,
        content: "",
        persisted: false,
        path: "",
        ...(workspaceId ? { workspaceId } : {}),
        ...(workspace ? { workspaceName: workspace.name, workspaceRoot: workspace.root } : {}),
      },
    ]);
    if (workspaceId) void loadRuleWorkspace(key, workspaceId);
  };

  const removeDraft = (d: DraftRule) => {
    setDrafts((v) => v.filter((x) => x.key !== d.key));
    if (d.persisted) setDeleted((v) => [...v, d.key]);
  };

  if (loading) return <div style={S.muted}>{tr("settings.loading")}</div>;
  if (!rules) return <div style={S.muted}>{tr("settings.readFailed")}</div>;

  return (
    <div>
      <Head t={tr("settings.rules.head")} h={tr("settings.rules.headHint")} />
      {rules.guards.length + rules.commandGuards.length > 0 ? (
        <div
          style={S.note}
          title={[
            ...rules.guards.map((guard) => guard.rule + " → " + guard.path),
            ...rules.commandGuards.map((guard) => guard.rule + " → " + guard.managers.join("/")),
          ].join("\n")}
        >
          {tr("settings.rules.guards", { count: rules.guards.length + rules.commandGuards.length })}
        </div>
      ) : null}
      {rules.conflicts.length > 0 ? (
        <div style={S.box}>
          <div style={S.boxTitle}>{tr("settings.rules.conflicts", { count: rules.conflicts.length })}</div>
          {rules.conflicts.slice(0, 6).map((conflict, index) => (
            <div key={index} style={{ ...S.meta, display: "block", padding: "6px 0", borderTop: "1px solid rgba(255,255,255,0.06)" }}>
              <div>
                <span style={BADGE.neutral}>{conflict.type === "conflict" ? tr("settings.rules.conflict") : tr("settings.rules.duplicate")}</span>
                {" "}{conflict.a.text} ↔ {conflict.b.text}
              </div>
              <div style={S.tag}>{conflict.reason}</div>
            </div>
          ))}
        </div>
      ) : null}
      {rules.checklist.items.length > 0 ? (
        <div style={S.box}>
          <div style={S.boxTitle}>{tr("settings.rules.checklist", { count: rules.checklist.items.length })}</div>
          {rules.checklist.items.map((item) => (
            <div key={item} style={{ ...S.meta, display: "flex", alignItems: "center", gap: 6 }}>
              <Icon name="checkbox" size={13} />
              <span>{item}</span>
            </div>
          ))}
        </div>
      ) : null}
      {rules.stats.length > 0 ? (
        <div style={S.box}>
          <div style={S.boxTitle}>{tr("settings.rules.hits", { count: rules.stats.length })}</div>
          {rules.stats.slice(0, 5).map((hit) => (
            <div key={hit.text} style={S.meta}>
              {hit.text} · {tr("settings.rules.hitStats", { injected: hit.injected, count: hit.count })}
              {hit.lastTool ? " · " + hit.lastTool : ""}
            </div>
          ))}
        </div>
      ) : null}
      {drafts.length === 0 ? <div style={S.dashed}>{tr("settings.rules.empty")}</div> : null}
      {drafts.map((d) => (
        <RuleCard
          key={d.key}
          d={d}
          max={rules.maxFileBytes}
          workspaces={rules.workspaces}
          on={(p) => setDrafts((v) => v.map((x) => (x.key === d.key ? { ...x, ...p } : x)))}
          onDel={() => removeDraft(d)}
          onPick={(workspaceId) => {
            if (d.workspaceId !== workspaceId) void loadRuleWorkspace(d.key, workspaceId);
          }}
        />
      ))}
      <div style={S.btns}>
        <Btn label={tr("settings.rules.newGlobal")} onClick={() => addDraft("global")} />
        <Btn label={tr("settings.rules.newWorkspace")} onClick={() => addDraft("workspace")} />
        <Btn label={tr("settings.rules.learnFromSession")} onClick={() => void learnFromSession()} />
        <Btn label={tr("settings.rules.reviewWithAi")} onClick={() => void reviewSessionWithAi()} />
      </div>
      {ruleHistory.length > 0 ? (
        <div style={S.box}>
          <div style={S.boxTitle}>{tr("settings.rules.history", { count: ruleHistory.length })}</div>
          {ruleHistory.slice(0, 5).map((revision) => (
            <div key={revision.id} style={{ ...S.meta, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "6px 0", borderTop: "1px solid rgba(255,255,255,0.06)" }}>
              <span>{revision.summary}</span>
              <Btn label={tr("settings.rules.rollback")} small onClick={() => void rollbackRule(revision)} />
            </div>
          ))}
        </div>
      ) : null}
      {rulePending > 0 ? (
        <div style={S.box}>
          <div style={S.boxTitle}>{tr("settings.rules.learnedTitle", { count: rulePending })}</div>
          <div style={S.note}>{tr("settings.rules.learnedHint")}</div>
          {ruleCandidates.filter((candidate) => candidate.status === "pending").map((candidate) => (
            <div key={candidate.id} style={{ ...S.rowBetween, alignItems: "flex-start", gap: 12, padding: "8px 0", borderTop: "1px solid rgba(255,255,255,0.06)" }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <textarea
                  style={{ ...S.input, width: "100%", boxSizing: "border-box", minHeight: 34, resize: "vertical" }}
                  rows={2}
                  value={candidateEdits[candidate.id] ?? candidate.text}
                  onChange={(event) => setCandidateEdits((prev) => ({ ...prev, [candidate.id]: event.target.value }))}
                  title={tr("settings.rules.learnedEditHint")}
                />
                <div style={S.meta}>
                  {tr("settings.rules.learnedEvidence", { count: candidate.seenCount })}
                  {candidate.workspaceId ? ` · ${rules.workspaces.find((w) => w.id === candidate.workspaceId)?.name ?? candidate.workspaceId}` : ` · ${tr("settings.rules.scopeGlobal")}`}
                </div>
                {candidate.evidence?.length ? (
                  <div style={{ ...S.tag, marginTop: 3 }}>
                    {tr("settings.rules.learnedEvidenceTool", {
                      tool: candidate.evidence[candidate.evidence.length - 1].toolName,
                      error: candidate.evidence[candidate.evidence.length - 1].error.slice(0, 60),
                    })}
                  </div>
                ) : null}
              </div>
              <div style={{ ...S.icons, flexWrap: "wrap", justifyContent: "flex-end", maxWidth: 180 }}>
                <select
                  style={{ ...S.input, width: "auto", maxWidth: 92, paddingRight: 4 }}
                  value={candidateTargets[candidate.id] ?? (candidate.scopeHint === "global" ? "global" : "workspace")}
                  onChange={(event) => setCandidateTargets((prev) => ({ ...prev, [candidate.id]: event.target.value as "workspace" | "global" }))}
                >
                  <option value="workspace">{tr("settings.rules.targetWorkspace")}</option>
                  <option value="global">{tr("settings.rules.targetGlobal")}</option>
                </select>
                <Btn label={tr("settings.rules.learnedAccept")} small primary onClick={() => void acceptRuleCandidate(candidate)} />
                <Btn label={tr("settings.rules.learnedDismiss")} small onClick={() => void dismissRuleCandidate(candidate)} />
              </div>
            </div>
          ))}
        </div>
      ) : null}
      <div style={S.box}>
        <div style={S.boxTitle}>{tr("settings.rules.merged")}</div>
        <div style={S.meta}>
          {tr("settings.rules.effective", { count: rules.merged.included.length, bytes: rules.merged.totalBytes, max: rules.maxTotalBytes })}
          {deleted.length ? tr("settings.rules.pendingDelete", { count: deleted.length }) : ""}
        </div>
        {rules.merged.skipped.length ? <ul style={S.list}>{rules.merged.skipped.map((x) => <li key={x.path}>{tr("settings.skipItem", { path: x.path, reason: x.reason })}</li>)}</ul> : null}
        {rules.merged.text ? <pre style={S.pre}>{rules.merged.text.slice(0, 900)}</pre> : <div style={S.note}>{tr("settings.rules.noContent")}</div>}
      </div>
      <SaveBtn onClick={saveRules} label={tr("settings.rules.saveAll")} />
    </div>
  );
}
