import React, { useCallback, useEffect, useMemo, useState } from "react";
import { BRAND, BADGE } from "./theme.js";
import {
  HEADER_TEMPLATE_VARIABLES,
  unknownHeaderTemplateVariables,
} from "loopsoar-contracts/headerTemplate";
import TopicRail from "./TopicRail.js";
import { DEFAULT_CHAT_RAIL, loadRailParams, saveRailParams, type RailParams } from "./railParams.js";
import { Icon } from "./Icon.js";
import { getLanguage, setLanguage, useT } from "./i18n.js";
import type {
  AboutInfo, DiagnosticsInfo, ExtensionRuntimeStatus, InstalledExtension, LocationsInfo, LoopInfo,
  LoopListResult, LoopsoarAPI, McpServerInfo, MemoryListResult, PermissionCategory, PermissionsState, Preferences,
  ProviderItem, ProviderModel, ProviderStatus, RulesSnapshot, SkillRecord, TestProviderResult,
} from "./types.js";

/**
 * 设置面板：通用 / 外观 / 权限（含安全）/ 供应商 / 规则 / 技能 / 记忆 / 扩展 / MCP /
 * 存储 / 高级 / 关于。
 * 全部数据经 preload 白名单；规则与记忆在保存后即时生效（主进程惰性读取）。
 *
 * i18n：界面文案全部走 `tr("settings.*")`，词典在 i18nSettings.ts（zh/en 成对）；
 * 语言切换由 i18n.ts 的 setLanguage 广播，本组件通过 useT 订阅即时重渲染。
 */

/** 翻译函数签名（与 i18n.ts 的 useT 返回一致）。 */
type TFunc = (key: string, params?: Record<string, string | number>) => string;

type SectionId =
  | "general"
  | "appearance"
  | "permissions"
  | "providers"
  | "rules"
  | "skills"
  | "memory"
  | "extensions"
  | "mcp"
  | "storage"
  | "advanced"
  | "about";

/** 侧栏分区：group 为分组 key（渲染时再翻译，避免语言切换后仍是旧语言）。 */
const SECTIONS: { id: SectionId; icon: string; group: "basic" | "capability" | "data" | "other" }[] = [
  { id: "general", group: "basic", icon: "settings" },
  { id: "appearance", group: "basic", icon: "capture" },
  { id: "permissions", group: "basic", icon: "check" },
  { id: "providers", group: "capability", icon: "cloud-upload" },
  { id: "rules", group: "capability", icon: "file" },
  { id: "skills", group: "capability", icon: "bulb" },
  { id: "memory", group: "capability", icon: "notes" },
  { id: "extensions", group: "capability", icon: "puzzle" },
  { id: "mcp", group: "capability", icon: "terminal" },
  { id: "storage", group: "data", icon: "folders" },
  { id: "advanced", group: "data", icon: "terminal" },
  { id: "about", group: "other", icon: "bulb" },
];

interface DraftRule {
  key: string; name: string; scope: "global" | "workspace";
  enabled: boolean; content: string; persisted: boolean; path: string;
}

/** 取翻译；key 缺失（词典未覆盖）时回退到调用方给的原文，绝不显示裸 key。 */
function localized(tr: TFunc, key: string, fallback: string): string {
  const text = tr(key);
  return text === key ? fallback : text;
}

/** Agent-Loop 类型推导：builtin 标记优先，其余按 id 约定（声明式 decl… / 脚本 script…）。 */
function loopKindOf(loop: LoopInfo): "builtin" | "declarative" | "script" | "custom" {
  if (loop.builtin) return "builtin";
  // 后端已带真实 kind 时直接用（L2 声明式 / L3 脚本），否则按 id 约定兜底
  if (loop.kind === "declarative" || loop.kind === "script") return loop.kind;
  const id = loop.id.toLowerCase();
  if (id.includes("decl")) return "declarative";
  if (id.includes("script") || /\.(m?js|cjs|ts|py)$/.test(id)) return "script";
  return "custom";
}

export default function Settings({ api, onClose, onPreferencesSaved, initialSection, onOpenOnboarding, fullPage = false }: {
  api: LoopsoarAPI | null; onClose: () => void; onPreferencesSaved?: (p: Preferences) => void; initialSection?: SectionId;
  /** 「关于」分区重新打开新手引导（由 App 接线；缺省则不显示入口）。 */
  onOpenOnboarding?: () => void;
  /**
   * 整页模式（ChromePage「设置」页）：去掉居中模态外壳与自身标题栏并铺满父容器，
   * 分区导航与全部功能保持不变（标题与返回按钮由 ChromePage 顶栏提供）。
   */
  fullPage?: boolean;
}): React.JSX.Element {
  const tr = useT();
  const [section, setSection] = useState<SectionId>(initialSection ?? "general");
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [locations, setLocations] = useState<LocationsInfo | null>(null);
  const [perms, setPerms] = useState<PermissionsState | null>(null);
  const [provider, setProvider] = useState<ProviderStatus | null>(null);
  const [pForm, setPForm] = useState({ provider: "", baseUrl: "", model: "" });
  /** 自定义请求头（Key: Value 每行一条；保存前解析）。 */
  const [pHeaders, setPHeaders] = useState("");
  const [providerItems, setProviderItems] = useState<ProviderItem[]>([]);
  const [activeProviderId, setActiveProviderId] = useState<string | null>(null);
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [extensions, setExtensions] = useState<InstalledExtension[]>([]);
  const [extensionRuntime, setExtensionRuntime] = useState<Record<string, ExtensionRuntimeStatus>>({});
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [skillsDir, setSkillsDir] = useState("");
  const [skillSkips, setSkillSkips] = useState<{ dir: string; reason: string }[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([]);
  const [mcpConfigPath, setMcpConfigPath] = useState("");
  const [mcpForm, setMcpForm] = useState({ name: "", transport: "stdio" as "stdio" | "http", command: "", args: "", url: "" });
  const [keyInput, setKeyInput] = useState("");
  const [pModels, setPModels] = useState<ProviderModel[]>([]);
  const [pModelsError, setPModelsError] = useState<string | null>(null);
  const [pFetching, setPFetching] = useState(false);
  const [pFormat, setPFormat] = useState<"auto" | "openai" | "anthropic">("auto");
  const [pRpm, setPRpm] = useState("");
  const [pModelDraft, setPModelDraft] = useState("");
  const [rail, setRail] = useState<RailParams>(() => (typeof window === "undefined" ? DEFAULT_CHAT_RAIL : loadRailParams()));
  const [extensionsDir, setExtensionsDir] = useState("");
  const [extensionSkips, setExtensionSkips] = useState<{ dir: string; reason: string }[]>([]);
  const [testRes, setTestRes] = useState<TestProviderResult | null>(null);
  const [rules, setRules] = useState<RulesSnapshot | null>(null);
  const [drafts, setDrafts] = useState<DraftRule[]>([]);
  const [deleted, setDeleted] = useState<string[]>([]);
  const [mem, setMem] = useState<MemoryListResult | null>(null);
  const [mForm, setMForm] = useState({ content: "", category: "general" });
  const [mEdit, setMEdit] = useState<{ id: string; content: string } | null>(null);
  const [diag, setDiag] = useState<DiagnosticsInfo | null>(null);
  const [about, setAbout] = useState<AboutInfo | null>(null);
  /** Agent-Loop：可运行 loop 列表 + 当前选择 + 回退历史（设置 · 通用）。 */
  const [loopInfo, setLoopInfo] = useState<LoopListResult | null>(null);
  const [loopBusy, setLoopBusy] = useState(false);
  /** 最近一次安全回退（有则显示在 Agent Loop 行下方；ADR-0010：回退可见）。 */
  const latestLoopFallback = loopInfo && loopInfo.fallbacks.length > 0 ? loopInfo.fallbacks[loopInfo.fallbacks.length - 1] : null;

  const ok = useCallback((text: string) => setNotice({ kind: "ok", text }), []);
  /** 供应商变更广播：主界面据此刷新模型 chip / 模型列表 */
  const notifyProviders = useCallback(() => {
    window.dispatchEvent(new Event("loopsoar:providers-changed"));
  }, []);
  const bad = useCallback((e: unknown) => setNotice({ kind: "error", text: e instanceof Error ? e.message : String(e) }), []);

  const applyRules = useCallback((r: RulesSnapshot) => {
    setRules(r);
    setDrafts(r.entries.map((x) => ({ key: x.id, name: x.name, scope: x.scope, enabled: x.enabled, content: x.content, persisted: true, path: x.path })));
    setDeleted([]);
  }, []);

  useEffect(() => {
    if (!api) { setLoading(false); return; }
    void (async () => {
      try {
        const [p, pm, pv, ru, dg, ab, mm, pvList, ext, sk, mc] = await Promise.allSettled([
          api.settings.getPreferences(), api.settings.getPermissions(), api.settings.getProvider(),
          api.settings.getRules(), api.settings.diagnostics(), api.settings.about(), api.memory.list(),
          api.settings.listProviders(), api.extensions.list(), api.skills.list(), api.mcp.list(),
        ]);
        if (p.status === "fulfilled") { setPrefs(p.value.preferences); setLocations(p.value.locations); }
        if (pm.status === "fulfilled") setPerms(pm.value);
        if (pv.status === "fulfilled") { setProvider(pv.value); setPForm({ provider: pv.value.provider ?? "", baseUrl: pv.value.baseUrl ?? "", model: pv.value.model ?? "" }); }
        if (ru.status === "fulfilled") applyRules(ru.value);
        if (dg.status === "fulfilled") setDiag(dg.value);
        if (ab.status === "fulfilled") setAbout(ab.value);
        if (mm.status === "fulfilled") setMem(mm.value);
        if (pvList.status === "fulfilled") {
          setProviderItems(pvList.value.items);
          setActiveProviderId(pvList.value.activeId);
          // 首次使用（无供应商）：直接展开添加表单，少一次点击
          if (pvList.value.items.length === 0) setEditingProviderId("new");
        }
        if (ext.status === "fulfilled") {
          setExtensions(ext.value.extensions);
          setExtensionsDir(ext.value.dir);
          setExtensionSkips(ext.value.skipped);
          setExtensionRuntime(ext.value.runtime ?? {});
        }
        if (sk.status === "fulfilled") {
          setSkills(sk.value.skills);
          setSkillsDir(sk.value.dir);
          setSkillSkips(sk.value.skipped);
        }
        if (mc.status === "fulfilled") {
          setMcpServers(mc.value.servers);
          setMcpConfigPath(mc.value.configPath);
        }
      } catch (e) { bad(e); } finally { setLoading(false); }
    })();
  }, [api, applyRules, bad]);

  // 通用设置实时生效：变更后 400ms 防抖自动保存（不需要保存按钮）
  useEffect(() => {
    if (!api || !prefs || loading) return;
    const timer = setTimeout(() => {
      void api.settings
        .setPreferences(prefs)
        .then((r) => onPreferencesSaved?.(r.preferences))
        .catch(() => {});
    }, 400);
    return () => clearTimeout(timer);
  }, [api, prefs, loading, onPreferencesSaved]);

  // 扩展运行状态异步就绪：监听 extensions:updated 刷新列表（否则刚打开设置会显示「未启动」）
  useEffect(() => {
    if (!api) return;
    const off = api.on("extensions:updated", () => {
      void api.extensions
        .list()
        .then((r) => {
          setExtensions(r.extensions);
          setExtensionRuntime(r.runtime ?? {});
        })
        .catch(() => {});
    });
    return off;
  }, [api]);

  /* ── Agent-Loop：打开设置时拉取；loop:changed / loop:fallback 事件同步刷新并提示 ── */
  const refreshLoops = useCallback(async (): Promise<void> => {
    if (!api) return;
    try {
      setLoopInfo(await api.loop.list());
    } catch {
      // 旧 shell 未装配 loop 域：显示「不可用」而不是把设置页打成错误（不影响其他分区）
      setLoopInfo(null);
    }
  }, [api]);

  /** 重新扫描 loops/ 目录（L2 声明式 / L3 脚本），失败不阻断其他分区。 */
  const reloadLoops = useCallback(async (): Promise<void> => {
    if (!api || loopBusy) return;
    setLoopBusy(true);
    try {
      setLoopInfo(await api.loop.reload());
      ok(tr("settings.general.loopReloaded"));
    } catch (e) {
      bad(e);
    } finally {
      setLoopBusy(false);
    }
  }, [api, loopBusy, ok, bad, tr]);

  useEffect(() => {
    void refreshLoops();
  }, [refreshLoops]);

  useEffect(() => {
    if (!api) return;
    const offs: Array<() => void> = [];
    try {
      offs.push(
        api.on("loop:changed", (payload) => {
          const info = payload as { activeId?: string | null; loops?: LoopInfo[] };
          // 事件已带最新列表：直接更新（少一次 IPC）；没有就回退到拉取
          if (Array.isArray(info?.loops)) {
            setLoopInfo((prev) => ({ loops: info.loops as LoopInfo[], activeId: info.activeId ?? null, fallbacks: prev?.fallbacks ?? [] }));
          } else {
            void refreshLoops();
          }
          // 同步本地偏好副本里的 loopId（否则之后任何一次通用设置自动保存都可能把旧值写回）
          if (typeof info?.activeId === "string") {
            const activeId = info.activeId;
            setPrefs((prev) => (prev && prev.loopId !== activeId ? { ...prev, loopId: activeId } : prev));
          }
        }),
      );
    } catch {
      // 旧 shell 事件白名单未含 loop:changed：静默降级（不折叠整个设置面板）
    }
    try {
      offs.push(
        api.on("loop:fallback", (payload) => {
          const info = payload as { reason?: string; at?: number };
          // ADR-0010：回退必须可见——设置页里也要把原因提示出来
          setNotice({ kind: "error", text: tr("settings.general.loopFallbackNotice", { reason: info?.reason ?? tr("settings.unknown") }) });
          void refreshLoops();
        }),
      );
    } catch {
      // 同上
    }
    return () => {
      for (const off of offs) off();
    };
  }, [api, refreshLoops, tr]);

  const chooseLoop = useCallback(async (loop: LoopInfo): Promise<void> => {
    if (!api || loopBusy || loop.active) return;
    setLoopBusy(true);
    try {
      const result = await api.loop.setActive({ id: loop.id });
      if (!result?.ok) {
        bad(result?.error ?? tr("settings.general.loopSwitchFailed"));
        return;
      }
      // 成功返回里带最新列表（域层 {ok:true, ...LoopListPayload}）；没有则再拉一次兜底
      if (Array.isArray(result.loops)) {
        setLoopInfo({ loops: result.loops, activeId: result.activeId ?? null, fallbacks: result.fallbacks ?? [] });
      } else {
        setLoopInfo(await api.loop.list());
      }
      // 同步本地偏好副本里的 loopId：否则之后任何一次「通用设置」自动保存都会把旧 loopId 写回去
      setPrefs((prev) => (prev ? { ...prev, loopId: loop.id } : prev));
      ok(tr("settings.general.loopSwitched", { name: loop.name }));
    } catch (e) {
      bad(e);
    } finally {
      setLoopBusy(false);
    }
  }, [api, loopBusy, ok, bad, tr]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const savePrefs = useCallback(async () => {
    if (!api || !prefs) return;
    try { const r = await api.settings.setPreferences(prefs); setPrefs(r.preferences); onPreferencesSaved?.(r.preferences); ok(tr("settings.storage.saved")); }
    catch (e) { bad(e); }
  }, [api, prefs, onPreferencesSaved, ok, bad, tr]);

  const savePerms = useCallback(async () => {
    if (!api || !perms) return;
    try { const r = await api.settings.setPermissions(perms.permissions); setPerms({ ...perms, permissions: r.permissions }); ok(tr("settings.permissions.saved")); }
    catch (e) { bad(e); }
  }, [api, perms, ok, bad, tr]);

  const saveRules = useCallback(async () => {
    if (!api) return;
    try {
      const r = await api.settings.setRules({ entries: drafts.map((d) => ({ name: d.name.trim(), scope: d.scope, enabled: d.enabled, content: d.content })), deleted });
      applyRules(await api.settings.getRules());
      ok(tr("settings.rules.saved", { count: r.merged.included.length }));
    } catch (e) { bad(e); }
  }, [api, drafts, deleted, applyRules, ok, bad, tr]);

  const addDraft = (scope: "global" | "workspace") => setDrafts((v) => [...v, {
    key: `new-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
    name: scope === "global" ? tr("settings.rules.defaultGlobalName") : "AGENTS.md", scope, enabled: true, content: "", persisted: false, path: "",
  }]);

  const removeDraft = (d: DraftRule) => {
    setDrafts((v) => v.filter((x) => x.key !== d.key));
    if (d.persisted) setDeleted((v) => [...v, d.key]);
  };

  const addMemory = useCallback(async () => {
    if (!api || !mForm.content.trim()) return;
    try { await api.memory.add({ content: mForm.content.trim(), category: mForm.category || "general", importance: 5 }); setMForm({ content: "", category: "general" }); setMem(await api.memory.list()); ok(tr("settings.memory.added")); }
    catch (e) { bad(e); }
  }, [api, mForm, ok, bad, tr]);

  const saveMemEdit = useCallback(async () => {
    if (!api || !mEdit) return;
    try { await api.memory.update({ id: mEdit.id, content: mEdit.content }); setMEdit(null); setMem(await api.memory.list()); }
    catch (e) { bad(e); }
  }, [api, mEdit, bad]);

  const body = useMemo((): React.JSX.Element | null => {
    if (loading) return <div style={S.muted}>{tr("settings.loading")}</div>;
    if (!api) return <div style={S.muted}>{tr("settings.notInShell")}</div>;
    switch (section) {
      case "appearance": {
        const updateRail = (patch: Partial<RailParams>): void => {
          setRail(saveRailParams(patch));
        };
        const saveAnimations = (value: string): void => {
          if (!api || !prefs) return;
          const next = { ...prefs, animations: value as Preferences["animations"] };
          setPrefs(next);
          void api.settings
            .setPreferences(next)
            .then((r) => {
              setPrefs(r.preferences);
              onPreferencesSaved?.(r.preferences);
              ok(tr("settings.appearance.animationsSaved"));
            })
            .catch(bad);
        };
        const sliderDefs: { key: keyof Pick<RailParams, "w" | "amp" | "lam0" | "lam1" | "spd" | "tap">; label: string; min: number; max: number; step: number; fmt: (v: number) => string }[] = [
          { key: "w", label: tr("settings.appearance.slider.w"), min: 6, max: 32, step: 1, fmt: (v) => `${v}px` },
          { key: "amp", label: tr("settings.appearance.slider.amp"), min: 0, max: 100, step: 1, fmt: (v) => `${v}%` },
          { key: "lam0", label: tr("settings.appearance.slider.lam0"), min: 8, max: 400, step: 1, fmt: (v) => `${v}px` },
          { key: "lam1", label: tr("settings.appearance.slider.lam1"), min: 8, max: 400, step: 1, fmt: (v) => `${v}px` },
          { key: "spd", label: tr("settings.appearance.slider.spd"), min: 0, max: 4, step: 0.05, fmt: (v) => v.toFixed(2) },
          { key: "tap", label: tr("settings.appearance.slider.tap"), min: 0, max: 400, step: 5, fmt: (v) => `${v}px` },
        ];
        const previewLines = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => tr(`settings.appearance.demo.${n}`));
        return (
          <div>
            <Head t={tr("settings.appearance.head")} h={tr("settings.appearance.headHint")} />
            <div style={{ display: "flex", gap: 16, alignItems: "stretch", flexWrap: "wrap" }}>
              <div style={{ width: 320, maxWidth: "100%", flexShrink: 0 }}>
                <div style={S.fieldLabel}><span>{tr("settings.appearance.livePreview")}</span><span style={S.fieldHint}>{tr("settings.appearance.liveHint")}</span></div>
                <div style={{ position: "relative", height: 300, border: `1px solid ${BRAND.border}`, borderRadius: 10, overflow: "hidden", background: BRAND.ink }}>
                  <div id="loopsoar-rail-demo" className="chat-scroll" style={{ height: "100%", overflowY: "auto", padding: "10px 34px 10px 10px" }}>
                    {previewLines.map((line, i) => (
                      <div
                        key={i}
                        data-rail-label={line}
                        style={{
                          marginBottom: 10,
                          padding: "7px 9px",
                          borderRadius: 8,
                          background: i % 2 === 0 ? BRAND.ochreSoft : BRAND.inkRaised,
                          border: `1px solid ${BRAND.border}`,
                          fontSize: 11.5,
                          color: BRAND.linen,
                          lineHeight: 1.6,
                        }}
                      >
                        {line}
                      </div>
                    ))}
                  </div>
                  <TopicRail scroller={() => document.getElementById("loopsoar-rail-demo")} />
                </div>
                <div style={S.note}>{tr("settings.appearance.previewNote")}</div>
              </div>
              <div style={{ flex: 1, minWidth: 280 }}>
                <div className="panel-card" style={S.card}>
                  <div style={S.formHead}>{tr("settings.appearance.theme.head")}</div>
                  <Field l={tr("settings.appearance.theme.label")} h={tr("settings.appearance.theme.hint")}>
                    <Seg
                      v={prefs?.theme ?? "soft"}
                      opts={[
                        ["soft", tr("settings.appearance.theme.soft")],
                        ["classic", tr("settings.appearance.theme.classic")],
                      ]}
                      on={(x) => {
                        if (!prefs) return;
                        // theme 属于偏好：写入 prefs 后由通用 400ms 防抖 effect 调用 setPreferences 落盘
                        setPrefs({ ...prefs, theme: x as Preferences["theme"] });
                      }}
                    />
                  </Field>
                </div>
                <div className="panel-card" style={S.card}>
                  <div style={S.formHead}>{tr("settings.appearance.railParams")}</div>
                  {sliderDefs.map((item) => (
                    <div key={item.key} style={S.sliderRow}>
                      <span style={S.sliderLabel}>{item.label}</span>
                      <input
                        type="range"
                        min={item.min}
                        max={item.max}
                        step={item.step}
                        value={rail[item.key]}
                        onChange={(e) => updateRail({ [item.key]: Number(e.target.value) } as Partial<RailParams>)}
                        style={{ flex: 1, accentColor: BRAND.ochre }}
                      />
                      <span style={S.sliderValue}>{item.fmt(rail[item.key])}</span>
                    </div>
                  ))}
                  <div style={S.rowBetween}>
                    <label style={S.checkRow}>
                      <input type="checkbox" checked={rail.pause} onChange={(e) => updateRail({ pause: e.target.checked })} />
                      {tr("settings.appearance.pause")}
                    </label>
                    <label style={S.checkRow}>
                      <input type="checkbox" checked={rail.flip} onChange={(e) => updateRail({ flip: e.target.checked })} />
                      {tr("settings.appearance.flip")}
                    </label>
                  </div>
                  <div style={S.btns}>
                    <Btn label={tr("settings.appearance.restoreDefault")} onClick={() => setRail(saveRailParams({ ...DEFAULT_CHAT_RAIL }))} />
                  </div>
                </div>
                <div className="panel-card" style={S.card}>
                  <div style={S.formHead}>{tr("settings.appearance.motion")}</div>
                  <Field l={tr("settings.appearance.animations")} h={tr("settings.appearance.animationsHint")}>
                    <Seg
                      v={prefs?.animations ?? "full"}
                      opts={[
                        ["full", tr("settings.seg.full")],
                        ["reduced", tr("settings.seg.reduced")],
                        ["off", tr("settings.seg.off")],
                      ]}
                      on={saveAnimations}
                    />
                  </Field>
                  <div style={S.note}>{tr("settings.appearance.note")}</div>
                </div>
              </div>
            </div>
          </div>
        );
      }

      case "general":
        return prefs ? (<div>
          <Head t={tr("settings.general.head")} h={tr("settings.general.headHint")} />
          <Field l={tr("settings.general.language")}>
            <Seg
              v={prefs.language}
              opts={[
                ["zh-CN", tr("settings.lang.zh")],
                ["en-US", tr("settings.lang.en")],
              ]}
              on={(x) => {
                setPrefs({ ...prefs, language: x as Preferences["language"] });
                // 即时切换：i18n 广播 → useT 订阅者（含本面板）立即重渲染
                setLanguage(x);
              }}
            />
          </Field>
          <Field l={tr("settings.general.animations")} h={tr("settings.general.animationsHint")}>
            <Seg
              v={prefs.animations}
              opts={[
                ["full", tr("settings.seg.full")],
                ["reduced", tr("settings.seg.reduced")],
                ["off", tr("settings.seg.off")],
              ]}
              on={(x) => setPrefs({ ...prefs, animations: x as Preferences["animations"] })}
            />
          </Field>
          <Field l={tr("settings.general.searchEngine")}>
            <Seg v={prefs.searchEngine} opts={[["bing", "Bing"], ["google", "Google"], ["duckduckgo", "DuckDuckGo"]]} on={(x) => setPrefs({ ...prefs, searchEngine: x as Preferences["searchEngine"] })} />
          </Field>
          <Field l={tr("settings.general.adBlock")} h={tr("settings.general.adBlockHint")}>
            <Toggle v={prefs.adBlockEnabled ?? true} on={(x) => setPrefs({ ...prefs, adBlockEnabled: x })} />
          </Field>
          <Field l={tr("settings.general.restoreSession")}><Toggle v={prefs.restoreSession} on={(x) => setPrefs({ ...prefs, restoreSession: x })} /></Field>
          <Field l={tr("settings.general.maxRounds")} h={tr("settings.general.maxRoundsHint")}>
            <In
              v={String(prefs.agentMaxRounds ?? 40)}
              ph="40"
              on={(x) => setPrefs({ ...prefs, agentMaxRounds: Math.max(1, Math.min(500, Number(x) || 40)) })}
            />
          </Field>
          <Field l={tr("settings.general.maxToolCalls")} h={tr("settings.general.maxToolCallsHint")}>
            <In
              v={String(prefs.agentMaxToolCalls ?? 100)}
              ph="100"
              on={(x) => setPrefs({ ...prefs, agentMaxToolCalls: Math.max(1, Math.min(2000, Number(x) || 100)) })}
            />
          </Field>
          <Field l={tr("settings.general.repeatWarn")} h={tr("settings.general.repeatWarnHint")}>
            <In
              v={String(prefs.agentRepeatToolWarn ?? 5)}
              ph="5"
              on={(x) => setPrefs({ ...prefs, agentRepeatToolWarn: Math.max(2, Math.min(50, Number(x) || 5)) })}
            />
          </Field>
          <Field l={tr("settings.general.repeatStop")} h={tr("settings.general.repeatStopHint")}>
            <In
              v={String(prefs.agentRepeatToolStop ?? 30)}
              ph="30"
              on={(x) => setPrefs({ ...prefs, agentRepeatToolStop: Math.max(3, Math.min(200, Number(x) || 30)) })}
            />
          </Field>
          <Field l={tr("settings.general.memoryAuto")} h={tr("settings.general.memoryAutoHint")}><Toggle v={prefs.memoryAutoCapture} on={(x) => setPrefs({ ...prefs, memoryAutoCapture: x })} /></Field>
          <Field l={tr("settings.general.loop")} h={tr("settings.general.loopHint")}>
            <div className="loop-picker" aria-busy={loopBusy}>
              <div style={S.rowEnd}>
                <Btn label={tr("settings.general.loopReload")} small onClick={() => void reloadLoops()} />
              </div>
              {loopInfo ? (
                loopInfo.loops.length > 0 ? (
                  loopInfo.loops.map((loop) => {
                    const kind = loopKindOf(loop);
                    return (
                      <button
                        key={loop.id}
                        type="button"
                        className={`loop-item${loop.active ? " is-active" : ""}`}
                        disabled={loopBusy}
                        aria-pressed={loop.active}
                        title={loop.builtin ? tr("settings.general.loopBuiltinTitle") : tr("settings.general.loopCustomTitle")}
                        onClick={() => void chooseLoop(loop)}
                      >
                        <span className="loop-item-name">{loop.name}</span>
                        <span className="loop-item-tags">
                          <span style={kind === "builtin" ? BADGE.neutral : kind === "custom" ? BADGE.warn : BADGE.neutral}>
                            {tr(`settings.general.loopKind.${kind}`)}
                          </span>
                          {loop.active ? <span style={BADGE.ok}>{tr("settings.general.loopCurrent")}</span> : null}
                        </span>
                      </button>
                    );
                  })
                ) : (
                  <span className="loop-empty">{tr("settings.general.loopEmpty")}</span>
                )
              ) : (
                <span className="loop-empty">{tr("settings.general.loopUnavailable")}</span>
              )}
              {latestLoopFallback ? (
                <div className="loop-fallback" role="status">
                  {tr("settings.general.loopFallback", { when: formatWhen(latestLoopFallback.at, tr), reason: latestLoopFallback.reason })}
                </div>
              ) : null}
            </div>
          </Field>
          <div style={S.note}>{tr("settings.general.note")}</div>
        </div>) : <div style={S.muted}>{tr("settings.readFailed")}</div>;

      case "permissions": {
        // 权限类别文案来自 shell（c.label/c.description，中文）；已知类别映射到词典，未知类别回退原文
        const catLabel = (c: PermissionCategory): string => localized(tr, `settings.permissions.cat.${c.key}.label`, c.label);
        const catDesc = (c: PermissionCategory): string => localized(tr, `settings.permissions.cat.${c.key}.desc`, c.description);
        return perms ? (<div>
          <Head t={tr("settings.permissions.head")} h={tr("settings.permissions.headHint")} />
          {perms.categories.map((c) => (
            <Field key={c.key} l={catLabel(c)} h={catDesc(c)}>
              <Seg
                v={perms.permissions[c.key as keyof typeof perms.permissions] as string}
                opts={[
                  ["allow", tr("settings.permissions.allow")],
                  ["confirm", tr("settings.permissions.ask")],
                  ["deny", tr("settings.permissions.deny")],
                ]}
                on={(x) => setPerms({ ...perms, permissions: { ...perms.permissions, [c.key]: x } })}
              />
            </Field>
          ))}
          <Field l={tr("settings.permissions.confirmDangerous")}>
            <Toggle v={perms.permissions.confirmDangerousAlways} on={(x) => setPerms({ ...perms, permissions: { ...perms.permissions, confirmDangerousAlways: x } })} />
          </Field>
          <Field l={tr("settings.permissions.workspaceRoots")} h={tr("settings.permissions.workspaceRootsHint")}>
            <Area v={perms.permissions.workspaceRoots.join("\n")} rows={3} on={(x) => setPerms({ ...perms, permissions: { ...perms.permissions, workspaceRoots: x.split("\n").map((s) => s.trim()).filter(Boolean) } })} />
          </Field>
          <div style={S.note}>{tr("settings.permissions.currentRoot")}<code style={S.code}>{perms.workspaceRoot}</code></div>
          <div style={S.box}>
            <div style={S.boxTitle}>{tr("settings.permissions.securityTitle")}</div>
            {prefs ? (
              <Field l={tr("settings.permissions.sensitive")} h={tr("settings.permissions.sensitiveHint")}>
                <Toggle v={prefs.sensitiveAlwaysConfirm ?? true} on={(x) => setPrefs({ ...prefs, sensitiveAlwaysConfirm: x })} />
              </Field>
            ) : null}
          </div>
          <SaveBtn onClick={savePerms} label={tr("settings.permissions.save")} />
        </div>) : <div style={S.muted}>{tr("settings.readFailed")}</div>;
      }

      case "providers": {
        const refreshProviders = async (): Promise<void> => {
          const list = await api.settings.listProviders();
          setProviderItems(list.items);
          setActiveProviderId(list.activeId);
        };
        const resetModels = (): void => {
          setPModels([]);
          setPModelsError(null);
          setPModelDraft("");
        };
        const startEdit = (item?: ProviderItem): void => {
          if (item) {
            setEditingProviderId(item.id);
            setPForm({ provider: item.provider, baseUrl: item.baseUrl, model: item.model });
            setPHeaders(formatHeaderLines(item.headers));
            setPFormat(item.apiFormat ?? "auto");
            setPRpm(item.rpm ? String(item.rpm) : "");
            setPModels(item.models ?? [{ id: item.model, selected: true }]);
          } else {
            setEditingProviderId("new");
            setPForm({ provider: "", baseUrl: "", model: "" });
            setPHeaders("");
            setPFormat("auto");
            setPRpm("");
            resetModels();
          }
          setTestRes(null);
          setKeyInput("");
        };
        const fetchModels = async (): Promise<void> => {
          setPFetching(true);
          setPModelsError(null);
          try {
            const r = await api.settings.listModels({
              provider: pForm.provider,
              baseUrl: pForm.baseUrl,
              model: pForm.model,
              apiFormat: pFormat,
              apiKey: keyInput.trim() || undefined,
              headers: parseHeaderLines(pHeaders, tr) ?? undefined,
            });
            const existing = new Map(pModels.filter((m) => typeof m.id === "string" && m.id.trim()).map((m) => [m.id, m]));
            const merged = (r.models as ProviderModel[])
              .filter((m) => typeof m.id === "string" && m.id.trim())
              .map((m) => ({
                ...m,
                ...existing.get(m.id),
                // 新拉取的模型默认只启用当前默认模型，其余保持停用（用户可手动勾选）
                selected: existing.get(m.id)?.selected ?? m.selected ?? m.id === pForm.model,
              }));
            if (merged.length > 0) setPModels(merged);
            setPModelsError(r.error);
            if (!merged.some((m) => m.id === pForm.model)) {
              const first = merged.find((m) => m.selected !== false)?.id ?? merged[0]?.id ?? "";
              if (first) setPForm({ ...pForm, model: first });
            }
          } catch (e) {
            setPModelsError(e instanceof Error ? e.message : String(e));
          } finally {
            setPFetching(false);
          }
        };
        const addModelsFromDraft = (): void => {
          const ids = pModelDraft
            .split(/[\n,，]/)
            .map((x) => x.trim())
            .filter(Boolean);
          if (ids.length === 0) return;
          const next = [...pModels];
          for (const id of ids) if (!next.some((m) => m.id === id)) next.push({ id, selected: true });
          setPModels(next);
          setPModelDraft("");
          if (!pForm.model) setPForm({ ...pForm, model: ids[0] });
        };
        const updateModel = (idx: number, patch: Partial<ProviderModel>): void => {
          setPModels((prev) => prev.map((m, i) => (i === idx ? { ...m, ...patch } : m)));
        };
        const removeModel = (idx: number): void => {
          setPModels((prev) => prev.filter((_, i) => i !== idx));
        };
        const commit = async (): Promise<void> => {
          try {
            const models = pModels.filter((m) => m.id.trim());
            const defaultModel = pForm.model.trim() || models.find((m) => m.selected !== false)?.id || models[0]?.id || "";
            if (!defaultModel) throw new Error(tr("settings.providers.needModel"));
            const r = await api.settings.upsertProvider({
              ...(editingProviderId && editingProviderId !== "new" ? { id: editingProviderId } : {}),
              provider: pForm.provider,
              baseUrl: pForm.baseUrl,
              model: defaultModel,
              apiFormat: pFormat,
              rpm: pRpm.trim() ? Number(pRpm) : undefined,
              headers: parseHeaderLines(pHeaders, tr) ?? undefined,
              models,
            });
            await api.settings.setActiveProvider({ id: r.item.id });
            if (keyInput.trim()) {
              await api.settings.setApiKey({ providerId: r.item.id, apiKey: keyInput.trim() });
              setKeyInput("");
            }
            await refreshProviders();
            setEditingProviderId(null);
            await api.settings.getProvider().then(setProvider).catch(() => {});
            notifyProviders();
            ok(tr("settings.providers.saved"));
          } catch (e) {
            bad(e);
          }
        };
        const protoLabel = (f?: string): string =>
          f === "anthropic" ? tr("settings.providers.proto.anthropic") : f === "openai" ? tr("settings.providers.proto.openai") : tr("settings.providers.proto.auto");
        const presets: { name: string; provider: string; baseUrl: string; model: string; headers?: Record<string, string> }[] = [
          { name: "DeepSeek", provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
          { name: "OpenAI", provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
          { name: "OpenRouter", provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", model: "deepseek/deepseek-chat" },
          { name: "Agnes", provider: "agnes", baseUrl: "https://api.agnes-ai.cn/v1", model: "agnes-3.0-flash" },
          { name: tr("settings.providers.localPreset"), provider: "local", baseUrl: "http://127.0.0.1:8080/v1", model: "local-model" },
          {
            name: "OpenCode Go",
            provider: "opencode-go",
            baseUrl: "https://opencode.ai/inference/go/openai/v1",
            model: "glm-5.3",
            headers: { "x-opencode-session": "{{sessionId}}", "User-Agent": "Loopsoar/1.0" },
          },
        ];
        return (
          <div>
            <Head t={tr("settings.providers.head")} h={tr("settings.providers.headHint")} />
            {providerItems.map((item) => {
              const spec = item.models?.find((m) => m.id === item.model);
              return (
                <div key={item.id} className="panel-card" style={S.card}>
                  <div style={S.rowBetween}>
                    <span style={S.meta}>
                      <button
                        type="button"
                        className="icon-btn"
                        title={item.id === activeProviderId ? tr("settings.providers.currentActive") : tr("settings.providers.setActive")}
                        onClick={() => void api.settings.setActiveProvider({ id: item.id }).then(async () => { await refreshProviders(); await api.settings.getProvider().then(setProvider).catch(() => {}); notifyProviders(); })}
                        style={{ width: 20, height: 20 }}
                      >
                        <Icon name={item.id === activeProviderId ? "check" : "cloud-upload"} size={13} />
                      </button>
                      <span style={S.metaTitle}>{item.provider}</span>
                      <span style={item.id === activeProviderId ? BADGE.ok : BADGE.neutral}>{item.id === activeProviderId ? tr("settings.providers.active") : tr("settings.providers.backup")}</span>
                      <span style={BADGE.neutral}>{protoLabel(item.apiFormat)}</span>
                      <span style={S.tag}>{tr("settings.providers.modelCount", { count: item.models?.length ?? 1 })}</span>
                      {item.rpm ? <span style={S.tag}>RPM {item.rpm}</span> : null}
                    </span>
                    <span style={S.icons}>
                      <Btn label={tr("settings.test")} small onClick={() => void api.settings.testProvider({ provider: item.provider, baseUrl: item.baseUrl, model: item.model, headers: item.headers }).then(setTestRes).catch(bad)} />
                      <Btn label={tr("settings.edit")} small onClick={() => startEdit(item)} />
                      <Btn label={tr("settings.delete")} small onClick={() => void api.settings.removeProvider({ id: item.id }).then(async () => { await refreshProviders(); await api.settings.getProvider().then(setProvider).catch(() => {}); notifyProviders(); }).catch(bad)} />
                    </span>
                  </div>
                  <div style={S.providerRows}>
                    <div style={S.providerRow}><span style={S.providerKey}>{tr("settings.providers.interfaceAddr")}</span><span style={S.providerVal}>{item.baseUrl}</span></div>
                    {item.headers && Object.keys(item.headers).length > 0 ? (
                      <div style={S.providerRow}><span style={S.providerKey}>{tr("settings.providers.headers")}</span><span style={S.providerVal}>{tr("settings.providers.headerCount", { count: Object.keys(item.headers).length })}</span></div>
                    ) : null}
                    <div style={S.providerRow}>
                      <span style={S.providerKey}>{tr("settings.providers.defaultModel")}</span>
                      <span style={S.providerVal}>
                        {item.model}
                        {spec ? tr("settings.providers.specLine", {
                          context: spec.contextWindow ? `${Math.round(spec.contextWindow / 1000)}K` : "—",
                          output: spec.maxOutput ? `${Math.round(spec.maxOutput / 1000)}K` : "—",
                          vision: spec.vision ? tr("settings.providers.specVision") : "",
                          thinking: spec.thinking ? tr("settings.providers.specThinking") : "",
                        }) : ""}
                      </span>
                    </div>
                    <div style={S.providerRow}>
                      <span style={S.providerKey}>{tr("settings.providers.key")}</span>
                      <span style={S.providerVal}>
                        {item.hasKey
                          ? tr("settings.providers.keySaved", {
                              hint: item.keyHint ?? "",
                              source: item.keySource === "env" ? tr("settings.providers.keyFromEnv") : tr("settings.providers.keychain"),
                            })
                          : tr("settings.providers.keyMissing")}
                      </span>
                      {item.hasKey ? (
                        <Btn label={tr("settings.providers.clear")} small onClick={() => void api.settings.clearApiKey({ providerId: item.id }).then(async () => { await refreshProviders(); await api.settings.getProvider().then(setProvider).catch(() => {}); notifyProviders(); ok(tr("settings.providers.cleared")); }).catch(bad)} />
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
            {editingProviderId === null ? (
              <div style={S.btns}><Btn label={tr("settings.providers.add")} primary onClick={() => startEdit()} /></div>
            ) : (
              <div className="panel-card" style={S.card}>
                <div style={S.formHead}>{editingProviderId === "new" ? tr("settings.providers.addTitle") : tr("settings.providers.editTitle")}</div>
                <div style={S.presetRow}>
                  <span style={S.tag}>{tr("settings.providers.quickFill")}</span>
                  {presets.map((preset) => (
                    <Btn
                      key={preset.provider}
                      label={preset.name}
                      small
                      onClick={() => {
                        setPForm({ provider: preset.provider, baseUrl: preset.baseUrl, model: preset.model });
                        setPHeaders(formatHeaderLines(preset.headers));
                        if (preset.headers) setPFormat("openai");
                      }}
                    />
                  ))}
                </div>
                <Field l={tr("settings.providers.provider")}><In v={pForm.provider} ph="deepseek / openai / agnes / local" on={(x) => setPForm({ ...pForm, provider: x })} /></Field>
                <Field l={tr("settings.providers.baseUrl")}><In v={pForm.baseUrl} ph="https://api.deepseek.com/v1" on={(x) => setPForm({ ...pForm, baseUrl: x })} /></Field>
                <Field l={tr("settings.providers.protocol")} h={tr("settings.providers.protocolHint")}>
                  <Seg
                    v={pFormat}
                    opts={[
                      ["auto", tr("settings.providers.proto.auto")],
                      ["openai", tr("settings.providers.proto.openai")],
                      ["anthropic", tr("settings.providers.proto.anthropic")],
                    ]}
                    on={(x) => setPFormat(x as "auto" | "openai" | "anthropic")}
                  />
                </Field>
                <Field l={tr("settings.providers.apiKey")} h={tr("settings.providers.apiKeyHint")}>
                  <div style={S.col}>
                    <div style={S.rowEnd}>
                      <In v={keyInput} ph={tr("settings.providers.keyPlaceholder")} type="password" on={setKeyInput} />
                      <Btn label={pFetching ? tr("settings.providers.fetching") : tr("settings.providers.fetchModels")} small onClick={() => void fetchModels()} />
                    </div>
                    {pModelsError ? <div style={S.errText}>{pModelsError}</div> : null}
                  </div>
                </Field>
                <Field l={tr("settings.providers.keyStatus")} h={tr("settings.providers.keyStatusHint")}>
                  <div style={S.rowBetween}>
                    <span style={S.tag}>
                      {(() => {
                        const saved = providerItems.find((i) => i.id === editingProviderId);
                        if (!saved) return tr("settings.providers.providerNotSaved");
                        return saved.hasKey
                          ? tr("settings.providers.keySaved", {
                              hint: saved.keyHint ?? "",
                              source: saved.keySource === "env" ? tr("settings.providers.keyFromEnv") : tr("settings.providers.keychain"),
                            })
                          : tr("settings.providers.keyNotSaved");
                      })()}
                    </span>
                    <Btn
                      label={tr("settings.providers.saveKey")}
                      small
                      onClick={() => {
                        if (!keyInput.trim()) {
                          bad(tr("settings.providers.pasteKeyFirst"));
                          return;
                        }
                        const saved = providerItems.find((i) => i.id === editingProviderId);
                        if (!saved) {
                          bad(tr("settings.providers.createFirst"));
                          return;
                        }
                        void api.settings
                          .setApiKey({ providerId: saved.id, apiKey: keyInput.trim() })
                          .then(async (r) => {
                            setKeyInput("");
                            await refreshProviders();
                            await api.settings.getProvider().then(setProvider).catch(() => {});
                            notifyProviders();
                            ok(tr("settings.providers.keySavedOk", {
                              mode: r.storageMode === "os" ? tr("settings.providers.storageOs") : tr("settings.providers.storageDegraded"),
                            }));
                          })
                          .catch(bad);
                      }}
                    />
                  </div>
                </Field>
                <Field
                  l={tr("settings.providers.customHeaders")}
                  h={tr("settings.providers.customHeadersHint", {
                    vars: HEADER_TEMPLATE_VARIABLES.map((name) => `{{${name}}}`).join(" "),
                  })}
                >
                  <Area v={pHeaders} rows={4} wide on={setPHeaders} />
                </Field>
                <Field l={tr("settings.providers.rpm")} h={tr("settings.providers.rpmHint")}>
                  <In v={pRpm} ph={tr("settings.providers.rpmPlaceholder")} on={setPRpm} />
                </Field>
                <div style={S.modelSection}>
                  <div style={S.modelSectionHead}>
                    {tr("settings.providers.modelDebug")}
                  </div>
                  <div style={S.modelAddRow}>
                    <In v={pModelDraft} ph={tr("settings.providers.modelDraftPlaceholder")} on={setPModelDraft} />
                    <Btn label={tr("settings.add")} small onClick={addModelsFromDraft} />
                  </div>
                  {pModels.length === 0 ? (
                    <div style={S.dashed}>{tr("settings.providers.modelsEmpty")}</div>
                  ) : (
                    <div style={S.tableWrap}>
                      <table style={S.table}>
                        <thead>
                          <tr>
                            <th style={S.th}>{tr("settings.providers.col.enable")}</th>
                            <th style={S.th}>{tr("settings.providers.col.modelId")}</th>
                            <th style={S.thNarrow}>{tr("settings.providers.col.contextK")}</th>
                            <th style={S.thNarrow}>{tr("settings.providers.col.outputK")}</th>
                            <th style={S.thTiny}>{tr("settings.providers.col.vision")}</th>
                            <th style={S.thTiny}>{tr("settings.providers.col.thinking")}</th>
                            <th style={S.th}>{tr("settings.providers.col.efforts")}</th>
                            <th style={S.thTiny}>{tr("settings.providers.col.default")}</th>
                            <th style={S.thTiny}></th>
                          </tr>
                        </thead>
                        <tbody>
                          {pModels.map((m, idx) => (
                            <tr key={m.id + idx}>
                              <td style={S.td}>
                                <Toggle v={m.selected !== false} on={(next) => updateModel(idx, { selected: next })} />
                              </td>
                              <td style={S.td}>
                                <input style={S.tblInput} value={m.id} onChange={(e) => updateModel(idx, { id: e.target.value })} />
                              </td>
                              <td style={S.td}>
                                <input
                                  style={S.tblInput}
                                  value={m.contextWindow ? String(Math.round(m.contextWindow / 1000)) : ""}
                                  placeholder="—"
                                  onChange={(e) => updateModel(idx, { contextWindow: e.target.value ? Number(e.target.value) * 1000 : undefined })}
                                />
                              </td>
                              <td style={S.td}>
                                <input
                                  style={S.tblInput}
                                  value={m.maxOutput ? String(Math.round(m.maxOutput / 1000)) : ""}
                                  placeholder="—"
                                  onChange={(e) => updateModel(idx, { maxOutput: e.target.value ? Number(e.target.value) * 1000 : undefined })}
                                />
                              </td>
                              <td style={S.tdCenter}>
                                <input type="checkbox" checked={m.vision === true} onChange={(e) => updateModel(idx, { vision: e.target.checked })} />
                              </td>
                              <td style={S.tdCenter}>
                                <input type="checkbox" checked={m.thinking === true} onChange={(e) => updateModel(idx, { thinking: e.target.checked })} />
                              </td>
                              <td style={S.td}>
                                <input
                                  style={S.tblInput}
                                  value={(m.thinkingEfforts ?? []).join(",")}
                                  placeholder="low,medium,high"
                                  onChange={(e) =>
                                    updateModel(idx, {
                                      thinkingEfforts: e.target.value.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 10),
                                    })
                                  }
                                />
                              </td>
                              <td style={S.tdCenter}>
                                <input
                                  type="radio"
                                  name="default-model"
                                  checked={pForm.model === m.id}
                                  onChange={() => setPForm({ ...pForm, model: m.id })}
                                />
                              </td>
                              <td style={S.tdCenter}>
                                <button type="button" className="icon-btn" style={{ width: 22, height: 22 }} title={tr("settings.providers.removeModel")} onClick={() => removeModel(idx)}>
                                  <Icon name="close" size={11} />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
                <div style={S.btns}>
                  <Btn label={tr("settings.providers.testConnection")} onClick={() => void api.settings.testProvider({ provider: pForm.provider, baseUrl: pForm.baseUrl, model: pForm.model || "default", headers: parseHeaderLines(pHeaders, tr) }).then(setTestRes).catch(bad)} />
                  <Btn label={tr("settings.providers.saveEnable")} primary onClick={() => void commit()} />
                  <Btn label={tr("settings.cancel")} onClick={() => setEditingProviderId(null)} />
                  {testRes ? <span style={testRes.ok ? S.okText : S.errText}>{testRes.ok ? "✓ " : "✕ "}{testRes.message}</span> : null}
                </div>
              </div>
            )}
            <div style={S.note}>{tr("settings.providers.securityNote")}</div>
          </div>
        );
      }

      case "rules":
        return rules ? (<div>
          <Head t={tr("settings.rules.head")} h={tr("settings.rules.headHint")} />
          {drafts.length === 0 ? <div style={S.dashed}>{tr("settings.rules.empty")}</div> : null}
          {drafts.map((d) => <RuleCard key={d.key} d={d} max={rules.maxFileBytes}
            on={(p) => setDrafts((v) => v.map((x) => x.key === d.key ? { ...x, ...p } : x))} onDel={() => removeDraft(d)} />)}
          <div style={S.btns}>
            <Btn label={tr("settings.rules.newGlobal")} onClick={() => addDraft("global")} />
            <Btn label={tr("settings.rules.newWorkspace")} onClick={() => addDraft("workspace")} />
          </div>
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
        </div>) : <div style={S.muted}>{tr("settings.readFailed")}</div>;

      case "memory":
        return mem ? (<div>
          <Head t={tr("settings.memory.head")} h={tr("settings.memory.headHint")} />
          <div style={S.stats}>
            <Stat l={tr("settings.memory.items")} v={mem.stats.active} />
            <Stat l={tr("settings.memory.archived")} v={mem.stats.archived} />
            <Stat l={tr("settings.memory.links")} v={mem.stats.links} />
          </div>
          <div style={S.note}>{tr("settings.memory.store")}<code style={S.code}>{mem.filePath}</code></div>
          <Field l={tr("settings.memory.addTitle")}><div style={S.col}>
            <Area v={mForm.content} rows={2} on={(x) => setMForm({ ...mForm, content: x })} />
            <div style={S.rowEnd}>
              <In v={mForm.category} on={(x) => setMForm({ ...mForm, category: x })} />
              <Btn label={tr("settings.add")} primary onClick={() => void addMemory()} />
            </div>
          </div></Field>
          {mem.facts.length === 0 ? <div style={S.dashed}>{tr("settings.memory.empty")}</div> : mem.facts.map((f) => (
            <div key={f.id} className="panel-card" style={S.card}>
              <div style={S.rowBetween}>
                <span style={S.meta}><span style={BADGE.neutral}>{f.category}</span><span style={S.tag}>{tr("settings.memory.importance", { value: f.importance })}</span>{f.tags.map((t) => <span key={t} style={S.tag}>#{t}</span>)}</span>
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
          <div style={S.btns}><Btn label={tr("settings.memory.clearAll")} onClick={() => void api.memory.clear().then(async () => setMem(await api.memory.list()))} /></div>
        </div>) : <div style={S.muted}>{tr("settings.readFailed")}</div>;

      case "extensions":
        return (
          <div>
            <Head t={tr("settings.extensions.head")} h={tr("settings.extensions.headHint")} />
            <div style={S.note}>{tr("settings.extensions.dir")}<code style={S.code}>{extensionsDir || "—"}</code></div>
            <div style={S.btns}>
              <Btn
                label={tr("settings.extensions.openDir")}
                onClick={() =>
                  void api.extensions
                    .openDir()
                    .then((r) => {
                      if (!r.ok) bad(tr("settings.extensions.openFailed", { dir: r.dir }));
                    })
                    .catch(bad)
                }
              />
              <Btn
                label={tr("settings.rescan")}
                onClick={() =>
                  void api.extensions.list().then((r) => {
                    setExtensions(r.extensions);
                    setExtensionsDir(r.dir);
                    setExtensionSkips(r.skipped);
                    setExtensionRuntime(r.runtime ?? {});
                  })
                }
              />
            </div>
            {extensionSkips.length > 0 ? (
              <div style={S.note}>
                {tr("settings.extensions.skipped", { count: extensionSkips.length })}
                {extensionSkips.map((x) => (
                  <div key={x.dir} style={S.errText}>{tr("settings.skipItem", { path: x.dir, reason: x.reason })}</div>
                ))}
              </div>
            ) : null}
            {extensions.length === 0 ? (
              <div style={S.dashed}>{tr("settings.extensions.empty")}</div>
            ) : (
              extensions.map((ext) => (
                <div key={ext.manifest.id} className="panel-card" style={S.card}>
                  <div style={S.rowBetween}>
                    <span style={S.meta}>
                      <span style={S.metaTitle}>{ext.manifest.name}</span>
                      <span style={BADGE.neutral}>v{ext.manifest.version}</span>
                      {ext.manifest.author ? <span style={S.tag}>{ext.manifest.author}</span> : null}
                    </span>
                    <span style={S.icons}>
                      <label style={S.tag}>
                        <Toggle
                          v={ext.enabled}
                          on={(next) =>
                            void api.extensions.setEnabled({ id: ext.manifest.id, enabled: next }).then(() =>
                              api.extensions.list().then((r) => {
                                setExtensions(r.extensions);
                                setExtensionRuntime(r.runtime ?? {});
                              }),
                            )
                          }
                        />
                      </label>
                      {ext.manifest.main ? (
                        (extensionRuntime[ext.manifest.id]?.state ?? "idle") === "ready" ? (
                          <Btn
                            label={tr("settings.stop")}
                            small
                            onClick={() =>
                              void api.extensions.stop({ id: ext.manifest.id }).then(() => {
                                void api.extensions.list().then((r) => {
                                  setExtensions(r.extensions);
                                  setExtensionRuntime(r.runtime ?? {});
                                });
                              })
                            }
                          />
                        ) : (
                          <Btn
                            label={tr("settings.start")}
                            small
                            onClick={() =>
                              void api.extensions.start({ id: ext.manifest.id }).then(() => {
                                void api.extensions.list().then((r) => {
                                  setExtensions(r.extensions);
                                  setExtensionRuntime(r.runtime ?? {});
                                });
                              })
                            }
                          />
                        )
                      ) : null}
                      <Btn
                        label={tr("settings.uninstall")}
                        small
                        onClick={() =>
                          void api.extensions.remove({ id: ext.manifest.id }).then(() =>
                            void api.extensions.list().then((r) => {
                              setExtensions(r.extensions);
                              setExtensionRuntime(r.runtime ?? {});
                            }),
                          )
                        }
                      />
                    </span>
                  </div>
                  {ext.manifest.description ? <div style={S.providerVal}>{ext.manifest.description}</div> : null}
                  {ext.manifest.permissions && ext.manifest.permissions.length > 0 ? (
                    <div style={S.providerRows}>
                      <div style={S.providerRow}><span style={S.providerKey}>{tr("settings.extensions.permissions")}</span><span style={S.providerVal}>{ext.manifest.permissions.join(" · ")}</span></div>
                    </div>
                  ) : null}
                  <div style={S.providerRow}>
                    <span style={S.providerKey}>{tr("settings.extensions.run")}</span>
                    <span style={S.providerVal}>
                      {(() => {
                        const status = extensionRuntime[ext.manifest.id] ?? { state: "idle", tools: [] };
                        const label =
                          status.state === "ready"
                            ? tr("settings.extensions.loaded", { count: status.tools.length })
                            : status.state === "starting"
                              ? tr("settings.extensions.starting")
                              : status.state === "error"
                                ? tr("settings.extensions.loadFailed", { error: status.error ?? tr("settings.unknown") })
                                : ext.manifest.main
                                  ? tr("settings.extensions.notStarted")
                                  : tr("settings.extensions.declarative");
                        return <span style={status.state === "error" ? S.errText : undefined}>{label}</span>;
                      })()}
                    </span>
                  </div>
                  {extensionRuntime[ext.manifest.id]?.tools.length ? (
                    <div style={S.providerRow}>
                      <span style={S.providerKey}>{tr("settings.extensions.tools")}</span>
                      <span style={S.providerVal}>{extensionRuntime[ext.manifest.id].tools.join(" · ")}</span>
                    </div>
                  ) : null}
                  <div style={S.providerRow}><span style={S.providerKey}>{tr("settings.extensions.dirRow")}</span><span style={S.providerVal}>{ext.dir}</span></div>
                </div>
              ))
            )}
            <div style={S.note}>{tr("settings.extensions.isolation")}</div>
          </div>
        );

      case "skills":
        return (
          <div>
            <Head t={tr("settings.skills.head")} h={tr("settings.skills.headHint")} />
            <div style={S.note}>{tr("settings.skills.dir")}<code style={S.code}>{skillsDir || "—"}</code></div>
            <div style={S.btns}>
              <Btn
                label={tr("settings.skills.openDir")}
                onClick={() =>
                  void api.skills
                    .openDir()
                    .then((r) => {
                      if (!r.ok) bad(tr("settings.extensions.openFailed", { dir: r.dir }));
                    })
                    .catch(bad)
                }
              />
              <Btn label={tr("settings.rescan")} onClick={() => void api.skills.reload().then((r) => { setSkills(r.skills); setSkillSkips(r.skipped); })} />
            </div>
            {skillSkips.length > 0 ? (
              <div style={S.note}>
                {tr("settings.skills.skipped", { count: skillSkips.length })}
                {skillSkips.map((x) => <div key={x.dir} style={S.errText}>{tr("settings.skipItem", { path: x.dir, reason: x.reason })}</div>)}
              </div>
            ) : null}
            {skills.length === 0 ? (
              <div style={S.dashed}>{tr("settings.skills.empty")}</div>
            ) : (
              skills.map((sk) => (
                <div key={sk.id} className="panel-card" style={S.card}>
                  <div style={S.rowBetween}>
                    <span style={S.meta}>
                      <span style={S.metaTitle}>{sk.frontmatter.name}</span>
                      {sk.frontmatter.version ? <span style={BADGE.neutral}>v{sk.frontmatter.version}</span> : null}
                      {sk.warnings && sk.warnings.length > 0 ? <span style={BADGE.warn} title={sk.warnings.join(" / ")}>{tr("settings.skills.tolerance")}</span> : null}
                      {(sk.frontmatter.tags ?? []).map((tag) => <span key={tag} style={S.tag}>#{tag}</span>)}
                    </span>
                    <span style={S.icons}>
                      <Toggle v={sk.enabled} on={(next) => void api.skills.setEnabled({ id: sk.id, enabled: next }).then(() => void api.skills.list().then((r) => setSkills(r.skills)))} />
                    </span>
                  </div>
                  <div style={S.providerVal}>{sk.frontmatter.description}</div>
                  <div style={S.providerRows}>
                    {sk.frontmatter.whenToUse ? <div style={S.providerRow}><span style={S.providerKey}>{tr("settings.skills.whenToUse")}</span><span style={S.providerVal}>{sk.frontmatter.whenToUse}</span></div> : null}
                    <div style={S.providerRow}><span style={S.providerKey}>{tr("settings.skills.body")}</span><span style={S.providerVal}>{tr("settings.bytes", { bytes: sk.bytes })}</span></div>
                  </div>
                </div>
              ))
            )}
            <div style={S.note}>{tr("settings.skills.isolation")}</div>
          </div>
        );

      case "mcp":
        return (
          <div>
            <Head t={tr("settings.mcp.head")} h={tr("settings.mcp.headHint")} />
            <div style={S.note}>{tr("settings.mcp.configFile")}<code style={S.code}>{mcpConfigPath || "—"}</code></div>
            <div className="panel-card" style={S.card}>
              <div style={S.formHead}>{tr("settings.mcp.addTitle")}</div>
              <Field l={tr("settings.mcp.name")}><In v={mcpForm.name} ph="filesystem / github / remote" on={(x) => setMcpForm({ ...mcpForm, name: x })} /></Field>
              <Field l={tr("settings.mcp.transport")} h={tr("settings.mcp.transportHint")}>
                <Seg
                  v={mcpForm.transport}
                  opts={[
                    ["stdio", tr("settings.mcp.stdio")],
                    ["http", tr("settings.mcp.http")],
                  ]}
                  on={(x) => setMcpForm({ ...mcpForm, transport: x as "stdio" | "http" })}
                />
              </Field>
              {mcpForm.transport === "http" ? (
                <Field l={tr("settings.mcp.url")} h={tr("settings.mcp.urlHint")}>
                  <In v={mcpForm.url} ph="https://example.com/mcp" on={(x) => setMcpForm({ ...mcpForm, url: x })} />
                </Field>
              ) : (
                <>
                  <Field l={tr("settings.mcp.command")}><In v={mcpForm.command} ph="npx / node / uvx" on={(x) => setMcpForm({ ...mcpForm, command: x })} /></Field>
                  <Field l={tr("settings.mcp.args")} h={tr("settings.mcp.argsHint")}><In v={mcpForm.args} ph="-y @modelcontextprotocol/server-filesystem D:/work" on={(x) => setMcpForm({ ...mcpForm, args: x })} /></Field>
                </>
              )}
              <div style={S.btns}>
                <Btn
                  label={tr("settings.add")}
                  primary
                  onClick={() =>
                    void api.mcp
                      .add(
                        mcpForm.transport === "http"
                          ? { name: mcpForm.name.trim() || "mcp", transport: "http", url: mcpForm.url.trim() }
                          : {
                              name: mcpForm.name.trim() || "mcp",
                              transport: "stdio",
                              command: mcpForm.command.trim() || "npx",
                              args: mcpForm.args.trim() ? (mcpForm.args.match(/"[^"]*"|\S+/g) ?? []).map((x) => x.replace(/^"|"$/g, "")) : [],
                            },
                      )
                      .then((r) => {
                        setMcpServers(r.servers);
                        setMcpForm({ name: "", transport: "stdio", command: "", args: "", url: "" });
                        ok(tr("settings.mcp.added"));
                      })
                      .catch(bad)
                  }
                />
              </div>
            </div>
            {mcpServers.length === 0 ? (
              <div style={S.dashed}>{tr("settings.mcp.empty")}</div>
            ) : (
              mcpServers.map((srv) => (
                <div key={srv.id} className="panel-card" style={S.card}>
                  <div style={S.rowBetween}>
                    <span style={S.meta}>
                      <span style={S.metaTitle}>{srv.name}</span>
                      <span style={srv.state === "ready" ? BADGE.ok : srv.state === "error" ? BADGE.warn : BADGE.neutral}>
                        {srv.state === "ready"
                          ? tr("settings.mcp.connected")
                          : srv.state === "connecting"
                            ? tr("settings.mcp.connecting")
                            : srv.state === "error"
                              ? tr("settings.error")
                              : tr("settings.mcp.disconnected")}
                      </span>
                      <span style={S.tag}>{tr("settings.toolsCount", { count: srv.tools.length })}</span>
                      {srv.capabilities.length > 0 ? <span style={S.tag}>{tr("settings.mcp.capabilities", { list: srv.capabilities.join("/") })}</span> : null}
                    </span>
                    <span style={S.icons}>
                      {srv.state === "ready" ? (
                        <Btn label={tr("settings.mcp.disconnect")} small onClick={() => void api.mcp.disconnect({ id: srv.id }).then((r) => setMcpServers(r.servers))} />
                      ) : (
                        <Btn label={tr("settings.mcp.connect")} small onClick={() => void api.mcp.connect({ id: srv.id }).then((r) => setMcpServers(r.servers)).catch(bad)} />
                      )}
                      <Btn label={tr("settings.delete")} small onClick={() => void api.mcp.remove({ id: srv.id }).then((r) => setMcpServers(r.servers))} />
                    </span>
                  </div>
                  <div style={S.providerRows}>
                    <div style={S.providerRow}>
                      <span style={S.providerKey}>{srv.transport === "http" ? tr("settings.mcp.endpoint") : tr("settings.mcp.commandRow")}</span>
                      <span style={S.providerVal}>{srv.transport === "http" ? (srv.url ?? "—") : [srv.command, ...srv.args].filter(Boolean).join(" ")}</span>
                    </div>
                    {srv.error ? <div style={S.providerRow}><span style={S.providerKey}>{tr("settings.error")}</span><span style={S.errText}>{srv.error}</span></div> : null}
                    {srv.tools.length > 0 ? <div style={S.providerRow}><span style={S.providerKey}>{tr("settings.extensions.tools")}</span><span style={S.providerVal}>{srv.tools.slice(0, 6).join(" · ")}{srv.tools.length > 6 ? " …" : ""}</span></div> : null}
                    {srv.stderr.length > 0 ? (
                      <div style={S.providerRow}><span style={S.providerKey}>{tr("settings.mcp.diagnostics")}</span><span style={S.providerVal} title={srv.stderr.slice(-5).join("\\n")}>{srv.stderr.slice(-3).join(" | ").slice(0, 200)}</span></div>
                    ) : null}
                  </div>
                </div>
              ))
            )}
            <div style={S.note}>{tr("settings.mcp.isolation")}</div>
          </div>
        );

      case "storage":
        return prefs && locations ? (<div>
          <Head t={tr("settings.storage.head")} h={tr("settings.storage.headHint")} />
          <Field l={tr("settings.storage.dataDir")}><code style={S.code}>{locations.dataDir}</code></Field>
          <Field l={tr("settings.storage.configDir")}><code style={S.code}>{locations.configDir}</code></Field>
          <Field l={tr("settings.storage.rulesDir")}><code style={S.code}>{locations.rulesDir}</code></Field>
          <Field l={tr("settings.storage.sessionsFile")}><code style={S.code}>{locations.sessionsFile}</code></Field>
          <Field l={tr("settings.storage.workspaceRoot")} h={tr("settings.storage.workspaceRootHint")}><div style={S.rowEnd}><In v={prefs.workspaceRoot ?? ""} ph={locations.workspaceRoot} on={(x) => setPrefs({ ...prefs, workspaceRoot: x })} /><Btn label={tr("settings.browse")} small onClick={() => void api.dialog.pickPath({ kind: "directory", title: tr("settings.storage.pickWorkspace") }).then((r) => { if (r.path) setPrefs({ ...prefs, workspaceRoot: r.path }); })} /></div></Field>
          <Field l={tr("settings.storage.memoryPath")} h={tr("settings.storage.memoryPathHint")}><div style={S.rowEnd}><In v={prefs.memoryStorePath ?? ""} ph={locations.defaultMemoryFile} on={(x) => setPrefs({ ...prefs, memoryStorePath: x })} /><Btn label={tr("settings.browse")} small onClick={() => void api.dialog.pickPath({ kind: "file", title: tr("settings.storage.pickMemory") }).then((r) => { if (r.path) setPrefs({ ...prefs, memoryStorePath: r.path }); })} /></div></Field>
          <Field l={tr("settings.storage.downloadDir")} h={tr("settings.storage.downloadDirHint")}><div style={S.rowEnd}><In v={prefs.downloadDir ?? ""} ph={tr("settings.storage.defaultPlaceholder")} on={(x) => setPrefs({ ...prefs, downloadDir: x })} /><Btn label={tr("settings.browse")} small onClick={() => void api.dialog.pickPath({ kind: "directory", title: tr("settings.storage.pickDownload") }).then((r) => { if (r.path) setPrefs({ ...prefs, downloadDir: r.path }); })} /></div></Field>
          <SaveBtn onClick={savePrefs} label={tr("settings.storage.save")} />
        </div>) : <div style={S.muted}>{tr("settings.readFailed")}</div>;

      case "advanced":
        return diag ? (<div>
          <Head t={tr("settings.advanced.head")} h={tr("settings.advanced.headHint")} />
          <div style={S.kv}>{Object.entries(diag.paths).map(([k, v]) => <Kv key={k} k={k} v={v} />)}{Object.entries(diag.versions).map(([k, v]) => <Kv key={k} k={k} v={v} />)}</div>
          {diag.extra && Object.keys(diag.extra).length ? <div style={S.box}><div style={S.boxTitle}>{tr("settings.advanced.runtimeStats")}</div><div style={S.kv}>{Object.entries(diag.extra).map(([k, v]) => <Kv key={k} k={k} v={String(v)} />)}</div></div> : null}
        </div>) : <div style={S.muted}>{tr("settings.readFailed")}</div>;

      case "about":
        return about ? (<div>
          <Head t={tr("settings.about.head")} h={tr("settings.about.headHint")} />
          <div style={S.about}><img src="./logo.png" alt="Loopsoar" width={56} height={56} style={{ borderRadius: 10 }} />
            <div><div style={{ fontSize: 18, fontWeight: 800 }}>{about.name}</div><div style={S.tag}>{tr("settings.about.version", { version: about.version })}</div></div></div>
          <div style={S.kv}>
            <Kv k={tr("settings.about.appId")} v={about.appId} /><Kv k={tr("settings.about.protocol")} v={about.protocol} /><Kv k="Electron" v={about.electron} />
            <Kv k="Node" v={about.node} /><Kv k={tr("settings.about.brand")} v={about.brandAssetSource} />
          </div>
          <div style={S.note}>{tr("settings.about.note")}</div>
          {onOpenOnboarding ? (
            <div style={S.box}>
              <div style={S.boxTitle}>{tr("settings.about.onboarding")}</div>
              <div style={S.note}>{tr("settings.about.onboardingHint")}</div>
              {/* 先关设置再开向导：向导 z-index 低于设置（从向导跳设置时要能被设置盖住） */}
              <SaveBtn onClick={() => { onClose(); onOpenOnboarding(); }} label={tr("settings.about.onboarding")} />
            </div>
          ) : null}
        </div>) : <div style={S.muted}>{tr("settings.readFailed")}</div>;

      default:
        return null;
    }
  }, [section, loading, api, prefs, locations, perms, pForm, testRes, rules, drafts, deleted, mem, mForm, mEdit, diag, about, savePrefs, savePerms, saveRules, addMemory, saveMemEdit, bad, providerItems, activeProviderId, editingProviderId, extensions, extensionsDir, extensionSkips, ok, skills, skillsDir, skillSkips, mcpServers, mcpConfigPath, mcpForm, keyInput, pModels, pModelsError, pFetching, pFormat, pRpm, pModelDraft, rail, loopInfo, loopBusy, latestLoopFallback, chooseLoop, reloadLoops, onOpenOnboarding, tr, provider]);

  return (
    <div
      className={fullPage ? "settings-fullpage" : "settings-overlay"}
      style={fullPage ? S.fullPageRoot : S.overlay}
      onClick={fullPage ? undefined : (e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className={fullPage ? "settings-fullpage-panel" : "settings-panel"} style={fullPage ? S.fullPagePanel : S.panel}>
        {/* 整页模式：标题与「返回」由 ChromePage 顶栏提供，避免双标题栏 */}
        {fullPage ? null : (
          <div style={S.header}><span style={S.title}>{tr("settings.title")}</span><button type="button" className="icon-btn" onClick={onClose} title={tr("settings.close")}><Icon name="close" size={14} /></button></div>
        )}
        <div style={S.bodyRow}>
          <nav style={S.nav}>
            {SECTIONS.map((s, index) => (
              <React.Fragment key={s.id}>
                {index === 0 || s.group !== SECTIONS[index - 1].group ? (
                  <div style={S.navGroup}>{tr(`settings.nav.group.${s.group}`)}</div>
                ) : null}
              <button key={s.id} type="button" className={`settings-nav-item${section === s.id ? " is-active" : ""}`}
                style={{ ...S.navItem, ...(section === s.id ? S.navItemActive : {}) }} onClick={() => setSection(s.id)}>
                <Icon name={s.icon} size={15} style={{ marginTop: 2, flex: "none" }} />
                <span style={S.navText}><span style={S.navLabel}>{tr(`settings.nav.${s.id}.label`)}</span><span style={S.navHint}>{tr(`settings.nav.${s.id}.hint`)}</span></span>
              </button>
              </React.Fragment>
            ))}
          </nav>
          <div className="settings-section" key={section} style={S.content}>
            {body}
            {notice ? <div style={notice.kind === "ok" ? S.noticeOk : S.noticeErr}>{notice.text}</div> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── 小控件 ── */
function Head({ t, h }: { t: string; h: string }) {
  return <div style={{ marginBottom: 14 }}><div style={{ fontSize: 15, fontWeight: 700 }}>{t}</div><div style={{ marginTop: 4, fontSize: 11.5, color: BRAND.linenMuted, lineHeight: 1.6 }}>{h}</div></div>;
}
/** 请求头文本 ⇄ 对象：每行一条 `Key: Value`；空行忽略，非法行抛可读错误（文案走 i18n）。 */
function parseHeaderLines(text: string, tr: TFunc): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const [index, line] of lines.entries()) {
    const colon = line.indexOf(":");
    if (colon <= 0) throw new Error(tr("settings.providers.headerFormatError", { line: index + 1 }));
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!key || /\s/.test(key)) throw new Error(tr("settings.providers.headerKeyError", { line: index + 1 }));
    headers[key] = value;
  }
  if (Object.keys(headers).length > 30) throw new Error(tr("settings.providers.headerMax"));
  const unknown = unknownHeaderTemplateVariables(headers);
  if (unknown.length > 0) {
    throw new Error(tr("settings.providers.headerUnknownVars", {
      names: unknown.map((name) => `{{${name}}}`).join(", "),
      available: HEADER_TEMPLATE_VARIABLES.join(" / "),
    }));
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function formatHeaderLines(headers?: Record<string, string>): string {
  if (!headers) return "";
  return Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join("\n");
}

/** 时间戳展示（回退记录等；按当前语言短格式，非法值显示「时间未知」）。 */
function formatWhen(at: number, tr: TFunc): string {
  if (!Number.isFinite(at) || at <= 0) return tr("settings.timeUnknown");
  return new Date(at).toLocaleString(getLanguage() === "en-US" ? "en-US" : "zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function Field({ l, h, children }: { l: string; h?: string; children: React.ReactNode }) {
  return <div style={S.field}><div style={S.fieldLabel}><span>{l}</span>{h ? <span style={S.fieldHint}>{h}</span> : null}</div><div style={S.fieldCtl}>{children}</div></div>;
}
function Seg({ v, opts, on }: { v: string; opts: [string, string][]; on: (x: string) => void }) {
  return <div style={S.seg}>{opts.map(([val, label]) => (
    <button key={val} type="button" className={`settings-seg${v === val ? " is-active" : ""}`} style={{ ...S.segItem, ...(v === val ? S.segOn : {}) }} onClick={() => on(val)}>{label}</button>
  ))}</div>;
}
function Toggle({ v, on }: { v: boolean; on: (x: boolean) => void }) {
  return <button type="button" className="settings-toggle" style={{ ...S.toggle, ...(v ? S.toggleOn : {}) }} onClick={() => on(!v)} aria-pressed={v}><span style={{ ...S.knob, ...(v ? S.knobOn : {}) }} /></button>;
}
function In({ v, ph, on, type }: { v: string; ph?: string; on: (x: string) => void; type?: string }) {
  return <input style={S.input} value={v} placeholder={ph} type={type ?? "text"} onChange={(e) => on(e.target.value)} />;
}
function Area({ v, rows, on, wide }: { v: string; rows: number; on: (x: string) => void; wide?: boolean }) {
  return (
    <textarea
      style={wide ? { ...S.area, maxWidth: "none", width: "100%", minWidth: 240, fontFamily: "ui-monospace, Consolas, monospace" } : S.area}
      rows={rows}
      value={v}
      placeholder={wide ? "x-opencode-session: {{sessionId}}\nUser-Agent: Loopsoar/1.0" : undefined}
      onChange={(e) => on(e.target.value)}
      spellCheck={false}
    />
  );
}
function Btn({ label, onClick, primary, small }: { label: string; onClick: () => void; primary?: boolean; small?: boolean }) {
  return <button type="button" className={primary ? "btn-primary" : "btn-ghost"} style={{ ...(primary ? S.primary : S.ghost), ...(small ? S.small : {}) }} onClick={onClick}>{label}</button>;
}
function SaveBtn({ onClick, label }: { onClick: () => void; label: string }) {
  return <div style={{ display: "flex", justifyContent: "flex-end", paddingTop: 14 }}><Btn label={label} primary onClick={onClick} /></div>;
}
function RuleCard({ d, max, on, onDel }: { d: DraftRule; max: number; on: (p: Partial<DraftRule>) => void; onDel: () => void }) {
  const tr = useT();
  const bytes = new TextEncoder().encode(d.content).length;
  return (<div className="panel-card" style={S.card}>
    <div style={S.rowBetween}>
      <span style={S.meta}><span style={BADGE.neutral}>{d.scope === "workspace" ? tr("settings.rules.scopeWorkspace") : tr("settings.rules.scopeGlobal")}</span><span style={bytes > max ? S.errText : S.tag}>{tr("settings.bytesOf", { bytes, max })}</span></span>
      <span style={S.icons}><Toggle v={d.enabled} on={(next) => on({ enabled: next })} /><Btn label={tr("settings.delete")} small onClick={onDel} /></span>
    </div>
    <input style={S.ruleName} value={d.name} disabled={d.scope === "workspace"} onChange={(e) => on({ name: e.target.value })} />
    <textarea style={S.rulesArea} rows={4} spellCheck={false} value={d.content} placeholder={tr("settings.rules.namePlaceholder")} onChange={(e) => on({ content: e.target.value })} />
  </div>);
}
function Stat({ l, v }: { l: string; v: number }) {
  return <div style={S.stat}><div style={S.statV}>{v}</div><div style={S.tag}>{l}</div></div>;
}
function Kv({ k, v }: { k: string; v: string }) {
  return <div style={S.kvRow}><span style={S.kvKey}>{k}</span><span style={S.kvVal} title={v}>{v}</span></div>;
}

const S: Record<string, React.CSSProperties> = {
  overlay: { position: "fixed", inset: 0, background: "rgba(8,9,12,0.62)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, animation: "fadeOnly 140ms ease both" },
  panel: { width: "min(960px, 94vw)", height: "min(690px, 90vh)", display: "flex", flexDirection: "column", background: BRAND.inkRaised, border: `1px solid ${BRAND.border}`, borderRadius: 12, overflow: "hidden", boxShadow: "0 24px 60px rgba(0,0,0,0.55)" },
  /** 整页模式（ChromePage）：无模态背景/圆角/阴影，铺满父容器。 */
  fullPageRoot: { position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: BRAND.inkRaised, overflow: "hidden" },
  fullPagePanel: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: BRAND.inkRaised, overflow: "hidden" },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderBottom: `1px solid ${BRAND.border}`, background: BRAND.ink },
  title: { fontSize: 13, fontWeight: 700, letterSpacing: 0.5 },
  bodyRow: { display: "flex", flex: 1, minHeight: 0 },
  nav: { width: 190, flexShrink: 0, borderRight: `1px solid ${BRAND.border}`, padding: 8, display: "flex", flexDirection: "column", gap: 2, background: BRAND.ink, overflowY: "auto" },
  navItem: { display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 10px", borderRadius: 8, border: "none", background: "transparent", color: BRAND.linenMuted, cursor: "pointer", textAlign: "left", transition: "background 120ms, color 120ms" },
  navItemActive: { background: BRAND.ochreSoft, color: BRAND.linen },
  navGroup: { fontSize: 10, color: BRAND.linenFaint, letterSpacing: 0.6, padding: "10px 10px 4px", textTransform: "uppercase" },
  navText: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
  navLabel: { fontSize: 12.5, fontWeight: 600 },
  navHint: { fontSize: 10.5, color: BRAND.linenFaint, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  content: { flex: 1, minWidth: 0, overflowY: "auto", padding: "16px 20px" },
  field: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, padding: "10px 0", borderBottom: `1px solid ${BRAND.border}` },
  fieldLabel: { display: "flex", flexDirection: "column", gap: 3, fontSize: 12.5, color: BRAND.linen, minWidth: 140 },
  fieldHint: { fontSize: 10.5, color: BRAND.linenFaint, lineHeight: 1.5 },
  fieldCtl: { flex: 1, display: "flex", justifyContent: "flex-end", alignItems: "center", minWidth: 0 },
  input: { width: "100%", maxWidth: 380, height: 30, padding: "0 10px", borderRadius: 7, border: `1px solid ${BRAND.border}`, background: BRAND.ink, color: BRAND.linen, fontSize: 12.5, outline: "none" },
  area: { width: "100%", maxWidth: 380, borderRadius: 7, border: `1px solid ${BRAND.border}`, background: BRAND.ink, color: BRAND.linen, fontSize: 12, padding: 8, resize: "vertical", outline: "none", boxSizing: "border-box" },
  col: { display: "flex", flexDirection: "column", gap: 6, width: "100%", alignItems: "flex-end" },
  rowEnd: { display: "flex", gap: 6, width: "100%", justifyContent: "flex-end" },
  row: { display: "flex", alignItems: "center", gap: 10, padding: "8px 0 12px" },
  rowBetween: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 },
  seg: { display: "inline-flex", border: `1px solid ${BRAND.border}`, borderRadius: 8, overflow: "hidden", background: BRAND.ink },
  segItem: { padding: "5px 12px", border: "none", background: "transparent", color: BRAND.linenMuted, fontSize: 12, cursor: "pointer", transition: "background 120ms, color 120ms" },
  segOn: { background: BRAND.ochre, color: BRAND.ink, fontWeight: 700 },
  toggle: { width: 40, height: 22, borderRadius: 11, border: `1px solid ${BRAND.borderStrong}`, background: BRAND.ink, padding: 2, cursor: "pointer", display: "flex", alignItems: "center", transition: "background 140ms, border-color 140ms" },
  toggleOn: { background: BRAND.ochre, borderColor: BRAND.ochre },
  knob: { width: 16, height: 16, borderRadius: "50%", background: BRAND.linenMuted, transition: "transform 140ms ease, background 140ms" },
  knobOn: { transform: "translateX(18px)", background: BRAND.ink },
  primary: { padding: "6px 14px", borderRadius: 7, border: "none", background: BRAND.ochre, color: BRAND.ink, fontWeight: 700, fontSize: 12.5, cursor: "pointer" },
  ghost: { padding: "6px 12px", borderRadius: 7, border: `1px solid ${BRAND.borderStrong}`, background: "transparent", color: BRAND.linenMuted, fontSize: 12.5, cursor: "pointer" },
  small: { padding: "3px 8px", fontSize: 11 },
  btns: { display: "flex", alignItems: "center", gap: 10, paddingTop: 12, flexWrap: "wrap" },
  card: { border: `1px solid ${BRAND.border}`, borderRadius: 10, padding: 12, marginBottom: 10, background: BRAND.inkPanel },
  grid: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10, marginBottom: 10 },
  sliderRow: { display: "flex", alignItems: "center", gap: 10, marginBottom: 8 },
  sliderLabel: { width: 76, fontSize: 11.5, color: BRAND.linenMuted, flexShrink: 0 },
  sliderValue: { width: 62, textAlign: "right", fontSize: 11, color: BRAND.linenFaint, fontVariantNumeric: "tabular-nums" },
  checkRow: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: BRAND.linenMuted, marginTop: 4 },
  modelSection: { borderTop: `1px solid ${BRAND.border}`, paddingTop: 10, marginTop: 6 },
  modelSectionHead: { fontSize: 12.5, fontWeight: 700, marginBottom: 8 },
  modelAddRow: { display: "flex", gap: 6, alignItems: "center", marginBottom: 8, justifyContent: "flex-end" },
  tableWrap: { maxHeight: 320, overflow: "auto", border: `1px solid ${BRAND.border}`, borderRadius: 8 },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 11.5 },
  th: { textAlign: "left", padding: "6px 6px", color: BRAND.linenFaint, fontWeight: 600, borderBottom: `1px solid ${BRAND.border}`, whiteSpace: "nowrap" },
  thNarrow: { textAlign: "left", padding: "6px 4px", color: BRAND.linenFaint, fontWeight: 600, borderBottom: `1px solid ${BRAND.border}`, width: 62, whiteSpace: "nowrap" },
  thTiny: { textAlign: "center", padding: "6px 3px", color: BRAND.linenFaint, fontWeight: 600, borderBottom: `1px solid ${BRAND.border}`, width: 38 },
  td: { padding: "3px 4px", borderBottom: `1px solid ${BRAND.border}` },
  tdCenter: { padding: "3px 3px", borderBottom: `1px solid ${BRAND.border}`, textAlign: "center" },
  tblInput: { width: "100%", height: 24, padding: "0 5px", borderRadius: 5, border: `1px solid ${BRAND.border}`, background: BRAND.ink, color: BRAND.linen, fontSize: 11, outline: "none", boxSizing: "border-box" },
  addCard: {
    minHeight: 84,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    border: `1px dashed ${BRAND.borderStrong}`,
    borderRadius: 10,
    background: "transparent",
    color: BRAND.linenMuted,
    fontSize: 12.5,
    cursor: "pointer",
  },
  modelChips: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6, maxHeight: 120, overflowY: "auto" },
  chip: {
    height: 23,
    padding: "0 9px",
    borderRadius: 999,
    border: `1px solid ${BRAND.border}`,
    background: "transparent",
    color: BRAND.linenMuted,
    fontSize: 10.5,
    cursor: "pointer",
    maxWidth: 220,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  chipOn: { borderColor: BRAND.ochre, color: BRAND.ochreHover, background: BRAND.ochreSoft },
  metaTitle: { fontSize: 13.5, fontWeight: 700, color: BRAND.linen },
  providerIcon: {
    width: 26,
    height: 26,
    borderRadius: 7,
    display: "grid",
    placeItems: "center",
    background: BRAND.ochreSoft,
    color: BRAND.ochreHover,
  },
  providerRows: { display: "grid", gap: 4, margin: "10px 0 4px" },
  providerRow: { display: "flex", gap: 10, alignItems: "baseline", fontSize: 11.5 },
  providerKey: { width: 54, flexShrink: 0, color: BRAND.linenFaint },
  providerVal: { color: BRAND.linen, fontFamily: "ui-monospace, Consolas, monospace", fontSize: 11, wordBreak: "break-all" },
  formHead: { fontSize: 13, fontWeight: 700, marginBottom: 10 },
  presetRow: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 10 },
  meta: { display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" },
  icons: { display: "inline-flex", gap: 4, flexShrink: 0 },
  tag: { fontSize: 10.5, color: BRAND.linenFaint },
  ruleName: { width: "100%", height: 26, margin: "8px 0 6px", padding: "0 8px", borderRadius: 6, border: `1px solid ${BRAND.border}`, background: BRAND.ink, color: BRAND.linen, fontSize: 11.5, fontFamily: "ui-monospace, Consolas, monospace", outline: "none", boxSizing: "border-box" },
  rulesArea: { width: "100%", borderRadius: 7, border: `1px solid ${BRAND.border}`, background: BRAND.ink, color: BRAND.linen, fontSize: 12, lineHeight: 1.6, padding: 10, resize: "vertical", outline: "none", boxSizing: "border-box", fontFamily: "ui-monospace, Consolas, monospace" },
  box: { border: `1px solid ${BRAND.border}`, borderRadius: 10, padding: 12, marginTop: 12, background: BRAND.inkPanel },
  boxTitle: { fontSize: 12, fontWeight: 700, marginBottom: 6 },
  list: { margin: "4px 0 8px 18px", padding: 0, fontSize: 11, color: BRAND.ochreHover, lineHeight: 1.7 },
  pre: { margin: 0, maxHeight: 160, overflow: "auto", fontSize: 11, lineHeight: 1.6, color: BRAND.linenMuted, background: BRAND.ink, borderRadius: 7, padding: 10, whiteSpace: "pre-wrap" },
  stats: { display: "flex", gap: 10, marginBottom: 10 },
  stat: { flex: 1, border: `1px solid ${BRAND.border}`, borderRadius: 10, padding: "10px 12px", background: BRAND.inkPanel, textAlign: "center" },
  statV: { fontSize: 18, fontWeight: 800, color: BRAND.ochreHover },
  memText: { marginTop: 6, fontSize: 12, color: BRAND.linen, lineHeight: 1.65, whiteSpace: "pre-wrap" },
  dashed: { border: `1px dashed ${BRAND.borderStrong}`, borderRadius: 10, padding: 16, marginBottom: 12, fontSize: 12, color: BRAND.linenFaint, lineHeight: 1.7 },
  muted: { fontSize: 12, color: BRAND.linenFaint, padding: 20 },
  note: { marginTop: 10, fontSize: 11, color: BRAND.linenFaint, lineHeight: 1.7 },
  code: { fontFamily: "ui-monospace, Consolas, monospace", fontSize: 10.5, background: BRAND.ink, padding: "1px 5px", borderRadius: 4, color: BRAND.linenMuted, wordBreak: "break-all" },
  okText: { fontSize: 11.5, color: "#5eead4" },
  errText: { fontSize: 11.5, color: "#f87171" },
  kv: { display: "grid", gap: 6 },
  kvRow: { display: "flex", gap: 12, fontSize: 11.5, alignItems: "baseline" },
  kvKey: { width: 110, flexShrink: 0, color: BRAND.linenFaint },
  kvVal: { color: BRAND.linen, wordBreak: "break-all", fontFamily: "ui-monospace, Consolas, monospace" },
  about: { display: "flex", alignItems: "center", gap: 14, marginBottom: 16 },
  noticeOk: { marginTop: 14, padding: "8px 12px", borderRadius: 8, background: "rgba(94,234,212,0.12)", color: "#5eead4", fontSize: 11.5 },
  noticeErr: { marginTop: 14, padding: "8px 12px", borderRadius: 8, background: "rgba(248,113,113,0.12)", color: "#f87171", fontSize: 11.5 },
};
