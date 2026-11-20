import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { LAYOUT } from "loopsoar-contracts/layout";
import { BADGE } from "./theme.js";
import BrandWordmark from "./BrandWordmark.js";
import { Area, Btn, CategoryCombo, Combo, Field, Head, In, Kv, S, SaveBtn, Seg, Stat, Toggle } from "./settingsUi.js";
import {
  HEADER_TEMPLATE_VARIABLES,
} from "loopsoar-contracts/headerTemplate";
import { formatHeaderLines, formatWhen, localized, loopKindOf, parseHeaderLines } from "./settingsModel.js";
import { formatModalities, mergeFetchedProviderModels, modalitiesToInput, openCodePlanLabel, parseModalitiesInput, triStateToValue, valueToTriState, type ProviderCapabilityMeta } from "./modelGroups.js";
import { Icon } from "./Icon.js";
import AppearanceSettingsSection from "./AppearanceSettingsSection.js";
import RulesSettingsSection from "./RulesSettingsSection.js";
import BrowserExtensionsSection from "./BrowserExtensionsSection.js";
import ExtensionsSection from "./ExtensionsSection.js";
import TerminalDiagnosticsSection from "./TerminalDiagnosticsSection.js";
import SkillsSection from "./SkillsSection.js";
import TraceSection from "./TraceSection.js";
import MemorySettingsSection from "./MemorySettingsSection.js";
import { setLanguage, useT } from "./i18n.js";
import type {
  AboutInfo, DiagnosticsInfo, LocationsInfo, LoopInfo,
  LoopListResult, LoopsoarAPI, McpServerInfo,
  PermissionCategory, PermissionsState, Preferences,
  ProviderItem, ProviderModel, ProviderStatus, SkillRecord, TestProviderResult,
} from "./types.js";

/**
 * 设置面板：通用 / 外观 / 权限（含安全）/ 供应商 / 规则 / 技能 / 记忆 / 扩展 / MCP /
 * 存储 / 高级 / 关于。
 * 全部数据经 preload 白名单；规则与记忆在保存后即时生效（主进程惰性读取）。
 *
 * i18n：界面文案全部走 `tr("settings.*")`，词典在 i18nSettings.ts（zh/en 成对）；
 * 语言切换由 i18n.ts 的 setLanguage 广播，本组件通过 useT 订阅即时重渲染。
 */

type SectionId =
  | "general"
  | "searchengine"
  | "appearance"
  | "permissions"
  | "providers"
  | "rules"
  | "skills"
  | "memory"
  | "extensions"
  | "browser-extensions"
  | "mcp"
  | "terminal-env"
  | "storage"
  | "advanced"
  | "about";

/** 侧栏分区：group 为分组 key（渲染时再翻译，避免语言切换后仍是旧语言）。 */
const SECTIONS: { id: SectionId; icon: string; group: "basic" | "capability" | "data" | "other" }[] = [
  { id: "general", group: "basic", icon: "settings" },
  { id: "searchengine", group: "basic", icon: "search" },
  { id: "appearance", group: "basic", icon: "capture" },
  { id: "permissions", group: "basic", icon: "check" },
  { id: "providers", group: "capability", icon: "cloud-upload" },
  { id: "rules", group: "capability", icon: "file" },
  { id: "skills", group: "capability", icon: "bulb" },
  { id: "memory", group: "capability", icon: "notes" },
  { id: "extensions", group: "capability", icon: "extension-feature" },
  { id: "browser-extensions", group: "capability", icon: "browser-plugin" },
  { id: "mcp", group: "capability", icon: "terminal" },
  { id: "terminal-env", group: "data", icon: "terminal" },
  { id: "storage", group: "data", icon: "folders" },
  { id: "advanced", group: "data", icon: "terminal" },
  { id: "about", group: "other", icon: "bulb" },
];

/** 可选搜索引擎（与 Preferences.searchEngine 枚举一致；只保留三家，DuckDuckGo 已下线）。 */
const SEARCH_ENGINE_OPTIONS: { id: Preferences["searchEngine"]; name: string; host: string }[] = [
  { id: "bing", name: "Bing", host: "bing.com" },
  { id: "google", name: "Google", host: "google.com" },
  { id: "baidu", name: "百度", host: "baidu.com" },
];

export default function Settings({ api, onClose, onPreferencesSaved, initialSection, onOpenOnboarding, onOpenUrl, fullPage = false }: {
  api: LoopsoarAPI | null; onClose: () => void; onPreferencesSaved?: (p: Preferences) => void; initialSection?: SectionId;
  /** 「关于」分区重新打开新手引导（由 App 接线；缺省则不显示入口）。 */
  onOpenOnboarding?: () => void;
  /** 设置内打开外链（如扩展商店）：由 App 负责离开设置并真实打开页面。 */
  onOpenUrl?: (url: string) => void;
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
  /** 模型表搜索词：只过滤表格展示（按模型 ID 模糊匹配），不改动保存的数据。 */
  const [pModelQuery, setPModelQuery] = useState("");
  const [testRes, setTestRes] = useState<TestProviderResult | null>(null);
  /** 供应商编辑大弹窗的滚动容器：打开/切换编辑对象时回到顶部，避免"一点编辑就跳到最下面"。 */
  const editBodyRef = React.useRef<HTMLDivElement | null>(null);
  /** 供应商操作的浮动反馈（保存/密钥/列表拉取）：固定在设置面板右上角，成功 3.2s 自动消失，错误常驻。 */
  const [providerToast, setProviderToast] = useState<{ kind: "ok" | "error"; text: string; key: number } | null>(null);
  const providerOk = useCallback((text: string) => setProviderToast({ kind: "ok", text, key: Date.now() }), []);
  const providerBad = useCallback(
    (e: unknown) => setProviderToast({ kind: "error", text: e instanceof Error ? e.message : String(e), key: Date.now() }),
    [],
  );
  useEffect(() => {
    if (!providerToast || providerToast.kind !== "ok") return;
    const timer = setTimeout(() => setProviderToast(null), 3200);
    return () => clearTimeout(timer);
  }, [providerToast]);
  useEffect(() => {
    if (editingProviderId === null) return;
    const frame = requestAnimationFrame(() => editBodyRef.current?.scrollTo({ top: 0 }));
    return () => cancelAnimationFrame(frame);
  }, [editingProviderId]);
  /** Esc 关闭供应商编辑弹窗（与遮罩点击、取消按钮行为一致）。 */
  useEffect(() => {
    if (editingProviderId === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setEditingProviderId(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editingProviderId]);
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

  useEffect(() => {
    if (!api) { setLoading(false); return; }
    void (async () => {
      try {
        const [p, pm, pv, dg, ab, pvList, sk, mc] = await Promise.allSettled([
          api.settings.getPreferences(), api.settings.getPermissions(), api.settings.getProvider(),
          api.settings.diagnostics(), api.settings.about(),
          api.settings.listProviders(), api.skills.list(), api.mcp.list(),
        ]);
        if (p.status === "fulfilled") { setPrefs(p.value.preferences); setLocations(p.value.locations); }
        if (pm.status === "fulfilled") setPerms(pm.value);
        if (pv.status === "fulfilled") { setProvider(pv.value); setPForm({ provider: pv.value.provider ?? "", baseUrl: pv.value.baseUrl ?? "", model: pv.value.model ?? "" }); }
        if (dg.status === "fulfilled") setDiag(dg.value);
        if (ab.status === "fulfilled") setAbout(ab.value);
        if (pvList.status === "fulfilled") {
          setProviderItems(pvList.value.items);
          setActiveProviderId(pvList.value.activeId);
          // 首次使用（无供应商）：直接展开添加表单，少一次点击
          if (pvList.value.items.length === 0) setEditingProviderId("new");
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
  }, [api, bad]);

  // MCP 状态变化（连接/断开/外部修改）：设置页已打开时同步列表，避免必须重开设置。
  useEffect(() => {
    if (!api) return;
    return api.on("mcp:updated", () => {
      void api.mcp
        .list()
        .then((result) => {
          setMcpServers(result.servers);
          setMcpConfigPath(result.configPath);
        })
        .catch(() => {});
    });
  }, [api]);

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

  // 技能更新（重扫/启停/自动候选）：同步设置页列表，避免自动候选要重开设置才可见
  useEffect(() => {
    if (!api) return;
    return api.on("skills:updated", () => {
      void api.skills
        .list()
        .then((result) => {
          setSkills(result.skills);
          setSkillSkips(result.skipped);
        })
        .catch(() => {});
    });
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

  const body = useMemo((): React.JSX.Element | null => {
    if (loading) return <div style={S.muted}>{tr("settings.loading")}</div>;
    if (!api) return <div style={S.muted}>{tr("settings.notInShell")}</div>;
    switch (section) {
      case "appearance":
        return (
          <AppearanceSettingsSection
            api={api}
            prefs={prefs}
            onPrefsChange={setPrefs}
            onPreferencesSaved={onPreferencesSaved}
            onNotice={ok}
            onError={bad}
          />
        );

      case "searchengine":
        return prefs ? (
          <div>
            <Head t={tr("settings.searchengine.head")} h={tr("settings.searchengine.headHint")} />
            <div style={S.engineList}>
              {SEARCH_ENGINE_OPTIONS.map((engine) => {
                const active = prefs.searchEngine === engine.id;
                return (
                  <button
                    key={engine.id}
                    type="button"
                    style={{ ...S.engineRow, ...(active ? S.engineRowActive : {}) }}
                    onClick={() => setPrefs({ ...prefs, searchEngine: engine.id })}
                    aria-pressed={active}
                  >
                    <img src={`./icons/engine-${engine.id}.svg`} width={22} height={22} alt="" style={S.engineLogo} />
                    <span style={S.engineText}>
                      <span style={S.engineName}>{engine.name}</span>
                      <span style={S.engineHost}>{engine.host}</span>
                    </span>
                    <span style={{ ...S.engineRadio, ...(active ? S.engineRadioActive : {}) }}>
                      {active ? <Icon name="check" size={11} /> : null}
                    </span>
                  </button>
                );
              })}
            </div>
            <div style={S.note}>{tr("settings.searchengine.note")}</div>
          </div>
        ) : null;

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
          <Field l={tr("settings.general.browserOpenLayout")} h={tr("settings.general.browserOpenLayoutHint")}>
            <Seg
              v={prefs.browserOpenLayout ?? "docked"}
              opts={[
                ["docked", tr("settings.general.browserOpenLayout.docked")],
                ["agentWindow", tr("settings.general.browserOpenLayout.agentWindow")],
                ["keep", tr("settings.general.browserOpenLayout.keep")],
              ]}
              on={(x) => setPrefs({ ...prefs, browserOpenLayout: x as Preferences["browserOpenLayout"] })}
            />
          </Field>
          <Field l={tr("settings.general.adBlock")} h={tr("settings.general.adBlockHint")}>
            <Toggle v={prefs.adBlockEnabled ?? true} on={(x) => setPrefs({ ...prefs, adBlockEnabled: x })} />
          </Field>
          <Field l={tr("settings.general.restoreSession")}><Toggle v={prefs.restoreSession} on={(x) => setPrefs({ ...prefs, restoreSession: x })} /></Field>
          <Field l={tr("settings.general.maxRounds")} h={tr("settings.general.maxRoundsHint")}>
            <In
              v={String(prefs.agentMaxRounds ?? 80)}
              ph="40"
              on={(x) => setPrefs({ ...prefs, agentMaxRounds: Math.max(1, Math.min(500, Number(x) || 80)) })}
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
          <Field l={tr("settings.general.skillAuto")} h={tr("settings.general.skillAutoHint")}><Toggle v={prefs.skillAutoCandidate ?? false} on={(x) => setPrefs({ ...prefs, skillAutoCandidate: x })} /></Field>
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
          {perms.levels && perms.levels.length > 0 ? (
            <div style={S.box}>
              <div style={S.boxTitle}>{tr("settings.permissions.levelsTitle")}</div>
              <div style={S.note}>{tr("settings.permissions.levelsHint")}</div>
              {perms.levels.map((level) => (
                <div key={level.level} style={S.note}>
                  <code style={S.code}>{level.name}</code> {level.zh} / {level.en} — {level.description}
                </div>
              ))}
            </div>
          ) : null}
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
          setPModelQuery("");
          if (item) {
            setEditingProviderId(item.id);
            setPForm({ provider: item.provider, baseUrl: item.baseUrl, model: item.model });
            setPHeaders(formatHeaderLines(item.headers));
            setPFormat(item.apiFormat ?? "auto");
            setPRpm(item.rpm ? String(item.rpm) : "");
            setPModels(item.models ?? (item.model ? [{ id: item.model }] : []));
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
            const existing = pModels.filter((m) => typeof m.id === "string" && m.id.trim());
            const merge = mergeFetchedProviderModels(
              r.models as ProviderModel[],
              existing,
              (r as { capabilityMeta?: Record<string, ProviderCapabilityMeta> }).capabilityMeta,
            );
            const merged = merge.models;
            if (merged.length > 0) setPModels(merged);
            setPModelsError(r.error);
            if (merged.length > 0 && !r.error) {
              providerOk(
                tr("settings.providers.fetchSummary", {
                  models: merged.length,
                  upstream: merge.upstreamModels,
                  enriched: merge.enrichedModels,
                }),
              );
            }
            if (!merged.some((m) => m.id === pForm.model)) {
              const first = merged[0]?.id ?? "";
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
        /** 全选/取消全选：一键切换模型「显示」开关（不影响当前使用模型与参数）。 */
        const shownCount = pModels.filter((m) => m.selected !== false).length;
        const allShown = pModels.length > 0 && shownCount === pModels.length;
        const setAllShown = (next: boolean): void => {
          setPModels((prev) => prev.map((m) => ({ ...m, selected: next })));
        };
        /** 搜索过滤：只影响表格展示；用原始下标回写，保证编辑/删除不会落到错误的行。 */
        const modelQuery = pModelQuery.trim().toLowerCase();
        const visibleModels = pModels
          .map((m, idx) => ({ m, idx }))
          .filter(({ m }) => !modelQuery || m.id.toLowerCase().includes(modelQuery));
        const commit = async (): Promise<void> => {
          try {
            const models = pModels.filter((m) => m.id.trim());
            // 没有"默认模型"概念：provider.model 只是"当前选用/最近使用"的模型（聊天 chip 可随时切换），
            // 保存时保留它；新增供应商还没有选择时取清单第一个作为初始值。
            const currentModel = pForm.model.trim() || models[0]?.id || "";
            if (!currentModel) throw new Error(tr("settings.providers.needModel"));
            const r = await api.settings.upsertProvider({
              ...(editingProviderId && editingProviderId !== "new" ? { id: editingProviderId } : {}),
              provider: pForm.provider,
              baseUrl: pForm.baseUrl,
              model: currentModel,
              apiFormat: pFormat,
              rpm: pRpm.trim() ? Number(pRpm) : undefined,
              headers: parseHeaderLines(pHeaders, tr) ?? undefined,
              models,
            });
            await api.settings.setActiveProvider({ id: r.item.id });
            const typedKey = keyInput.trim();
            if (typedKey) {
              await api.settings.setApiKey({ providerId: r.item.id, apiKey: typedKey });
              setKeyInput("");
            }
            await refreshProviders();
            setEditingProviderId(null);
            await api.settings.getProvider().then(setProvider).catch(() => {});
            notifyProviders();
            // 刚保存的 Key 立刻用「用户输入的那把」真实验证一次：
            // 旧逻辑测试连接用的是活动供应商的 Key，切 Key 后会误判成「新 Key 无效」。
            if (typedKey) {
              const probe = await api.settings
                .testProvider({
                  id: r.item.id,
                  provider: pForm.provider,
                  baseUrl: pForm.baseUrl,
                  model: currentModel,
                  apiKey: typedKey,
                  headers: parseHeaderLines(pHeaders, tr) ?? undefined,
                })
                .catch(() => null);
              if (probe?.ok) providerOk(tr("settings.providers.keyVerified", { message: probe.message }));
              else providerBad(tr("settings.providers.keyVerifyFailed", { message: probe?.message ?? "" }));
            } else {
              providerOk(tr("settings.providers.saved"));
            }
          } catch (e) {
            providerBad(e);
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
            name: "OpenCode Go（订阅）",
            provider: "opencode-go",
            // 2026-11 官方文档 /docs/console/harnesses#base-urls：Go 订阅与按量付费是两套端点、两套 Key。
            // Go 的 Key 必须走 /inference/go 段（打按量付费端点会 403 Model access is disabled）。
            baseUrl: "https://opencode.ai/inference/go/openai/v1",
            model: "deepseek-v4.1-flash",
            headers: { "x-opencode-session": "{{sessionId}}", "User-Agent": "Loopsoar/1.0" },
          },
          {
            name: "OpenCode Zen（按量付费）",
            provider: "opencode-zen",
            // 按量付费（Console 余额）端点：需在 Console 充值；免费模型仅官方客户端/免费额度内可用。
            baseUrl: "https://opencode.ai/inference/openai/v1",
            model: "glm-5.3",
            headers: { "User-Agent": "Loopsoar/1.0" },
          },
        ];
        return (
          <div>
            <Head t={tr("settings.providers.head")} h={tr("settings.providers.headHint")} />
            {providerItems.map((item) => {
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
                      {(() => {
                        const plan = openCodePlanLabel(item.baseUrl);
                        if (!plan) return null;
                        return (
                          <span style={BADGE.neutral}>
                            {tr(plan === "go" ? "settings.providers.planGo" : "settings.providers.planPayg")}
                          </span>
                        );
                      })()}
                      <span style={S.tag}>{tr("settings.providers.modelCount", { count: item.models?.length ?? 1 })}</span>
                      {item.rpm ? <span style={S.tag}>RPM {item.rpm}</span> : null}
                    </span>
                    <span style={S.icons}>
                      <Btn label={tr("settings.test")} small onClick={() => void api.settings.testProvider({ id: item.id, provider: item.provider, baseUrl: item.baseUrl, model: item.model, headers: item.headers }).then(setTestRes).catch(providerBad)} />
                      <Btn label={tr("settings.edit")} small onClick={() => startEdit(item)} />
                      <Btn label={tr("settings.delete")} small onClick={() => void api.settings.removeProvider({ id: item.id }).then(async () => { await refreshProviders(); await api.settings.getProvider().then(setProvider).catch(() => {}); notifyProviders(); }).catch(providerBad)} />
                    </span>
                  </div>
                  <div style={S.providerRows}>
                    <div style={S.providerRow}><span style={S.providerKey}>{tr("settings.providers.interfaceAddr")}</span><span style={S.providerVal}>{item.baseUrl}</span></div>
                    {item.headers && Object.keys(item.headers).length > 0 ? (
                      <div style={S.providerRow}><span style={S.providerKey}>{tr("settings.providers.headers")}</span><span style={S.providerVal}>{tr("settings.providers.headerCount", { count: Object.keys(item.headers).length })}</span></div>
                    ) : null}
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
                        <Btn label={tr("settings.providers.clear")} small onClick={() => void api.settings.clearApiKey({ providerId: item.id }).then(async () => { await refreshProviders(); await api.settings.getProvider().then(setProvider).catch(() => {}); notifyProviders(); providerOk(tr("settings.providers.cleared")); }).catch(providerBad)} />
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
            <div style={S.btns}><Btn label={tr("settings.providers.add")} primary onClick={() => startEdit()} /></div>
            {editingProviderId !== null
              ? createPortal(
                  <div style={S.modalBackdrop} role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setEditingProviderId(null); }}>
                <div style={S.modal} role="dialog" aria-modal="true" aria-label={editingProviderId === "new" ? tr("settings.providers.addTitle") : tr("settings.providers.editTitle")}>
                  <div style={S.modalHead}>
                    <div style={S.modalHeadText}>
                      <div style={S.modalTitle}>{editingProviderId === "new" ? tr("settings.providers.addTitle") : tr("settings.providers.editTitle")}</div>
                      <div style={S.modalSub}>
                        {pForm.provider || "—"}
                        {pForm.baseUrl ? ` · ${pForm.baseUrl}` : ""}
                      </div>
                    </div>
                    <button type="button" className="icon-btn" title={tr("settings.close")} aria-label={tr("settings.close")} onClick={() => setEditingProviderId(null)}>
                      <Icon name="close" size={13} />
                    </button>
                  </div>
                  <div style={S.modalBody} ref={editBodyRef}>
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
                          providerBad(tr("settings.providers.pasteKeyFirst"));
                          return;
                        }
                        const saved = providerItems.find((i) => i.id === editingProviderId);
                        if (!saved) {
                          providerBad(tr("settings.providers.createFirst"));
                          return;
                        }
                        void api.settings
                          .setApiKey({ providerId: saved.id, apiKey: keyInput.trim() })
                          .then(async (r) => {
                            const typed = keyInput.trim();
                            setKeyInput("");
                            await refreshProviders();
                            await api.settings.getProvider().then(setProvider).catch(() => {});
                            notifyProviders();
                            providerOk(tr("settings.providers.keySavedOk", {
                              mode: r.storageMode === "os" ? tr("settings.providers.storageOs") : tr("settings.providers.storageDegraded"),
                            }));
                            // 保存后立刻用刚输入的 Key 真实验证（避免「已保存但实际用的不是它」的误判）
                            const probe = await api.settings
                              .testProvider({
                                id: saved.id,
                                provider: saved.provider,
                                baseUrl: saved.baseUrl,
                                model: saved.model,
                                apiKey: typed,
                                headers: saved.headers,
                              })
                              .catch(() => null);
                            if (probe?.ok) providerOk(tr("settings.providers.keyVerified", { message: probe.message }));
                            else providerBad(tr("settings.providers.keyVerifyFailed", { message: probe?.message ?? "" }));
                          })
                          .catch(providerBad);
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
                  {/* 全选/取消全选 + 计数摘要：单独一行放在表格上方（不再塞进表头，避免挤压「显示」列） */}
                  <div style={S.modelToolbar}>
                    <span style={S.modelToolLabel}>
                      <Toggle
                        v={allShown}
                        on={setAllShown}
                        title={`${tr("settings.providers.toggleAll")}（${shownCount}/${pModels.length}）`}
                        testId="model-toggle-all"
                      />
                      <span>{tr("settings.providers.toggleAll")}</span>
                    </span>
                    <span style={S.modelToolHint}>
                      {tr("settings.providers.modelSummary", { total: pModels.length, on: shownCount })}
                    </span>
                  </div>
                  <div style={S.modelAddRow}>
                    <input
                      style={S.modelSearch}
                      value={pModelQuery}
                      onChange={(e) => setPModelQuery(e.target.value)}
                      placeholder={tr("settings.providers.searchModels", { count: pModels.length })}
                      aria-label={tr("settings.providers.searchModels", { count: pModels.length })}
                      data-testid="model-search"
                    />
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
                            <th style={S.th} data-testid="col-input-modalities">{tr("settings.providers.col.modalities")}</th>
                            <th style={S.thState} data-testid="col-function-calling">{tr("settings.providers.col.functionCalling")}</th>
                            <th style={S.thState} data-testid="col-structured-output">{tr("settings.providers.col.structuredOutput")}</th>
                            <th style={S.thTiny}></th>
                          </tr>
                        </thead>
                        <tbody>
                          {visibleModels.length === 0 ? (
                            <tr>
                              <td style={S.muted} colSpan={11}>{tr("settings.providers.noMatchingModels")}</td>
                            </tr>
                          ) : null}
                          {visibleModels.map(({ m, idx }) => (
                            <tr key={m.id + idx}>
                              <td style={S.td}>
                                {/* 拨片开关：控制该模型是否出现在输入区「模型」菜单（关闭=不在菜单展示，仍保留参数） */}
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
                              <td style={S.td}>
                                {/* 输入模态：逗号分隔编辑（非法值自动过滤），悬停显示可读徽标文本 */}
                                <input
                                  style={S.tblInput}
                                  value={modalitiesToInput(m.inputModalities)}
                                  placeholder={tr("settings.providers.modalitiesPlaceholder")}
                                  title={`${tr("settings.providers.col.modalities")}: ${formatModalities(m.inputModalities, tr)}`}
                                  aria-label={tr("settings.providers.modalitiesHint")}
                                  data-testid="model-cap-modalities"
                                  data-model-id={m.id}
                                  onChange={(e) => {
                                    const next = parseModalitiesInput(e.target.value);
                                    updateModel(idx, { inputModalities: next.length > 0 ? next : undefined });
                                  }}
                                />
                              </td>
                              <td style={S.tdState}>
                                {/* 三态能力：auto=自动/未知(undefined)，supported=支持，unsupported=不支持 */}
                                <select
                                  style={S.tblSelect}
                                  value={triStateToValue(m.functionCalling)}
                                  title={tr("settings.providers.col.functionCalling")}
                                  aria-label={tr("settings.providers.col.functionCalling")}
                                  data-testid="model-cap-function-calling"
                                  data-model-id={m.id}
                                  onChange={(e) => updateModel(idx, { functionCalling: valueToTriState(e.target.value) })}
                                >
                                  <option value="">{tr("settings.providers.capAuto")}</option>
                                  <option value="true">{tr("settings.providers.capSupported")}</option>
                                  <option value="false">{tr("settings.providers.capUnsupported")}</option>
                                </select>
                              </td>
                              <td style={S.tdState}>
                                <select
                                  style={S.tblSelect}
                                  value={triStateToValue(m.structuredOutput)}
                                  title={tr("settings.providers.col.structuredOutput")}
                                  aria-label={tr("settings.providers.col.structuredOutput")}
                                  data-testid="model-cap-structured-output"
                                  data-model-id={m.id}
                                  onChange={(e) => updateModel(idx, { structuredOutput: valueToTriState(e.target.value) })}
                                >
                                  <option value="">{tr("settings.providers.capAuto")}</option>
                                  <option value="true">{tr("settings.providers.capSupported")}</option>
                                  <option value="false">{tr("settings.providers.capUnsupported")}</option>
                                </select>
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
                  </div>
                  <div style={S.modalFoot}>
                    <div style={S.modalStatus}>
                      {testRes ? (
                        <span style={testRes.ok ? S.okText : S.errText}>
                          <Icon name={testRes.ok ? "check" : "close"} size={11} style={{ verticalAlign: "-1px", marginRight: 4 }} />
                          {testRes.message}
                        </span>
                      ) : pModelsError ? (
                        <span style={S.errText}>{pModelsError}</span>
                      ) : (
                        <span style={S.fieldHint}>{tr("settings.providers.modalHint")}</span>
                      )}
                    </div>
                    <div style={S.btns}>
                      <Btn label={tr("settings.providers.testConnection")} onClick={() => void api.settings.testProvider({ id: editingProviderId && editingProviderId !== "new" ? editingProviderId : undefined, provider: pForm.provider, baseUrl: pForm.baseUrl, model: pForm.model || "default", apiKey: keyInput.trim() || undefined, headers: parseHeaderLines(pHeaders, tr) }).then(setTestRes).catch(providerBad)} />
                      <Btn label={tr("settings.providers.saveEnable")} primary onClick={() => void commit()} />
                      <Btn label={tr("settings.cancel")} onClick={() => setEditingProviderId(null)} />
                    </div>
                  </div>
                </div>
              </div>,
                  document.body,
                )
              : null}
            <div style={S.note}>{tr("settings.providers.securityNote")}</div>
          </div>
        );
      }

      case "rules":
        return <RulesSettingsSection api={api} onNotice={ok} onError={bad} />;

      case "memory":
        return (
          <MemorySettingsSection
            api={api}
            prefs={prefs}
            locations={locations}
            onPrefsChange={setPrefs}
            onSavePrefs={savePrefs}
            onNotice={ok}
            onError={bad}
          />
        );

      case "extensions":
        return <ExtensionsSection onError={bad} />;

      case "skills":
        return (
          <SkillsSection
            skills={skills}
            skillsDir={skillsDir}
            skillSkips={skillSkips}
            onOpenDir={() =>
              api.skills
                .openDir()
                .then((result) => {
                  if (!result.ok) bad(tr("settings.extensions.openFailed", { dir: result.dir }));
                })
                .catch(bad)
            }
            onReload={() =>
              api.skills.reload().then((result) => {
                setSkills(result.skills);
                setSkillSkips(result.skipped);
              })
            }
            onImport={async () => {
              const picked = await api.dialog.pickPath({ kind: "directory", title: tr("settings.skills.importTitle") });
              if (picked.canceled || !picked.path) return;
              const sourcePath = picked.path;
              let result = await api.skills.import({ sourcePath }).catch((err) => (bad(err), null));
              if (!result) return;
              if (!result.ok && (result.error ?? "").includes("已存在") && window.confirm(tr("settings.skills.overwriteConfirm"))) {
                result = await api.skills.import({ sourcePath, overwrite: true }).catch((err) => (bad(err), null));
                if (!result) return;
              }
              if (!result.ok) {
                bad(result.error ?? tr("settings.skills.importFailed"));
                return;
              }
              setSkills(result.skills);
              ok(tr("settings.skills.imported", { id: result.id ?? "", files: result.files ?? 0 }));
            }}
            onToggle={(id, enabled) =>
              api.skills.setEnabled({ id, enabled }).then(() =>
                api.skills.list().then((result) => setSkills(result.skills)),
              )
            }
            onRemove={(id) => {
              if (!window.confirm(tr("settings.skills.removeConfirm"))) return Promise.resolve();
              return api.skills.remove({ id }).then((result) => {
                if (!result.ok) bad(tr("settings.skills.removeFailed"));
              });
            }}
          />
        );

      case "browser-extensions":
        return <BrowserExtensionsSection onOpenUrl={onOpenUrl} />;

      case "terminal-env":
        return <TerminalDiagnosticsSection />;

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
          <TraceSection api={api} />
        </div>) : <div style={S.muted}>{tr("settings.readFailed")}</div>;

      case "about":
        return about ? (<div>
          <Head t={tr("settings.about.head")} h={tr("settings.about.headHint")} />
          <div style={S.about}><img src="./logo.png" alt="Loopsoar" width={56} height={56} style={{ borderRadius: 10 }} />
            <div><BrandWordmark size={18} weight={800} /><div style={S.tag}>{tr("settings.about.version", { version: about.version })}</div></div></div>
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
  }, [section, loading, api, prefs, locations, perms, pForm, testRes, diag, about, savePrefs, savePerms, bad, providerItems, activeProviderId, editingProviderId, ok, skills, skillsDir, skillSkips, mcpServers, mcpConfigPath, mcpForm, keyInput, pModels, pModelsError, pFetching, pFormat, pRpm, pModelDraft, pModelQuery, loopInfo, loopBusy, latestLoopFallback, chooseLoop, reloadLoops, onOpenOnboarding, tr, provider]);

  return (
    <div
      className={fullPage ? "settings-fullpage" : "settings-overlay"}
      data-fullpage-overlay={fullPage ? undefined : "settings"}
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
      {providerToast ? (
        <div
          key={providerToast.key}
          role="status"
          aria-live="polite"
          style={{ ...S.providerToast, ...(providerToast.kind === "ok" ? S.providerToastOk : S.providerToastErr) }}
        >
          <Icon name={providerToast.kind === "ok" ? "check" : "warning"} size={13} style={{ marginTop: 2, flex: "none" }} />
          <span>{providerToast.text}</span>
        </div>
      ) : null}
    </div>
  );
}
