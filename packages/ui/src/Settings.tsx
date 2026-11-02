import React, { useCallback, useEffect, useMemo, useState } from "react";
import { BRAND, BADGE } from "./theme.js";
import {
  HEADER_TEMPLATE_VARIABLES,
  unknownHeaderTemplateVariables,
} from "loopsoar-contracts/headerTemplate";
import TopicRail from "./TopicRail.js";
import { DEFAULT_CHAT_RAIL, loadRailParams, saveRailParams, type RailParams } from "./railParams.js";
import { Icon } from "./Icon.js";
import type {
  AboutInfo, DiagnosticsInfo, ExtensionRuntimeStatus, InstalledExtension, LocationsInfo, LoopInfo, LoopListResult, LoopsoarAPI, McpServerInfo, MemoryListResult,
  PermissionsState, Preferences, ProviderItem, ProviderModel, ProviderStatus, RulesSnapshot, SkillRecord, TestProviderResult,
} from "./types.js";

/**
 * 设置面板：通用 / 权限 / 供应商 / 规则（逐条增删）/ 记忆 / 存储（文件位置）/ 高级 / 关于。
 * 全部数据经 preload 白名单；规则与记忆在保存后即时生效（主进程惰性读取）。
 */

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

const SECTIONS: { id: SectionId; label: string; icon: string; hint: string; group: string }[] = [
  { id: "general", group: "基础", label: "通用", icon: "settings", hint: "搜索、启动、代理" },
  { id: "appearance", group: "基础", label: "外观", icon: "capture", hint: "卷轴参数 / 动效" },
  { id: "permissions", group: "基础", label: "权限", icon: "check", hint: "工具类别决策" },
  { id: "providers", group: "能力", label: "供应商", icon: "cloud-upload", hint: "模型服务" },
  { id: "rules", group: "能力", label: "规则", icon: "file", hint: "AGENTS.md 逐条" },
  { id: "skills", group: "能力", label: "技能", icon: "bulb", hint: "SKILL.md 提示词" },
  { id: "memory", group: "能力", label: "记忆", icon: "notes", hint: "会话记忆汇总" },
  { id: "extensions", group: "能力", label: "扩展", icon: "puzzle", hint: "本地插件" },
  { id: "mcp", group: "能力", label: "MCP", icon: "terminal", hint: "外部工具服务" },
  { id: "storage", group: "数据", label: "存储", icon: "folders", hint: "文件位置" },
  { id: "advanced", group: "数据", label: "高级", icon: "terminal", hint: "路径与版本" },
  { id: "about", group: "其他", label: "关于", icon: "bulb", hint: "版本与品牌" },
];

interface DraftRule {
  key: string; name: string; scope: "global" | "workspace";
  enabled: boolean; content: string; persisted: boolean; path: string;
}

export default function Settings({ api, onClose, onPreferencesSaved, initialSection }: {
  api: LoopsoarAPI | null; onClose: () => void; onPreferencesSaved?: (p: Preferences) => void; initialSection?: SectionId;
}): React.JSX.Element {
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
  const [pEditing, setPEditing] = useState(false);
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
          setNotice({ kind: "error", text: `Agent-Loop 已回退到内置 loop：${info?.reason ?? "原因未知"}` });
          void refreshLoops();
        }),
      );
    } catch {
      // 同上
    }
    return () => {
      for (const off of offs) off();
    };
  }, [api, refreshLoops]);

  const chooseLoop = useCallback(async (loop: LoopInfo): Promise<void> => {
    if (!api || loopBusy || loop.active) return;
    setLoopBusy(true);
    try {
      const result = await api.loop.setActive({ id: loop.id });
      if (!result?.ok) {
        bad(result?.error ?? "切换 Agent-Loop 失败");
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
      ok(`Agent-Loop 已切换：${loop.name}`);
    } catch (e) {
      bad(e);
    } finally {
      setLoopBusy(false);
    }
  }, [api, loopBusy, ok, bad]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const savePrefs = useCallback(async () => {
    if (!api || !prefs) return;
    try { const r = await api.settings.setPreferences(prefs); setPrefs(r.preferences); onPreferencesSaved?.(r.preferences); ok("已保存（工作区/记忆库位置即时生效）"); }
    catch (e) { bad(e); }
  }, [api, prefs, onPreferencesSaved, ok, bad]);

  const savePerms = useCallback(async () => {
    if (!api || !perms) return;
    try { const r = await api.settings.setPermissions(perms.permissions); setPerms({ ...perms, permissions: r.permissions }); ok("权限策略已保存（下次工具调用生效）"); }
    catch (e) { bad(e); }
  }, [api, perms, ok, bad]);

  const saveProvider = useCallback(async () => {
    if (!api) return;
    try { const r = await api.settings.setProvider(pForm); setProvider((v) => v ? { ...v, configured: true, ...pForm, usable: r.usable, reason: r.reason ?? null } : v); ok("模型服务已保存（无需重启）"); }
    catch (e) { bad(e); }
  }, [api, pForm, ok, bad]);

  const saveRules = useCallback(async () => {
    if (!api) return;
    try {
      const r = await api.settings.setRules({ entries: drafts.map((d) => ({ name: d.name.trim(), scope: d.scope, enabled: d.enabled, content: d.content })), deleted });
      applyRules(await api.settings.getRules());
      ok(`规则已保存（生效 ${r.merged.included.length} 份）`);
    } catch (e) { bad(e); }
  }, [api, drafts, deleted, applyRules, ok, bad]);

  const addDraft = (scope: "global" | "workspace") => setDrafts((v) => [...v, {
    key: `new-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
    name: scope === "global" ? "新规则.md" : "AGENTS.md", scope, enabled: true, content: "", persisted: false, path: "",
  }]);

  const removeDraft = (d: DraftRule) => {
    setDrafts((v) => v.filter((x) => x.key !== d.key));
    if (d.persisted) setDeleted((v) => [...v, d.key]);
  };

  const addMemory = useCallback(async () => {
    if (!api || !mForm.content.trim()) return;
    try { await api.memory.add({ content: mForm.content.trim(), category: mForm.category || "general", importance: 5 }); setMForm({ content: "", category: "general" }); setMem(await api.memory.list()); ok("记忆已添加"); }
    catch (e) { bad(e); }
  }, [api, mForm, ok, bad]);

  const saveMemEdit = useCallback(async () => {
    if (!api || !mEdit) return;
    try { await api.memory.update({ id: mEdit.id, content: mEdit.content }); setMEdit(null); setMem(await api.memory.list()); }
    catch (e) { bad(e); }
  }, [api, mEdit, bad]);

  const body = useMemo((): React.JSX.Element => {
    if (loading) return <div style={S.muted}>加载设置…</div>;
    if (!api) return <div style={S.muted}>未在 Electron shell 中运行。</div>;
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
              ok("动效强度已保存");
            })
            .catch(bad);
        };
        const sliderDefs: { key: keyof Pick<RailParams, "w" | "amp" | "lam0" | "lam1" | "spd" | "tap">; label: string; min: number; max: number; step: number; fmt: (v: number) => string }[] = [
          { key: "w", label: "卷轴宽度", min: 6, max: 32, step: 1, fmt: (v) => `${v}px` },
          { key: "amp", label: "常态振幅", min: 0, max: 100, step: 1, fmt: (v) => `${v}%` },
          { key: "lam0", label: "亮线波长", min: 8, max: 400, step: 1, fmt: (v) => `${v}px` },
          { key: "lam1", label: "暗线波长", min: 8, max: 400, step: 1, fmt: (v) => `${v}px` },
          { key: "spd", label: "荡漾速度", min: 0, max: 4, step: 0.05, fmt: (v) => v.toFixed(2) },
          { key: "tap", label: "两端渐隐", min: 0, max: 400, step: 5, fmt: (v) => `${v}px` },
        ];
        return (
          <div>
            <Head t="外观" h="聊天区卷轴（滚动条）参数即时生效：拖动即滚动、悬停查看位置与消息摘要" />
            <div style={{ display: "flex", gap: 16, alignItems: "stretch", flexWrap: "wrap" }}>
              <div style={{ width: 320, maxWidth: "100%", flexShrink: 0 }}>
                <div style={S.fieldLabel}><span>实时预览</span><span style={S.fieldHint}>悬停 / 拖动查看效果</span></div>
                <div style={{ position: "relative", height: 300, border: `1px solid ${BRAND.border}`, borderRadius: 10, overflow: "hidden", background: BRAND.ink }}>
                  <div id="loopsoar-rail-demo" className="chat-scroll" style={{ height: "100%", overflowY: "auto", padding: "10px 34px 10px 10px" }}>
                    {[
                      "你：帮我总结当前网页",
                      "Loopsoar：我先看页面结构，再提取正文。",
                      "你：顺便找出三个关键结论",
                      "Loopsoar：已提取正文并整理成要点。",
                      "你：把结论写成表格",
                      "Loopsoar：表格已生成，可复制到文档。",
                      "你：再检查有没有遗漏的数据",
                      "Loopsoar：检查完毕，补充了两处数据来源。",
                    ].map((line, i) => (
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
                <div style={S.note}>把鼠标放进预览框：悬停出现位置气泡，按住拖动即滚动。外观设置与聊天区共用同一份参数。</div>
              </div>
              <div style={{ flex: 1, minWidth: 280 }}>
                <div className="panel-card" style={S.card}>
                  <div style={S.formHead}>卷轴参数</div>
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
                      悬停时暂停荡漾
                    </label>
                    <label style={S.checkRow}>
                      <input type="checkbox" checked={rail.flip} onChange={(e) => updateRail({ flip: e.target.checked })} />
                      衬托方向翻转
                    </label>
                  </div>
                  <div style={S.btns}>
                    <Btn label="恢复默认" onClick={() => setRail(saveRailParams({ ...DEFAULT_CHAT_RAIL }))} />
                  </div>
                </div>
                <div className="panel-card" style={S.card}>
                  <div style={S.formHead}>动效</div>
                  <Field l="动画强度" h="关：所有入场 / 波动动画停止（无障碍）">
                    <Seg
                      v={prefs?.animations ?? "full"}
                      opts={[["full", "完整"], ["reduced", "减弱"], ["off", "关闭"]]}
                      on={saveAnimations}
                    />
                  </Field>
                  <div style={S.note}>与 slime 外观页一致：参数改动即时生效、无需重启；保存在本机浏览器存储。</div>
                </div>
              </div>
            </div>
          </div>
        );
      }

      case "general":
        return prefs ? (<div>
          <Head t="通用" h="外观、搜索与启动行为（config/preferences.json）" />
          <Field l="语言"><Seg v={prefs.language} opts={[["zh-CN", "简体中文"], ["en-US", "English"]]} on={(x) => setPrefs({ ...prefs, language: x as Preferences["language"] })} /></Field>
          <Field l="动效强度" h="关闭后全局停用动画与过渡"><Seg v={prefs.animations} opts={[["full", "完整"], ["reduced", "弱化"], ["off", "关闭"]]} on={(x) => setPrefs({ ...prefs, animations: x as Preferences["animations"] })} /></Field>
          <Field l="默认搜索引擎"><Seg v={prefs.searchEngine} opts={[["bing", "Bing"], ["google", "Google"], ["duckduckgo", "DuckDuckGo"]]} on={(x) => setPrefs({ ...prefs, searchEngine: x as Preferences["searchEngine"] })} /></Field>
          <Field l="广告拦截" h="拦截广告与追踪请求（请求层过滤，默认开启）；若网站因拦截出现异常可关闭">
            <Toggle v={prefs.adBlockEnabled ?? true} on={(x) => setPrefs({ ...prefs, adBlockEnabled: x })} />
          </Field>
          <Field l="启动时恢复上次会话"><Toggle v={prefs.restoreSession} on={(x) => setPrefs({ ...prefs, restoreSession: x })} /></Field>
          <Field l="Agent 请求上限" h="单次任务最多请求轮数（默认 40）；防止异常循环，撞上限会明确标注中断原因">
            <In
              v={String(prefs.agentMaxRounds ?? 40)}
              ph="40"
              on={(x) => setPrefs({ ...prefs, agentMaxRounds: Math.max(1, Math.min(500, Number(x) || 40)) })}
            />
          </Field>
          <Field l="工具调用上限" h="单次任务最多工具调用次数（默认 100）">
            <In
              v={String(prefs.agentMaxToolCalls ?? 100)}
              ph="100"
              on={(x) => setPrefs({ ...prefs, agentMaxToolCalls: Math.max(1, Math.min(2000, Number(x) || 100)) })}
            />
          </Field>
          <Field l="重复工具提醒" h="相同工具+参数重复调用到第 N 次时提醒模型停止（默认 5）">
            <In
              v={String(prefs.agentRepeatToolWarn ?? 5)}
              ph="5"
              on={(x) => setPrefs({ ...prefs, agentRepeatToolWarn: Math.max(2, Math.min(50, Number(x) || 5)) })}
            />
          </Field>
          <Field l="重复工具停止" h="相同工具+参数重复调用到第 N 次时强制停止（默认 30；会先给出防循环提示）">
            <In
              v={String(prefs.agentRepeatToolStop ?? 30)}
              ph="30"
              on={(x) => setPrefs({ ...prefs, agentRepeatToolStop: Math.max(3, Math.min(200, Number(x) || 30)) })}
            />
          </Field>
          <Field l="自动记忆汇总" h="每轮对话结束自动抽取记忆"><Toggle v={prefs.memoryAutoCapture} on={(x) => setPrefs({ ...prefs, memoryAutoCapture: x })} /></Field>
          <Field l="Agent Loop" h="Agent 执行循环。内置 loop 不可删除、不可原位修改；自定义 loop 失败会自动回退到内置（同一上下文重跑，任务不重来）">
            <div className="loop-picker" aria-busy={loopBusy}>
              {loopInfo ? (
                loopInfo.loops.length > 0 ? (
                  loopInfo.loops.map((loop) => (
                    <button
                      key={loop.id}
                      type="button"
                      className={`loop-item${loop.active ? " is-active" : ""}`}
                      disabled={loopBusy}
                      aria-pressed={loop.active}
                      title={loop.builtin ? "内置 loop：不可删除、不可原位修改（可复制为新 loop 再改）" : "自定义 loop"}
                      onClick={() => void chooseLoop(loop)}
                    >
                      <span className="loop-item-name">{loop.name}</span>
                      <span className="loop-item-tags">
                        {loop.builtin ? <span style={BADGE.neutral}>内置</span> : <span style={BADGE.warn}>自定义</span>}
                        {loop.active ? <span style={BADGE.ok}>当前</span> : null}
                      </span>
                    </button>
                  ))
                ) : (
                  <span className="loop-empty">没有可运行的 Agent-Loop</span>
                )
              ) : (
                <span className="loop-empty">Agent-Loop 不可用（shell 未装配 loop 域）</span>
              )}
              {latestLoopFallback ? (
                <div className="loop-fallback" role="status">
                  最近回退（{formatWhen(latestLoopFallback.at)}）：{latestLoopFallback.reason}
                </div>
              ) : null}
            </div>
          </Field>
          <div style={S.note}>以上设置修改后立即生效（自动保存）。</div>
        </div>) : <div style={S.muted}>读取失败</div>;

      case "permissions":
        return perms ? (<div>
          <Head t="权限" h="类别默认决策：允许 / 每次询问 / 拒绝；危险命令与敏感路径始终二次确认。" />
          {perms.categories.map((c) => (
            <Field key={c.key} l={c.label} h={c.description}>
              <Seg v={perms.permissions[c.key as keyof typeof perms.permissions] as string} opts={[["allow", "允许"], ["confirm", "询问"], ["deny", "拒绝"]]}
                on={(x) => setPerms({ ...perms, permissions: { ...perms.permissions, [c.key]: x } })} />
            </Field>
          ))}
          <Field l="危险操作始终确认"><Toggle v={perms.permissions.confirmDangerousAlways} on={(x) => setPerms({ ...perms, permissions: { ...perms.permissions, confirmDangerousAlways: x } })} /></Field>
          <Field l="额外工作目录" h="每行一个绝对路径"><Area v={perms.permissions.workspaceRoots.join("\n")} rows={3} on={(x) => setPerms({ ...perms, permissions: { ...perms.permissions, workspaceRoots: x.split("\n").map((s) => s.trim()).filter(Boolean) } })} /></Field>
          <div style={S.note}>当前工作区根：<code style={S.code}>{perms.workspaceRoot}</code></div>
          <SaveBtn onClick={savePerms} label="保存权限策略" />
        </div>) : <div style={S.muted}>读取失败</div>;

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
              headers: parseHeaderLines(pHeaders) ?? undefined,
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
            if (!defaultModel) throw new Error("请至少配置一个模型（或点击「获取模型列表」）");
            const r = await api.settings.upsertProvider({
              ...(editingProviderId && editingProviderId !== "new" ? { id: editingProviderId } : {}),
              provider: pForm.provider,
              baseUrl: pForm.baseUrl,
              model: defaultModel,
              apiFormat: pFormat,
              rpm: pRpm.trim() ? Number(pRpm) : undefined,
              headers: parseHeaderLines(pHeaders) ?? undefined,
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
            ok("供应商已保存并设为活跃（含模型参数）");
          } catch (e) {
            bad(e);
          }
        };
        const protoLabel = (f?: string): string => (f === "anthropic" ? "Anthropic" : f === "openai" ? "OpenAI" : "自动");
        return (
          <div>
            <Head t="供应商" h="OpenAI 兼容 / Anthropic 端点；API Key 加密保存只显示掩码；模型参数（上下文/输出/视觉/推理等级）随配置保存" />
            {providerItems.map((item) => {
              const spec = item.models?.find((m) => m.id === item.model);
              return (
                <div key={item.id} className="panel-card" style={S.card}>
                  <div style={S.rowBetween}>
                    <span style={S.meta}>
                      <button
                        type="button"
                        className="icon-btn"
                        title={item.id === activeProviderId ? "当前活跃" : "设为活跃"}
                        onClick={() => void api.settings.setActiveProvider({ id: item.id }).then(async () => { await refreshProviders(); await api.settings.getProvider().then(setProvider).catch(() => {}); notifyProviders(); })}
                        style={{ width: 20, height: 20 }}
                      >
                        <Icon name={item.id === activeProviderId ? "check" : "cloud-upload"} size={13} />
                      </button>
                      <span style={S.metaTitle}>{item.provider}</span>
                      <span style={item.id === activeProviderId ? BADGE.ok : BADGE.neutral}>{item.id === activeProviderId ? "活跃" : "备用"}</span>
                      <span style={BADGE.neutral}>{protoLabel(item.apiFormat)}</span>
                      <span style={S.tag}>{item.models?.length ?? 1} 个模型</span>
                      {item.rpm ? <span style={S.tag}>RPM {item.rpm}</span> : null}
                    </span>
                    <span style={S.icons}>
                      <Btn label="测试" small onClick={() => void api.settings.testProvider({ provider: item.provider, baseUrl: item.baseUrl, model: item.model, headers: item.headers }).then(setTestRes).catch(bad)} />
                      <Btn label="编辑" small onClick={() => startEdit(item)} />
                      <Btn label="删除" small onClick={() => void api.settings.removeProvider({ id: item.id }).then(async () => { await refreshProviders(); await api.settings.getProvider().then(setProvider).catch(() => {}); notifyProviders(); }).catch(bad)} />
                    </span>
                  </div>
                  <div style={S.providerRows}>
                    <div style={S.providerRow}><span style={S.providerKey}>接口</span><span style={S.providerVal}>{item.baseUrl}</span></div>
                    {item.headers && Object.keys(item.headers).length > 0 ? (
                      <div style={S.providerRow}><span style={S.providerKey}>请求头</span><span style={S.providerVal}>{Object.keys(item.headers).length} 条</span></div>
                    ) : null}
                    <div style={S.providerRow}>
                      <span style={S.providerKey}>默认模型</span>
                      <span style={S.providerVal}>
                        {item.model}
                        {spec ? `（上下文 ${spec.contextWindow ? Math.round(spec.contextWindow / 1000) + "K" : "—"} · 输出 ${spec.maxOutput ? Math.round(spec.maxOutput / 1000) + "K" : "—"}${spec.vision ? " · 视觉" : ""}${spec.thinking ? " · 推理" : ""}）` : ""}
                      </span>
                    </div>
                    <div style={S.providerRow}>
                      <span style={S.providerKey}>密钥</span>
                      <span style={S.providerVal}>{item.hasKey ? `已加密保存 ${item.keyHint ?? ""}（${item.keySource === "env" ? "环境变量" : "密钥库"}）` : "未配置"}</span>
                      {item.hasKey ? (
                        <Btn label="清除" small onClick={() => void api.settings.clearApiKey({ providerId: item.id }).then(async () => { await refreshProviders(); await api.settings.getProvider().then(setProvider).catch(() => {}); notifyProviders(); ok("已清除该供应商的密钥"); }).catch(bad)} />
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
            {editingProviderId === null ? (
              <div style={S.btns}><Btn label="添加供应商" primary onClick={() => startEdit()} /></div>
            ) : (
              <div className="panel-card" style={S.card}>
                <div style={S.formHead}>{editingProviderId === "new" ? "添加供应商" : "编辑供应商"}</div>
                <div style={S.presetRow}>
                  <span style={S.tag}>快速填充</span>
                  {([
                    { name: "DeepSeek", provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
                    { name: "OpenAI", provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
                    { name: "OpenRouter", provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", model: "deepseek/deepseek-chat" },
                    { name: "Agnes", provider: "agnes", baseUrl: "https://api.agnes-ai.cn/v1", model: "agnes-3.0-flash" },
                    { name: "本地", provider: "local", baseUrl: "http://127.0.0.1:8080/v1", model: "local-model" },
                    {
                      name: "OpenCode Go",
                      provider: "opencode-go",
                      baseUrl: "https://opencode.ai/inference/go/openai/v1",
                      model: "glm-5.3",
                      headers: { "x-opencode-session": "{{sessionId}}", "User-Agent": "Loopsoar/1.0" },
                    },
                  ] satisfies { name: string; provider: string; baseUrl: string; model: string; headers?: Record<string, string> }[]).map((preset) => (
                    <Btn
                      key={preset.name}
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
                <Field l="服务商"><In v={pForm.provider} ph="deepseek / openai / agnes / local" on={(x) => setPForm({ ...pForm, provider: x })} /></Field>
                <Field l="接口地址"><In v={pForm.baseUrl} ph="https://api.deepseek.com/v1" on={(x) => setPForm({ ...pForm, baseUrl: x })} /></Field>
                <Field l="端点协议" h="自动：按接口地址推断（含 anthropic/claude → Anthropic Messages）；也可强制指定">
                  <Seg v={pFormat} opts={[["auto", "自动"], ["openai", "OpenAI 兼容"], ["anthropic", "Anthropic"]]} on={(x) => setPFormat(x as "auto" | "openai" | "anthropic")} />
                </Field>
                <Field l="API 密钥" h="保存时加密写入系统密钥库；不落日志、不回传、只显示掩码">
                  <div style={S.col}>
                    <div style={S.rowEnd}>
                      <In v={keyInput} ph="sk-…（粘贴后点保存并启用）" type="password" on={setKeyInput} />
                      <Btn label={pFetching ? "获取中…" : "获取模型列表"} small onClick={() => void fetchModels()} />
                    </div>
                    {pModelsError ? <div style={S.errText}>{pModelsError}</div> : null}
                  </div>
                </Field>
                <Field l="密钥状态" h="加密落盘后跨重启自动沿用；可单独保存，不必改动供应商配置">
                  <div style={S.rowBetween}>
                    <span style={S.tag}>
                      {(() => {
                        const saved = providerItems.find((i) => i.id === editingProviderId);
                        if (!saved) return "供应商尚未保存";
                        return saved.hasKey ? `已保存 ${saved.keyHint ?? ""}（${saved.keySource === "env" ? "环境变量" : "密钥库"}）` : "尚未保存密钥";
                      })()}
                    </span>
                    <Btn
                      label="保存密钥"
                      small
                      onClick={() => {
                        if (!keyInput.trim()) {
                          bad("请先在「API 密钥」里粘贴密钥");
                          return;
                        }
                        const saved = providerItems.find((i) => i.id === editingProviderId);
                        if (!saved) {
                          bad("请先点「保存并启用」创建供应商，再单独保存密钥");
                          return;
                        }
                        void api.settings
                          .setApiKey({ providerId: saved.id, apiKey: keyInput.trim() })
                          .then(async (r) => {
                            setKeyInput("");
                            await refreshProviders();
                            await api.settings.getProvider().then(setProvider).catch(() => {});
                            notifyProviders();
                            ok(`密钥已加密保存（${r.storageMode === "os" ? "系统密钥库" : "降级 AES"}），跨重启自动沿用`);
                          })
                          .catch(bad);
                      }}
                    />
                  </div>
                </Field>
                <Field
                  l="自定义请求头"
                  h={`每行一条「Key: Value」；留空即可——OpenCode Go 会自动带上 x-opencode-session / User-Agent。支持变量 ${HEADER_TEMPLATE_VARIABLES.map((name) => `{{${name}}}`).join(" ")}（sessionId=会话、requestId/timestamp=每请求）`}
                >
                  <Area v={pHeaders} rows={4} wide on={setPHeaders} />
                </Field>
                <Field l="RPM 兜底" h="每分钟请求上限（留空 = 不主动限制）">
                  <In v={pRpm} ph="留空 = 不限制" on={setPRpm} />
                </Field>
                <div style={S.modelSection}>
                  <div style={S.modelSectionHead}>
                    模型调试（勾选可用 · 上下文/输出/视觉/推理等级 · 保存后聊天界面可选）
                  </div>
                  <div style={S.modelAddRow}>
                    <In v={pModelDraft} ph="手动添加模型 ID（逗号或换行分隔）" on={setPModelDraft} />
                    <Btn label="添加" small onClick={addModelsFromDraft} />
                  </div>
                  {pModels.length === 0 ? (
                    <div style={S.dashed}>未获取模型列表 — 填好接口地址与密钥后点「获取模型列表」，或手动添加模型 ID。</div>
                  ) : (
                    <div style={S.tableWrap}>
                      <table style={S.table}>
                        <thead>
                          <tr>
                            <th style={S.th}>启用</th>
                            <th style={S.th}>模型 ID</th>
                            <th style={S.thNarrow}>上下文K</th>
                            <th style={S.thNarrow}>输出K</th>
                            <th style={S.thTiny}>图片</th>
                            <th style={S.thTiny}>推理</th>
                            <th style={S.th}>推理等级</th>
                            <th style={S.thTiny}>默认</th>
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
                                <button type="button" className="icon-btn" style={{ width: 22, height: 22 }} title="删除模型" onClick={() => removeModel(idx)}>
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
                  <Btn label="测试连接" onClick={() => void api.settings.testProvider({ provider: pForm.provider, baseUrl: pForm.baseUrl, model: pForm.model || "default", headers: parseHeaderLines(pHeaders) }).then(setTestRes).catch(bad)} />
                  <Btn label="保存并启用" primary onClick={() => void commit()} />
                  <Btn label="取消" onClick={() => setEditingProviderId(null)} />
                  {testRes ? <span style={testRes.ok ? S.okText : S.errText}>{testRes.ok ? "✓ " : "✕ "}{testRes.message}</span> : null}
                </div>
              </div>
            )}
            <div style={S.note}>
              安全：密钥经 Electron safeStorage 加密落盘（渲染层只见掩码）；端点协议与模型参数随供应商保存；
              当前默认模型可在输入区「模型」chip 切换，推理等级在模型声明支持时出现在输入区「推理」chip。
            </div>
          </div>
        );
      }


      case "rules":
        return rules ? (<div>
          <Head t="规则（AGENTS.md）" h="逐条管理：全局规则存数据目录 rules/；项目规则=工作区 AGENTS.md。保存后下一轮对话生效。" />
          {drafts.length === 0 ? <div style={S.dashed}>还没有规则。用下方按钮逐条新建，例如「代码风格」「构建命令」「禁止事项」。</div> : null}
          {drafts.map((d) => <RuleCard key={d.key} d={d} max={rules.maxFileBytes}
            on={(p) => setDrafts((v) => v.map((x) => x.key === d.key ? { ...x, ...p } : x))} onDel={() => removeDraft(d)} />)}
          <div style={S.btns}>
            <Btn label="新建全局规则" onClick={() => addDraft("global")} />
            <Btn label="新建项目规则" onClick={() => addDraft("workspace")} />
          </div>
          <div style={S.box}>
            <div style={S.boxTitle}>合并结果</div>
            <div style={S.meta}>生效 {rules.merged.included.length} 份 · {rules.merged.totalBytes} / {rules.maxTotalBytes} 字节{deleted.length ? ` · 待删除 ${deleted.length}` : ""}</div>
            {rules.merged.skipped.length ? <ul style={S.list}>{rules.merged.skipped.map((x) => <li key={x.path}>{x.path}：{x.reason}</li>)}</ul> : null}
            {rules.merged.text ? <pre style={S.pre}>{rules.merged.text.slice(0, 900)}</pre> : <div style={S.note}>当前没有生效内容。</div>}
          </div>
          <SaveBtn onClick={saveRules} label="保存全部规则" />
        </div>) : <div style={S.muted}>读取失败</div>;

      case "memory":
        return mem ? (<div>
          <Head t="记忆" h="会话自动汇总：抽取 → 去重/合并/建链 → 容量软归档；相关对话自动召回。" />
          <div style={S.stats}>
            <Stat l="条目" v={mem.stats.active} /><Stat l="归档" v={mem.stats.archived} /><Stat l="关联" v={mem.stats.links} />
          </div>
          <div style={S.note}>记忆库：<code style={S.code}>{mem.filePath}</code></div>
          <Field l="新增记忆"><div style={S.col}>
            <Area v={mForm.content} rows={2} on={(x) => setMForm({ ...mForm, content: x })} />
            <div style={S.rowEnd}>
              <In v={mForm.category} on={(x) => setMForm({ ...mForm, category: x })} />
              <Btn label="添加" primary onClick={() => void addMemory()} />
            </div>
          </div></Field>
          {mem.facts.length === 0 ? <div style={S.dashed}>还没有记忆。对话后自动积累，也可手动添加。</div> : mem.facts.map((f) => (
            <div key={f.id} className="panel-card" style={S.card}>
              <div style={S.rowBetween}>
                <span style={S.meta}><span style={BADGE.neutral}>{f.category}</span><span style={S.tag}>重要度 {f.importance}</span>{f.tags.map((t) => <span key={t} style={S.tag}>#{t}</span>)}</span>
                <span style={S.icons}>
                  {mEdit?.id === f.id ? <>
                    <Btn label="保存" small onClick={() => void saveMemEdit()} /><Btn label="取消" small onClick={() => setMEdit(null)} />
                  </> : <Btn label="编辑" small onClick={() => setMEdit({ id: f.id, content: f.content })} />}
                  <Btn label="删除" small onClick={() => void api.memory.delete({ id: f.id }).then(async () => setMem(await api.memory.list()))} />
                </span>
              </div>
              {mEdit?.id === f.id ? <Area v={mEdit.content} rows={2} on={(x) => setMEdit({ id: f.id, content: x })} /> : <div style={S.memText}>{f.content}</div>}
            </div>
          ))}
          <div style={S.btns}><Btn label="清空全部记忆" onClick={() => void api.memory.clear().then(async () => setMem(await api.memory.list()))} /></div>
        </div>) : <div style={S.muted}>读取失败</div>;

      case "extensions":
        return (
          <div>
            <Head t="扩展" h="本地插件：把扩展目录放入下方路径，每个扩展含 loopsoar.extension.json 清单" />
            <div style={S.note}>扩展目录：<code style={S.code}>{extensionsDir || "—"}</code></div>
            <div style={S.btns}>
              <Btn
                label="打开扩展目录"
                onClick={() =>
                  void api.extensions
                    .openDir()
                    .then((r) => {
                      if (!r.ok) bad(`打开目录失败（${r.dir}）：系统未返回成功，请检查路径权限`);
                    })
                    .catch(bad)
                }
              />
              <Btn
                label="重新扫描"
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
                跳过 {extensionSkips.length} 个损坏扩展：
                {extensionSkips.map((x) => (
                  <div key={x.dir} style={S.errText}>{x.dir}：{x.reason}</div>
                ))}
              </div>
            ) : null}
            {extensions.length === 0 ? (
              <div style={S.dashed}>暂无扩展。扩展目录为空，或尚未放入合法的 loopsoar.extension.json。</div>
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
                            label="停止"
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
                            label="启动"
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
                        label="卸载"
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
                      <div style={S.providerRow}><span style={S.providerKey}>权限</span><span style={S.providerVal}>{ext.manifest.permissions.join(" · ")}</span></div>
                    </div>
                  ) : null}
                  <div style={S.providerRow}>
                    <span style={S.providerKey}>运行</span>
                    <span style={S.providerVal}>
                      {(() => {
                        const status = extensionRuntime[ext.manifest.id] ?? { state: "idle", tools: [] };
                        const label =
                          status.state === "ready"
                            ? `已加载 · ${status.tools.length} 个工具`
                            : status.state === "starting"
                              ? "启动中…"
                              : status.state === "error"
                                ? `加载失败：${status.error ?? "未知"}`
                                : ext.manifest.main
                                  ? "未启动（点「启动」或打开开关）"
                                  : "纯声明式扩展（无入口）";
                        return <span style={status.state === "error" ? S.errText : undefined}>{label}</span>;
                      })()}
                    </span>
                  </div>
                  {extensionRuntime[ext.manifest.id]?.tools.length ? (
                    <div style={S.providerRow}>
                      <span style={S.providerKey}>工具</span>
                      <span style={S.providerVal}>{extensionRuntime[ext.manifest.id].tools.join(" · ")}</span>
                    </div>
                  ) : null}
                  <div style={S.providerRow}><span style={S.providerKey}>目录</span><span style={S.providerVal}>{ext.dir}</span></div>
                </div>
              ))
            )}
            <div style={S.note}>
              隔离：每个扩展运行在独立子进程（启动超时 8s、调用超时 20s、崩溃自动注销工具），
              工具名 ext__&lt;扩展&gt;__&lt;工具&gt; 注册进全局工具表；执行仍走沙箱与权限确认。
            </div>
          </div>
        );

      case "skills":
        return (
          <div>
            <Head t="技能（Skills）" h="独立子系统：SKILL.md 纯文本（frontmatter + 正文），只做提示词注入，不提供任何工具" />
            <div style={S.note}>技能目录：<code style={S.code}>{skillsDir || "—"}</code></div>
            <div style={S.btns}>
              <Btn
                label="打开技能目录"
                onClick={() =>
                  void api.skills
                    .openDir()
                    .then((r) => {
                      if (!r.ok) bad(`打开目录失败（${r.dir}）：系统未返回成功，请检查路径权限`);
                    })
                    .catch(bad)
                }
              />
              <Btn label="重新扫描" onClick={() => void api.skills.reload().then((r) => { setSkills(r.skills); setSkillSkips(r.skipped); })} />
            </div>
            {skillSkips.length > 0 ? (
              <div style={S.note}>
                跳过 {skillSkips.length} 个技能：
                {skillSkips.map((x) => <div key={x.dir} style={S.errText}>{x.dir}：{x.reason}</div>)}
              </div>
            ) : null}
            {skills.length === 0 ? (
              <div style={S.dashed}>暂无技能。在技能目录创建 &lt;id&gt;/SKILL.md（--- 包裹 frontmatter）即可被发现。</div>
            ) : (
              skills.map((sk) => (
                <div key={sk.id} className="panel-card" style={S.card}>
                  <div style={S.rowBetween}>
                    <span style={S.meta}>
                      <span style={S.metaTitle}>{sk.frontmatter.name}</span>
                      {sk.frontmatter.version ? <span style={BADGE.neutral}>v{sk.frontmatter.version}</span> : null}
                      {sk.warnings && sk.warnings.length > 0 ? <span style={BADGE.warn} title={sk.warnings.join("；")}>容错</span> : null}
                      {(sk.frontmatter.tags ?? []).map((tag) => <span key={tag} style={S.tag}>#{tag}</span>)}
                    </span>
                    <span style={S.icons}>
                      <Toggle v={sk.enabled} on={(next) => void api.skills.setEnabled({ id: sk.id, enabled: next }).then(() => void api.skills.list().then((r) => setSkills(r.skills)))} />
                    </span>
                  </div>
                  <div style={S.providerVal}>{sk.frontmatter.description}</div>
                  <div style={S.providerRows}>
                    {sk.frontmatter.whenToUse ? <div style={S.providerRow}><span style={S.providerKey}>何时用</span><span style={S.providerVal}>{sk.frontmatter.whenToUse}</span></div> : null}
                    <div style={S.providerRow}><span style={S.providerKey}>正文</span><span style={S.providerVal}>{sk.bytes} 字节</span></div>
                  </div>
                </div>
              ))
            )}
            <div style={S.note}>隔离：技能只影响提示词，不注册工具、不读写文件、不启动进程；与扩展/MCP 互不影响。</div>
          </div>
        );

      case "mcp":
        return (
          <div>
            <Head t="MCP 服务" h="独立子系统：支持 stdio（本地进程）与 Streamable HTTP（远程端点）两种传输；工具以 mcp__&lt;server&gt;__&lt;tool&gt; 注册进工具表" />
            <div style={S.note}>配置文件：<code style={S.code}>{mcpConfigPath || "—"}</code></div>
            <div className="panel-card" style={S.card}>
              <div style={S.formHead}>添加 MCP 服务器</div>
              <Field l="名称"><In v={mcpForm.name} ph="filesystem / github / remote" on={(x) => setMcpForm({ ...mcpForm, name: x })} /></Field>
              <Field l="传输方式" h="stdio=本地进程；http=远程 Streamable HTTP">
                <Seg v={mcpForm.transport} opts={[["stdio", "stdio（本地）"], ["http", "HTTP（远程）"]]} on={(x) => setMcpForm({ ...mcpForm, transport: x as "stdio" | "http" })} />
              </Field>
              {mcpForm.transport === "http" ? (
                <Field l="端点 URL" h="如 https://example.com/mcp（POST JSON-RPC；支持 SSE 响应）">
                  <In v={mcpForm.url} ph="https://example.com/mcp" on={(x) => setMcpForm({ ...mcpForm, url: x })} />
                </Field>
              ) : (
                <>
                  <Field l="启动命令"><In v={mcpForm.command} ph="npx / node / uvx" on={(x) => setMcpForm({ ...mcpForm, command: x })} /></Field>
                  <Field l="参数" h="空格分隔"><In v={mcpForm.args} ph="-y @modelcontextprotocol/server-filesystem D:/work" on={(x) => setMcpForm({ ...mcpForm, args: x })} /></Field>
                </>
              )}
              <div style={S.btns}>
                <Btn
                  label="添加"
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
                        ok("MCP 服务器已添加（点击连接）");
                      })
                      .catch(bad)
                  }
                />
              </div>
            </div>
            {mcpServers.length === 0 ? (
              <div style={S.dashed}>还没有 MCP 服务器。添加后点击「连接」会做 initialize 握手并注册工具。</div>
            ) : (
              mcpServers.map((srv) => (
                <div key={srv.id} className="panel-card" style={S.card}>
                  <div style={S.rowBetween}>
                    <span style={S.meta}>
                      <span style={S.metaTitle}>{srv.name}</span>
                      <span style={srv.state === "ready" ? BADGE.ok : srv.state === "error" ? BADGE.warn : BADGE.neutral}>
                        {srv.state === "ready" ? "已连接" : srv.state === "connecting" ? "连接中" : srv.state === "error" ? "错误" : "未连接"}
                      </span>
                      <span style={S.tag}>{srv.tools.length} 个工具</span>
                      {srv.capabilities.length > 0 ? <span style={S.tag}>能力 {srv.capabilities.join("/")}</span> : null}
                    </span>
                    <span style={S.icons}>
                      {srv.state === "ready" ? (
                        <Btn label="断开" small onClick={() => void api.mcp.disconnect({ id: srv.id }).then((r) => setMcpServers(r.servers))} />
                      ) : (
                        <Btn label="连接" small onClick={() => void api.mcp.connect({ id: srv.id }).then((r) => setMcpServers(r.servers)).catch(bad)} />
                      )}
                      <Btn label="删除" small onClick={() => void api.mcp.remove({ id: srv.id }).then((r) => setMcpServers(r.servers))} />
                    </span>
                  </div>
                  <div style={S.providerRows}>
                    <div style={S.providerRow}>
                      <span style={S.providerKey}>{srv.transport === "http" ? "端点" : "命令"}</span>
                      <span style={S.providerVal}>{srv.transport === "http" ? (srv.url ?? "—") : [srv.command, ...srv.args].filter(Boolean).join(" ")}</span>
                    </div>
                    {srv.error ? <div style={S.providerRow}><span style={S.providerKey}>错误</span><span style={S.errText}>{srv.error}</span></div> : null}
                    {srv.tools.length > 0 ? <div style={S.providerRow}><span style={S.providerKey}>工具</span><span style={S.providerVal}>{srv.tools.slice(0, 6).join(" · ")}{srv.tools.length > 6 ? " …" : ""}</span></div> : null}
                    {srv.stderr.length > 0 ? (
                      <div style={S.providerRow}><span style={S.providerKey}>诊断</span><span style={S.providerVal} title={srv.stderr.slice(-5).join("\\n")}>{srv.stderr.slice(-3).join(" | ").slice(0, 200)}</span></div>
                    ) : null}
                  </div>
                </div>
              ))
            )}
            <div style={S.note}>隔离：MCP 独立配置（mcp.json）与独立通道；工具调用仍走沙箱与权限确认（声明 network）。</div>
          </div>
        );

      case "storage":
        return prefs && locations ? (<div>
          <Head t="存储 / 文件位置" h="数据/配置目录只读；工作区根、记忆库、下载目录可改，保存即时生效。" />
          <Field l="数据目录"><code style={S.code}>{locations.dataDir}</code></Field>
          <Field l="配置目录"><code style={S.code}>{locations.configDir}</code></Field>
          <Field l="规则目录"><code style={S.code}>{locations.rulesDir}</code></Field>
          <Field l="会话文件"><code style={S.code}>{locations.sessionsFile}</code></Field>
          <Field l="默认工作区根" h="仅首次初始化使用；日常挂载/切换项目请用右侧 Agent 面板的「工作区」入口"><div style={S.rowEnd}><In v={prefs.workspaceRoot ?? ""} ph={locations.workspaceRoot} on={(x) => setPrefs({ ...prefs, workspaceRoot: x })} /><Btn label="浏览…" small onClick={() => void api.dialog.pickPath({ kind: "directory", title: "选择工作区根" }).then((r) => { if (r.path) setPrefs({ ...prefs, workspaceRoot: r.path }); })} /></div></Field>
          <Field l="记忆库路径" h="留空=数据目录 memory/memory.json"><div style={S.rowEnd}><In v={prefs.memoryStorePath ?? ""} ph={locations.defaultMemoryFile} on={(x) => setPrefs({ ...prefs, memoryStorePath: x })} /><Btn label="浏览…" small onClick={() => void api.dialog.pickPath({ kind: "file", title: "选择记忆库文件" }).then((r) => { if (r.path) setPrefs({ ...prefs, memoryStorePath: r.path }); })} /></div></Field>
          <Field l="下载目录" h="留空=系统下载文件夹"><div style={S.rowEnd}><In v={prefs.downloadDir ?? ""} ph="留空使用系统默认" on={(x) => setPrefs({ ...prefs, downloadDir: x })} /><Btn label="浏览…" small onClick={() => void api.dialog.pickPath({ kind: "directory", title: "选择下载目录" }).then((r) => { if (r.path) setPrefs({ ...prefs, downloadDir: r.path }); })} /></div></Field>
          <SaveBtn onClick={savePrefs} label="保存文件位置" />
        </div>) : <div style={S.muted}>读取失败</div>;

      case "advanced":
        return diag ? (<div>
          <Head t="高级 / 诊断" h="路径与运行时版本" />
          <div style={S.kv}>{Object.entries(diag.paths).map(([k, v]) => <Kv key={k} k={k} v={v} />)}{Object.entries(diag.versions).map(([k, v]) => <Kv key={k} k={k} v={v} />)}</div>
          {diag.extra && Object.keys(diag.extra).length ? <div style={S.box}><div style={S.boxTitle}>运行时统计</div><div style={S.kv}>{Object.entries(diag.extra).map(([k, v]) => <Kv key={k} k={k} v={String(v)} />)}</div></div> : null}
        </div>) : <div style={S.muted}>读取失败</div>;

      case "about":
        return about ? (<div>
          <Head t="关于" h="Loopsoar —— 浏览器优先的本地 AI Agent" />
          <div style={S.about}><img src="./logo.png" alt="Loopsoar" width={56} height={56} style={{ borderRadius: 10 }} />
            <div><div style={{ fontSize: 18, fontWeight: 800 }}>{about.name}</div><div style={S.tag}>版本 {about.version}</div></div></div>
          <div style={S.kv}>
            <Kv k="应用 ID" v={about.appId} /><Kv k="协议" v={about.protocol} /><Kv k="Electron" v={about.electron} />
            <Kv k="Node" v={about.node} /><Kv k="品牌资产" v={about.brandAssetSource} />
          </div>
          <div style={S.note}>规则遵循 AGENTS.md 约定；记忆设计参考 MemGPT / Mem0 / Anthropic 记忆工具。</div>
        </div>) : <div style={S.muted}>读取失败</div>;
    }
  }, [section, loading, api, prefs, locations, perms, provider, pForm, testRes, rules, drafts, deleted, mem, mForm, mEdit, diag, about, savePrefs, savePerms, saveProvider, saveRules, addMemory, saveMemEdit, bad, providerItems, activeProviderId, editingProviderId, extensions, extensionsDir, extensionSkips, ok, skills, skillsDir, skillSkips, mcpServers, mcpConfigPath, mcpForm, keyInput, pModels, pModelsError, pFetching, pFormat, pRpm, pModelDraft, rail, loopInfo, loopBusy, latestLoopFallback, chooseLoop]);

  return (
    <div className="settings-overlay" style={S.overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="settings-panel" style={S.panel}>
        <div style={S.header}><span style={S.title}>设置</span><button type="button" className="icon-btn" onClick={onClose} title="关闭（Esc）"><Icon name="close" size={14} /></button></div>
        <div style={S.bodyRow}>
          <nav style={S.nav}>
            {SECTIONS.map((s, index) => (
              <React.Fragment key={s.id}>
                {index === 0 || s.group !== SECTIONS[index - 1].group ? (
                  <div style={S.navGroup}>{s.group}</div>
                ) : null}
              <button key={s.id} type="button" className={`settings-nav-item${section === s.id ? " is-active" : ""}`}
                style={{ ...S.navItem, ...(section === s.id ? S.navItemActive : {}) }} onClick={() => setSection(s.id)}>
                <Icon name={s.icon} size={15} style={{ marginTop: 2, flex: "none" }} />
                <span style={S.navText}><span style={S.navLabel}>{s.label}</span><span style={S.navHint}>{s.hint}</span></span>
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
/** 请求头文本 ⇄ 对象：每行一条 `Key: Value`；空行忽略，非法行抛可读错误。 */
function parseHeaderLines(text: string): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const [index, line] of lines.entries()) {
    const colon = line.indexOf(":");
    if (colon <= 0) throw new Error(`请求头第 ${index + 1} 行格式应为「Key: Value」`);
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!key || /\s/.test(key)) throw new Error(`请求头第 ${index + 1} 行 Key 不能为空或包含空格`);
    headers[key] = value;
  }
  if (Object.keys(headers).length > 30) throw new Error("请求头最多 30 条");
  const unknown = unknownHeaderTemplateVariables(headers);
  if (unknown.length > 0) {
    throw new Error(`未知请求头变量：${unknown.map((name) => `{{${name}}}`).join("、")}；可用变量：${HEADER_TEMPLATE_VARIABLES.join(" / ")}`);
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function formatHeaderLines(headers?: Record<string, string>): string {
  if (!headers) return "";
  return Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join("\n");
}

/** 时间戳展示（回退记录等；本地时区短格式，非法值显示「时间未知」）。 */
function formatWhen(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return "时间未知";
  return new Date(at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
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
  const bytes = new TextEncoder().encode(d.content).length;
  return (<div className="panel-card" style={S.card}>
    <div style={S.rowBetween}>
      <span style={S.meta}><span style={BADGE.neutral}>{d.scope === "workspace" ? "项目规则" : "全局规则"}</span><span style={bytes > max ? S.errText : S.tag}>{bytes} / {max} 字节</span></span>
      <span style={S.icons}><Toggle v={d.enabled} on={(next) => on({ enabled: next })} /><Btn label="删除" small onClick={onDel} /></span>
    </div>
    <input style={S.ruleName} value={d.name} disabled={d.scope === "workspace"} onChange={(e) => on({ name: e.target.value })} />
    <textarea style={S.rulesArea} rows={4} spellCheck={false} value={d.content} placeholder={"# 规则标题\n\n- 一条约定"} onChange={(e) => on({ content: e.target.value })} />
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
