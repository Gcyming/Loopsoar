/**
 * Loop 工作台（设置 → Loop）：把「自定义 loop」真正落地为可编译的声明式配置。
 *
 * 设计取舍：
 *   · 只编辑 L2 声明式 JSON（可校验、可 diff、无任意代码执行）；L3 脚本仍在 loops/ 目录手工编写。
 *   · 保存 = 校验 → 壳层原子写入 loops/<id>.json → 重扫注册；与手工改文件共用一条运行时路径。
 *   · 阶段开关会同时影响「模型可见工具」和「执行器拦截」，不是纯 UI 装饰。
 */
import * as React from "react";
import { LOOP_STAGE_CATALOG } from "loopsoar-contracts/schemas";
import { BADGE, BRAND } from "./theme.js";
import { useT } from "./i18n.js";
import {
  Btn,
  Field,
  In,
  Area,
  S,
  Seg,
  Toggle,
} from "./settingsUi.js";
import type {
  LoopEditorConfig,
  LoopInfo,
  LoopListResult,
  LoopStageConfig,
  LoopStageId,
} from "./types.js";

interface StageMeta {
  id: LoopStageId;
  label: string;
  desc: string;
  tools: string[];
}

/** 阶段目录的唯一产地在契约层；UI 只做展示，实际白名单以壳层为准。 */
const STAGES: StageMeta[] = LOOP_STAGE_CATALOG.map((stage) => ({
  id: stage.id,
  label: stage.name,
  desc: stage.description,
  tools: [...stage.tools],
}));

const DEFAULT_STAGES: LoopStageConfig[] = STAGES.map((stage) => ({ id: stage.id, enabled: true }));
const CUSTOM_TEMPLATE: LoopStageConfig[] = [
  { id: "scout", name: "侦察", enabled: true, tools: ["web_search", "web_fetch"], prompt: "先收集候选来源，给出取舍理由。" },
  { id: "act", name: "执行", enabled: true, tools: ["browser_navigate", "browser_snapshot", "browser_click", "browser_type"], prompt: "在浏览器里完成页面操作，每步核对结果。" },
  { id: "report", name: "汇总", enabled: true, tools: ["todo_write", "file_write"], prompt: "整理可复用的结论与文件。" },
];
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** 是否为用户完全自定义的阶段集合（含任意非内置阶段 id、自定义字段或重排/裁剪）。 */
function hasCustomStages(stages: LoopStageConfig[] | undefined): boolean {
  if (!stages || stages.length === 0) return false;
  if (stages.length !== STAGES.length) return true;
  return stages.some((stage, index) => {
    const builtin = STAGES[index];
    return (
      stage.id !== builtin?.id ||
      stage.name !== undefined ||
      stage.tools !== undefined ||
      stage.prompt !== undefined
    );
  });
}

/**
 * 完全自定义阶段 JSON 的本地校验：后端仍是最终裁判，这里先给出可读错误并归一化。
 * 只接受数组；每项至少 id/enabled，名称/工具/提示可选。
 */
function parseCustomStages(text: string): { stages?: LoopStageConfig[]; error?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { error: `JSON 解析失败：${err instanceof Error ? err.message : String(err)}` };
  }
  if (!Array.isArray(raw) || raw.length === 0) return { error: "必须是非空阶段数组" };
  if (raw.length > 32) return { error: "最多 32 个阶段" };
  const seen = new Set<string>();
  const stages: LoopStageConfig[] = [];
  for (const [index, item] of raw.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { error: `第 ${index + 1} 项必须是对象` };
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || !ID_RE.test(row.id)) return { error: `第 ${index + 1} 项的 id 不合法` };
    if (seen.has(row.id)) return { error: `阶段 id 重复：${row.id}` };
    seen.add(row.id);
    if (row.enabled !== undefined && typeof row.enabled !== "boolean") return { error: `阶段 ${row.id} 的 enabled 必须是布尔值` };
    if (row.name !== undefined && typeof row.name !== "string") return { error: `阶段 ${row.id} 的 name 必须是字符串` };
    if (row.prompt !== undefined && typeof row.prompt !== "string") return { error: `阶段 ${row.id} 的 prompt 必须是字符串` };
    if (row.tools !== undefined && (!Array.isArray(row.tools) || row.tools.some((tool) => typeof tool !== "string"))) {
      return { error: `阶段 ${row.id} 的 tools 必须是字符串数组` };
    }
    stages.push({
      id: row.id,
      enabled: row.enabled !== false,
      ...(typeof row.name === "string" && row.name.trim() ? { name: row.name.trim() } : {}),
      ...(Array.isArray(row.tools) ? { tools: row.tools.map((tool) => String(tool).trim()).filter(Boolean) } : {}),
      ...(typeof row.prompt === "string" && row.prompt.trim() ? { prompt: row.prompt.trim() } : {}),
    });
  }
  return { stages };
}

function emptyDraft(): LoopEditorConfig {
  return {
    kind: "declarative",
    id: "",
    name: "",
    description: "",
    systemPromptAppend: "",
    maxRounds: 8,
    maxToolCalls: 40,
    stages: DEFAULT_STAGES.map((stage) => ({ ...stage })),
    allowedTools: [],
  };
}

function fromConfig(config: LoopEditorConfig): LoopEditorConfig {
  // 完全自定义配置：原样保留用户阶段（名称/工具/提示），不要被内置六阶段覆盖。
  if (hasCustomStages(config.stages)) {
    return {
      ...config,
      description: config.description ?? "",
      systemPromptAppend: config.systemPromptAppend ?? "",
      stages: (config.stages ?? []).map((stage) => ({ ...stage, enabled: stage.enabled !== false })),
      allowedTools: config.allowedTools ?? [],
    };
  }
  const byId = new Map((config.stages ?? []).map((stage) => [stage.id, stage.enabled]));
  return {
    ...config,
    description: config.description ?? "",
    systemPromptAppend: config.systemPromptAppend ?? "",
    stages: STAGES.map((stage) => ({ id: stage.id, enabled: byId.get(stage.id) ?? true })),
    allowedTools: config.allowedTools ?? [],
  };
}

function stageSummary(config: LoopEditorConfig | null, custom: boolean, customText?: string): string {
  if (!config) return "—";
  const stages = custom && customText ? (parseCustomStages(customText).stages ?? config.stages ?? DEFAULT_STAGES) : (config.stages ?? DEFAULT_STAGES);
  const enabled = stages.filter((stage) => stage.enabled).length;
  if (custom) return `完全自定义 · ${enabled}/${stages.length} 个阶段开启`;
  return `${enabled}/${STAGES.length} 个阶段开启`;
}

export function LoopStudioSection({
  list,
  onReload,
  onError,
  compressRatio = 0.75,
  onOpenGeneral,
}: {
  list: LoopListResult | null;
  onReload: () => Promise<void> | void;
  onError: (message: string) => void;
  /** 全局上下文压缩阈值（设置 · 通用）；Loop 内每轮工具请求前执行。 */
  compressRatio?: number;
  /** 跳转到「通用」调整阈值。 */
  onOpenGeneral?: () => void;
}) {
  const tr = useT();
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [selectedReadonly, setSelectedReadonly] = React.useState<LoopInfo | null>(null);
  const [draft, setDraft] = React.useState<LoopEditorConfig | null>(null);
  /** 内置六阶段开关 / 完全自定义阶段 JSON 两种编辑模式。 */
  const [customMode, setCustomMode] = React.useState(false);
  const [customText, setCustomText] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [activate, setActivate] = React.useState(true);
  const [note, setNote] = React.useState<string | null>(null);
  const [localError, setLocalError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    await onReload();
  }, [onReload]);

  // 首次拿到列表：优先选中当前活动 loop，避免页面一片空白。
  React.useEffect(() => {
    if (!list || selectedId || draft) return;
    const active = list.loops.find((loop) => loop.active) ?? list.loops[0];
    if (active) void select(active);
    // select 为稳定函数；这里只依赖 list 的引用（刷新后主动保留当前选择）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list]);

  async function select(loop: LoopInfo): Promise<void> {
    setSelectedId(loop.id);
    setNote(null);
    setLocalError(null);
    const api = window.loopsoarAPI;
    if (!api) {
      setLocalError("未在 Electron shell 中运行（window.loopsoarAPI 不存在）");
      return;
    }
    if (!loop.editable) {
      setSelectedReadonly(loop);
      setDraft(null);
      return;
    }
    setSelectedReadonly(null);
    setLoading(true);
    try {
      const got = await api.loop.get({ id: loop.id });
      if (!got.ok || !got.loop?.config) {
        setLocalError(got.error ?? tr("settings.loop.loadFailed"));
        setDraft(null);
        return;
      }
      setDraft(fromConfig(got.loop.config));
      const custom = hasCustomStages(got.loop.config.stages);
      setCustomMode(custom);
      setCustomText(JSON.stringify(got.loop.config.stages ?? DEFAULT_STAGES, null, 2));
      setActivate(loop.active);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
      setDraft(null);
    } finally {
      setLoading(false);
    }
  }

  function startNew(): void {
    setSelectedId(null);
    setSelectedReadonly(null);
    setDraft(emptyDraft());
    setCustomMode(false);
    setCustomText(JSON.stringify(DEFAULT_STAGES, null, 2));
    setActivate(true);
    setLocalError(null);
    setNote(null);
  }

  /** 直接从列表入口进入「完全自定义」：不要求用户先点新建再找模式开关。 */
  function startNewCustom(): void {
    startNew();
    setCustomMode(true);
    setCustomText(JSON.stringify(CUSTOM_TEMPLATE, null, 2));
  }

  function fromReadonly(): void {
    if (!selectedReadonly) return;
    const loop = selectedReadonly;
    setSelectedId(null);
    setSelectedReadonly(null);
    setDraft({
      ...emptyDraft(),
      id: `${loop.id}-custom`.replace(/[^a-z0-9-]/g, "-").slice(0, 64),
      name: `${loop.name}（自定义）`,
      description: loop.description ?? "",
    });
    setCustomMode(false);
    setCustomText(JSON.stringify(DEFAULT_STAGES, null, 2));
    setActivate(true);
    setLocalError(null);
    setNote(null);
  }

  function update(patch: Partial<LoopEditorConfig>): void {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setNote(null);
    setLocalError(null);
  }

  function setStage(id: LoopStageId, enabled: boolean): void {
    setDraft((current) => {
      if (!current) return current;
      const stages = (current.stages ?? DEFAULT_STAGES).map((stage) =>
        stage.id === id ? { ...stage, enabled } : stage,
      );
      return { ...current, stages };
    });
    setNote(null);
  }

  function validate(): string | null {
    if (!draft) return tr("settings.loop.noDraft");
    if (!ID_RE.test(draft.id)) return tr("settings.loop.badId");
    if (!draft.name.trim()) return tr("settings.loop.badName");
    if (draft.maxRounds !== undefined && (!Number.isInteger(draft.maxRounds) || draft.maxRounds < 1 || draft.maxRounds > 50)) {
      return tr("settings.loop.badRounds");
    }
    if (draft.maxToolCalls !== undefined && (!Number.isInteger(draft.maxToolCalls) || draft.maxToolCalls < 1 || draft.maxToolCalls > 500)) {
      return tr("settings.loop.badCalls");
    }
    if (customMode) {
      const parsed = parseCustomStages(customText);
      if (parsed.error) return `完全自定义阶段：${parsed.error}`;
      if (!parsed.stages || parsed.stages.length === 0) return "完全自定义阶段不能为空";
    }
    return null;
  }

  function setEditorMode(mode: "builtin" | "custom"): void {
    if (mode === "custom") {
      setCustomMode(true);
      setCustomText(JSON.stringify(draft?.stages ?? DEFAULT_STAGES, null, 2));
      setLocalError(null);
      return;
    }
    setCustomMode(false);
    // 回到内置模式时重置为六阶段目录，避免把自定义阶段误带到开关网格。
    setDraft((current) => (current ? { ...current, stages: DEFAULT_STAGES.map((stage) => ({ ...stage })) } : current));
    setCustomText(JSON.stringify(DEFAULT_STAGES, null, 2));
    setLocalError(null);
  }

  async function save(): Promise<void> {
    const invalid = validate();
    if (invalid) {
      setLocalError(invalid);
      return;
    }
    if (!draft) return;
    // 新建时 id 不能撞已有 loop：编辑已有 loop 走 selectedId 分支（允许覆盖自己的文件）。
    if (!selectedId && (list?.loops ?? []).some((loop) => loop.id === draft.id)) {
      setLocalError(tr("settings.loop.idExists", { id: draft.id }));
      return;
    }
    setSaving(true);
    setLocalError(null);
    setNote(null);
    const api = window.loopsoarAPI;
    if (!api) {
      setLocalError("未在 Electron shell 中运行（window.loopsoarAPI 不存在）");
      setSaving(false);
      return;
    }
    try {
      const parsedStages = customMode ? parseCustomStages(customText) : null;
      if (parsedStages?.error || (customMode && !parsedStages?.stages?.length)) {
        setLocalError(`完全自定义阶段：${parsedStages?.error ?? "不能为空"}`);
        return;
      }
      const stagesToSave = customMode ? parsedStages!.stages! : (draft.stages ?? DEFAULT_STAGES);
      const config: LoopEditorConfig = {
        kind: "declarative",
        id: draft.id,
        name: draft.name.trim(),
        ...(draft.description?.trim() ? { description: draft.description.trim() } : {}),
        ...(draft.systemPromptAppend?.trim() ? { systemPromptAppend: draft.systemPromptAppend.trim() } : {}),
        ...(draft.maxRounds !== undefined ? { maxRounds: draft.maxRounds } : {}),
        ...(draft.maxToolCalls !== undefined ? { maxToolCalls: draft.maxToolCalls } : {}),
        stages: stagesToSave,
        ...(draft.allowedTools && draft.allowedTools.length > 0 ? { allowedTools: draft.allowedTools } : {}),
        ...(draft.temperature !== undefined ? { temperature: draft.temperature } : {}),
      };
      const result = await api.loop.save({ config, activate });
      if (!result.ok) {
        setLocalError(result.error ?? tr("settings.loop.saveFailed"));
        return;
      }
      const saved = result.savedId ?? config.id;
      setSelectedId(saved);
      setNote(tr(activate ? "settings.loop.savedActive" : "settings.loop.saved", { id: saved }));
      if (result.loops) {
        const entry = result.loops.find((loop: LoopInfo) => loop.id === saved);
        if (entry) setSelectedReadonly(entry.editable ? null : entry);
      }
      await refresh();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  /** 直接启用当前选中的 loop，不必再编译一次；下一轮对话即生效。 */
  async function activateSelected(): Promise<void> {
    if (!selectedId) return;
    const api = window.loopsoarAPI;
    if (!api) {
      setLocalError("未在 Electron shell 中运行（window.loopsoarAPI 不存在）");
      return;
    }
    setSaving(true);
    setLocalError(null);
    setNote(null);
    try {
      const result = await api.loop.setActive({ id: selectedId });
      if (!result.ok) {
        setLocalError(result.error ?? tr("settings.loop.saveFailed"));
        return;
      }
      setNote(tr("settings.loop.activated", { id: selectedId }));
      await refresh();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove(): Promise<void> {
    if (!selectedId) return;
    const ok = window.confirm(tr("settings.loop.confirmDelete", { id: selectedId }));
    if (!ok) return;
    const api = window.loopsoarAPI;
    if (!api) {
      setLocalError("未在 Electron shell 中运行（window.loopsoarAPI 不存在）");
      return;
    }
    try {
      const result = await api.loop.delete({ id: selectedId });
      if (!result.ok) {
        setLocalError(result.error ?? tr("settings.loop.deleteFailed"));
        return;
      }
      setSelectedId(null);
      setDraft(null);
      setSelectedReadonly(null);
      setNote(tr("settings.loop.deleted", { id: result.deletedId ?? selectedId }));
      await refresh();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    }
  }

  const loops = list?.loops ?? [];
  const activeId = list?.activeId ?? null;

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>{tr("settings.loop.title")}</div>
        <div style={{ marginTop: 4, fontSize: 11.5, color: BRAND.linenMuted, lineHeight: 1.6 }}>
          {tr("settings.loop.hint")}
        </div>
      </div>

      <div style={compressCard}>
        <div style={S.rowBetween}>
          <div style={compressTitle}>{tr("settings.loop.compressTitle")}</div>
          <span style={compressPill}>{Math.round(compressRatio * 100)}%</span>
        </div>
        <div style={compressText}>
          {tr("settings.loop.compressBody", {
            pct: Math.round(compressRatio * 100),
            target: Math.round(Math.max(0.35, compressRatio - 0.2) * 100),
          })}
        </div>

        <div style={compressFoot}>
          <span>{tr("settings.loop.applyHint")}</span>
          {onOpenGeneral ? (
            <Btn label={tr("settings.loop.compressAction")} small onClick={onOpenGeneral} />
          ) : null}
        </div>
      </div>

      {localError ? <div style={errBox}>{localError}</div> : null}
      {note ? <div style={okBox}>{note}</div> : null}

      <div style={layout}>
        <div style={listCol}>
          <div style={{ ...S.rowBetween, marginBottom: 8 }}>
            <span style={S.tag}>{tr("settings.loop.count", { n: loops.length })}</span>
            <div style={{ display: "flex", gap: 6 }}>
              <Btn label={tr("settings.loop.modeCustom")} small onClick={startNewCustom} />
              <Btn label={tr("settings.loop.new")} small primary onClick={startNew} />
            </div>
          </div>
          {loops.length === 0 ? <div style={emptyBox}>{tr("settings.loop.empty")}</div> : null}
          {loops.map((loop) => {
            const active = loop.active;
            const editable = Boolean(loop.editable);
            return (
              <button
                key={loop.id}
                type="button"
                onClick={() => void select(loop)}
                style={{
                  ...loopRow,
                  ...(selectedId === loop.id ? loopRowOn : {}),
                  ...(loop.valid === false ? loopRowInvalid : {}),
                }}
                title={loop.error ?? loop.description ?? loop.id}
              >
                <span style={{ ...loopDot, ...(active ? loopDotOn : {}) }} />
                <span style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
                  <span style={loopName}>{loop.name}</span>
                  <span style={loopMeta}>
                    <span style={BADGE.neutral}>{loop.kind ?? "builtin"}</span>
                    <span style={S.tag}>{editable ? tr("settings.loop.editable") : tr("settings.loop.readonly")}</span>
                  </span>
                </span>
                {active ? <span style={activePill}>{tr("settings.loop.active")}</span> : null}
              </button>
            );
          })}
        </div>

        <div style={editorCol}>
          {loading ? <div style={emptyBox}>{tr("settings.loop.loading")}</div> : null}
          {!loading && !draft && !selectedReadonly ? (
            <div style={emptyBox}>{tr("settings.loop.pick")}</div>
          ) : null}

          {!loading && selectedReadonly ? (
            <div>
              <div style={S.rowBetween}>
                <div style={{ fontSize: 13.5, fontWeight: 700 }}>{selectedReadonly.name}</div>
                <span style={BADGE.neutral}>{selectedReadonly.kind ?? "builtin"}</span>
              </div>
              <div style={{ marginTop: 8, fontSize: 11.5, color: BRAND.linenMuted, lineHeight: 1.7 }}>
                {selectedReadonly.error ?? selectedReadonly.description ?? tr("settings.loop.readonlyHint")}
              </div>
              <div style={{ ...S.rowEnd, marginTop: 14 }}>
                <Btn label={tr("settings.loop.clone")} onClick={fromReadonly} />
              </div>
            </div>
          ) : null}

          {!loading && draft ? (
            <div>
              <div style={S.rowBetween}>
                <div style={{ fontSize: 13.5, fontWeight: 700 }}>
                  {selectedId ? tr("settings.loop.editTitle", { id: selectedId }) : tr("settings.loop.newTitle")}
                </div>
                <span style={S.tag}>{stageSummary(draft, customMode, customText)}</span>
              </div>

              <div style={formGrid}>
                <Field l={tr("settings.loop.name")} h={tr("settings.loop.nameHint")}>
                  <In v={draft.name} on={(name) => update({ name })} ph="网页调研" style={{ maxWidth: "none" }} />
                </Field>
                <Field l={tr("settings.loop.id")} h={tr("settings.loop.idHint")}>
                  <In
                    v={draft.id}
                    on={(id) => update({ id })}
                    ph="web-research"
                    disabled={Boolean(selectedId)}
                    style={{ maxWidth: "none" }}
                  />
                </Field>
              </div>
              <Field l={tr("settings.loop.description")} h={tr("settings.loop.descriptionHint")}>
                <In
                  v={draft.description ?? ""}
                  on={(description) => update({ description })}
                  ph={tr("settings.loop.descriptionPh")}
                  style={{ maxWidth: "none" }}
                />
              </Field>
              <Field l={tr("settings.loop.prompt")} h={tr("settings.loop.promptHint")}>
                <Area
                  v={draft.systemPromptAppend ?? ""}
                  rows={4}
                  full
                  on={(systemPromptAppend) => update({ systemPromptAppend })}
                  ph={tr("settings.loop.promptPh")}
                />
              </Field>

              <div style={stageHead}>
                <div>
                  <div style={stageTitle}>{tr("settings.loop.stages")}</div>
                  <div style={stageHint}>{customMode ? tr("settings.loop.customHint") : tr("settings.loop.stagesHint")}</div>
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
                  <Seg
                    v={customMode ? "custom" : "builtin"}
                    opts={[
                      ["builtin", tr("settings.loop.modeBuiltin")],
                      ["custom", tr("settings.loop.modeCustom")],
                    ]}
                    on={(mode) => setEditorMode(mode === "custom" ? "custom" : "builtin")}
                  />
                  {!customMode ? (
                    <>
                      <Btn label={tr("settings.loop.allOn")} small onClick={() => {
                        update({ stages: STAGES.map((stage) => ({ id: stage.id, enabled: true })) });
                      }} />
                      <Btn label={tr("settings.loop.allOff")} small onClick={() => {
                        update({ stages: STAGES.map((stage) => ({ id: stage.id, enabled: false })) });
                      }} />
                    </>
                  ) : null}
                </div>
              </div>
              {customMode ? (
                <div style={customBox}>
                  <Area
                    v={customText}
                    rows={14}
                    full
                    on={setCustomText}
                    ph={'[\n  { "id": "scout", "name": "侦察", "enabled": true, "tools": ["web_search"], "prompt": "先搜索并汇总候选来源" }\n]'}
                  />
                  <div style={customExample}>
                    {tr("settings.loop.customHelp")}
                  </div>
                </div>
              ) : (
                <div style={stageGrid}>
                  {STAGES.map((stage) => {
                    const enabled = (draft.stages ?? DEFAULT_STAGES).find((item) => item.id === stage.id)?.enabled ?? true;
                    return (
                      <div key={stage.id} style={{ ...stageCard, ...(enabled ? {} : stageCardOff) }}>
                        <div style={S.rowBetween}>
                          <span style={stageLabel}>{stage.label}</span>
                          <Toggle v={enabled} on={(next) => setStage(stage.id, next)} title={stage.label} />
                        </div>
                        <div style={stageDesc}>{stage.desc}</div>
                        <div style={stageTools}>{stage.tools.join(" · ")}</div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div style={formGrid}>
                <Field l={tr("settings.loop.rounds")} h={tr("settings.loop.roundsHint")}>
                  <In
                    v={String(draft.maxRounds ?? "")}
                    on={(value) => update({ maxRounds: value.trim() ? Number(value) : undefined })}
                    type="number"
                    style={{ maxWidth: "none" }}
                  />
                </Field>
                <Field l={tr("settings.loop.calls")} h={tr("settings.loop.callsHint")}>
                  <In
                    v={String(draft.maxToolCalls ?? "")}
                    on={(value) => update({ maxToolCalls: value.trim() ? Number(value) : undefined })}
                    type="number"
                    style={{ maxWidth: "none" }}
                  />
                </Field>
              </div>

              <Field l={tr("settings.loop.allowed")} h={tr("settings.loop.allowedHint")}>
                <In
                  v={(draft.allowedTools ?? []).join(", ")}
                  on={(value) => update({
                    allowedTools: value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean),
                  })}
                  ph="browser_click, browser_type"
                  style={{ maxWidth: "none" }}
                />
              </Field>

              <div style={footerRow}>
                <label style={checkRow}>
                  <input
                    type="checkbox"
                    checked={activate}
                    onChange={(event) => setActivate(event.target.checked)}
                  />
                  {tr("settings.loop.activate")}
                </label>
                <div style={{ display: "flex", gap: 8 }}>
                  {selectedId && activeId !== selectedId ? (
                    <Btn label={tr("settings.loop.activateNow")} small onClick={() => void activateSelected()} />
                  ) : null}
                  {selectedId ? <Btn label={tr("settings.loop.delete")} small onClick={() => void remove()} /> : null}
                  <Btn label={saving ? tr("settings.loop.saving") : tr("settings.loop.compile")} primary onClick={() => void save()} />
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const compressCard: React.CSSProperties = {
  border: `1px solid ${BRAND.border}`,
  borderRadius: 10,
  padding: "10px 12px",
  marginBottom: 12,
  background: "rgba(var(--ls-accent-rgb), 0.04)",
};
const compressTitle: React.CSSProperties = { fontSize: 12.5, fontWeight: 700 };
const compressPill: React.CSSProperties = {
  fontSize: 11,
  padding: "1px 7px",
  borderRadius: 999,
  border: `1px solid ${BRAND.border}`,
  color: BRAND.linenMuted,
};
const compressText: React.CSSProperties = {
  marginTop: 4,
  fontSize: 11.5,
  color: BRAND.linenMuted,
  lineHeight: 1.65,
};
const compressFoot: React.CSSProperties = {
  marginTop: 8,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  fontSize: 11.5,
  color: BRAND.linenMuted,
};

const layout: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(220px, 0.9fr) minmax(0, 2fr)",
  gap: 14,
  alignItems: "start",
};
const listCol: React.CSSProperties = {
  padding: "2px 0",
  display: "flex",
  flexDirection: "column",
  gap: 2,
  minWidth: 0,
};
const editorCol: React.CSSProperties = {
  border: `1px solid ${BRAND.border}`,
  borderRadius: 10,
  padding: 14,
  background: BRAND.inkPanel,
  minWidth: 0,
};
const loopRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  border: "none",
  borderRadius: 8,
  background: "transparent",
  color: BRAND.linen,
  padding: "7px 8px",
  cursor: "pointer",
};
const loopRowOn: React.CSSProperties = {
  background: BRAND.ochreSoft,
  boxShadow: `inset 2px 0 0 ${BRAND.ochre}`,
};
const loopRowInvalid: React.CSSProperties = { opacity: 0.6 };
const loopDot: React.CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: "50%",
  background: BRAND.borderStrong,
  flexShrink: 0,
};
const loopDotOn: React.CSSProperties = { background: BRAND.ochre, boxShadow: `0 0 8px ${BRAND.ochre}` };
const loopName: React.CSSProperties = {
  display: "block",
  fontSize: 12.5,
  fontWeight: 600,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const loopMeta: React.CSSProperties = { display: "flex", alignItems: "center", gap: 5, marginTop: 3 };
const activePill: React.CSSProperties = {
  fontSize: 10,
  color: BRAND.ink,
  background: BRAND.ochre,
  borderRadius: 999,
  padding: "1px 6px",
  flexShrink: 0,
};
const emptyBox: React.CSSProperties = {
  border: `1px dashed ${BRAND.border}`,
  borderRadius: 8,
  padding: "18px 12px",
  fontSize: 11.5,
  color: BRAND.linenFaint,
  textAlign: "center",
  lineHeight: 1.6,
};
const errBox: React.CSSProperties = {
  border: `1px solid ${BRAND.danger ?? "#c1554a"}`,
  background: "rgba(193,85,74,0.12)",
  color: BRAND.linen,
  borderRadius: 8,
  padding: "8px 10px",
  fontSize: 11.5,
  marginBottom: 10,
  lineHeight: 1.6,
};
const okBox: React.CSSProperties = {
  border: `1px solid ${BRAND.ochre}`,
  background: BRAND.ochreSoft,
  color: BRAND.linen,
  borderRadius: 8,
  padding: "8px 10px",
  fontSize: 11.5,
  marginBottom: 10,
};
const formGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 10,
};
const stageHead: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  margin: "14px 0 8px",
  paddingTop: 12,
  borderTop: `1px solid ${BRAND.border}`,
};
const customBox: React.CSSProperties = {
  display: "grid",
  gap: 8,
  padding: "2px 0 12px",
};
const customExample: React.CSSProperties = {
  fontSize: 11.5,
  lineHeight: 1.6,
  color: BRAND.linenMuted,
};
const stageTitle: React.CSSProperties = { fontSize: 12.5, fontWeight: 700 };
const stageHint: React.CSSProperties = { marginTop: 3, fontSize: 10.5, color: BRAND.linenFaint };
const stageGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
  gap: 8,
  marginBottom: 12,
};
const stageCard: React.CSSProperties = {
  border: `1px solid ${BRAND.border}`,
  borderRadius: 8,
  padding: "8px 9px",
  background: BRAND.ink,
  minWidth: 0,
};
const stageCardOff: React.CSSProperties = { opacity: 0.5 };
const stageLabel: React.CSSProperties = { fontSize: 12, fontWeight: 700 };
const stageDesc: React.CSSProperties = { marginTop: 4, fontSize: 10.5, color: BRAND.linenMuted, lineHeight: 1.5 };
const stageTools: React.CSSProperties = {
  marginTop: 5,
  fontSize: 9.5,
  color: BRAND.linenFaint,
  fontFamily: "ui-monospace, Consolas, monospace",
  lineHeight: 1.5,
  overflowWrap: "anywhere",
};
const footerRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  marginTop: 12,
  paddingTop: 12,
  borderTop: `1px solid ${BRAND.border}`,
};
const checkRow: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  fontSize: 11.5,
  color: BRAND.linenMuted,
  cursor: "pointer",
};
