import React, { useCallback, useEffect, useMemo, useState } from "react";
import { BRAND, BADGE } from "./theme.js";
import { Icon } from "./Icon.js";
import type {
  AboutInfo, DiagnosticsInfo, InstalledExtension, LocationsInfo, LoopsoarAPI, McpServerInfo, MemoryListResult,
  PermissionsState, Preferences, ProviderItem, ProviderStatus, RulesSnapshot, SkillRecord, TestProviderResult,
} from "./types.js";

/**
 * 设置面板：通用 / 权限 / 供应商 / 规则（逐条增删）/ 记忆 / 存储（文件位置）/ 高级 / 关于。
 * 全部数据经 preload 白名单；规则与记忆在保存后即时生效（主进程惰性读取）。
 */

type SectionId = "general" | "permissions" | "providers" | "rules" | "skills" | "memory" | "extensions" | "mcp" | "storage" | "advanced" | "about";

const SECTIONS: { id: SectionId; label: string; icon: string; hint: string; group: string }[] = [
  { id: "general", group: "基础", label: "通用", icon: "settings", hint: "外观、搜索、启动" },
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
  const [providerItems, setProviderItems] = useState<ProviderItem[]>([]);
  const [activeProviderId, setActiveProviderId] = useState<string | null>(null);
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [extensions, setExtensions] = useState<InstalledExtension[]>([]);
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [skillsDir, setSkillsDir] = useState("");
  const [skillSkips, setSkillSkips] = useState<{ dir: string; reason: string }[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([]);
  const [mcpConfigPath, setMcpConfigPath] = useState("");
  const [mcpForm, setMcpForm] = useState({ name: "", command: "", args: "" });
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

  const ok = useCallback((text: string) => setNotice({ kind: "ok", text }), []);
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
        }
        if (ext.status === "fulfilled") {
          setExtensions(ext.value.extensions);
          setExtensionsDir(ext.value.dir);
          setExtensionSkips(ext.value.skipped);
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
      case "general":
        return prefs ? (<div>
          <Head t="通用" h="外观、搜索与启动行为（config/preferences.json）" />
          <Field l="语言"><Seg v={prefs.language} opts={[["zh-CN", "简体中文"], ["en-US", "English"]]} on={(x) => setPrefs({ ...prefs, language: x as Preferences["language"] })} /></Field>
          <Field l="动效强度" h="关闭后全局停用动画与过渡"><Seg v={prefs.animations} opts={[["full", "完整"], ["reduced", "弱化"], ["off", "关闭"]]} on={(x) => setPrefs({ ...prefs, animations: x as Preferences["animations"] })} /></Field>
          <Field l="默认搜索引擎"><Seg v={prefs.searchEngine} opts={[["bing", "Bing"], ["google", "Google"], ["duckduckgo", "DuckDuckGo"]]} on={(x) => setPrefs({ ...prefs, searchEngine: x as Preferences["searchEngine"] })} /></Field>
          <Field l="启动时恢复上次会话"><Toggle v={prefs.restoreSession} on={(x) => setPrefs({ ...prefs, restoreSession: x })} /></Field>
          <Field l="自动记忆汇总" h="每轮对话结束自动抽取记忆"><Toggle v={prefs.memoryAutoCapture} on={(x) => setPrefs({ ...prefs, memoryAutoCapture: x })} /></Field>
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
        const startEdit = (item?: ProviderItem): void => {
          if (item) {
            setEditingProviderId(item.id);
            setPForm({ provider: item.provider, baseUrl: item.baseUrl, model: item.model });
          } else {
            setEditingProviderId("new");
            setPForm({ provider: "", baseUrl: "", model: "" });
          }
          setTestRes(null);
        };
        const commit = async (): Promise<void> => {
          try {
            const r = await api.settings.upsertProvider(
              editingProviderId && editingProviderId !== "new" ? { id: editingProviderId, ...pForm } : pForm,
            );
            await api.settings.setActiveProvider({ id: r.item.id });
            await refreshProviders();
            setEditingProviderId(null);
            await api.settings.getProvider().then(setProvider).catch(() => {});
            ok("供应商已保存并设为活跃");
          } catch (e) {
            bad(e);
          }
        };
        return (
          <div>
            <Head t="供应商" h="可添加多条配置，选一条设为活跃；API Key 只读环境变量（不落盘不回传）" />
            {providerItems.map((item) => (
              <div key={item.id} style={S.card}>
                <div style={S.rowBetween}>
                  <span style={S.meta}>
                    <button
                      type="button"
                      className="icon-btn"
                      title={item.id === activeProviderId ? "当前活跃" : "设为活跃"}
                      onClick={() => void api.settings.setActiveProvider({ id: item.id }).then(async () => { await refreshProviders(); await api.settings.getProvider().then(setProvider).catch(() => {}); })}
                      style={{ width: 20, height: 20 }}
                    >
                      <Icon name={item.id === activeProviderId ? "check" : "cloud-upload"} size={13} />
                    </button>
                    <span style={S.metaTitle}>{item.provider}</span>
                    <span style={item.id === activeProviderId ? BADGE.ok : BADGE.neutral}>{item.id === activeProviderId ? "活跃" : "备用"}</span>
                  </span>
                  <span style={S.icons}>
                    <Btn label="测试" small onClick={() => void api.settings.testProvider({ provider: item.provider, baseUrl: item.baseUrl, model: item.model }).then(setTestRes).catch(bad)} />
                    <Btn label="编辑" small onClick={() => startEdit(item)} />
                    <Btn label="删除" small onClick={() => void api.settings.removeProvider({ id: item.id }).then(async () => { await refreshProviders(); await api.settings.getProvider().then(setProvider).catch(() => {}); }).catch(bad)} />
                  </span>
                </div>
                <div style={S.providerRows}>
                  <div style={S.providerRow}><span style={S.providerKey}>接口</span><span style={S.providerVal}>{item.baseUrl}</span></div>
                  <div style={S.providerRow}><span style={S.providerKey}>模型</span><span style={S.providerVal}>{item.model}</span></div>
                </div>
              </div>
            ))}
            {testRes ? <div style={testRes.ok ? S.okText : S.errText}>{testRes.ok ? "✓ " : "✕ "}{testRes.message}</div> : null}
            {editingProviderId === null ? (
              <div style={S.btns}><Btn label="添加供应商" primary onClick={() => startEdit()} /></div>
            ) : (
              <div style={S.card}>
                <div style={S.formHead}>{editingProviderId === "new" ? "添加供应商" : "编辑供应商"}</div>
                <div style={S.presetRow}>
                  <span style={S.tag}>快速填充</span>
                  {[
                    { name: "DeepSeek", provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
                    { name: "OpenAI", provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
                    { name: "OpenRouter", provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", model: "deepseek/deepseek-chat" },
                    { name: "本地", provider: "local", baseUrl: "http://127.0.0.1:8080/v1", model: "local-model" },
                  ].map((preset) => (
                    <Btn key={preset.name} label={preset.name} small onClick={() => setPForm({ provider: preset.provider, baseUrl: preset.baseUrl, model: preset.model })} />
                  ))}
                </div>
                <Field l="服务商"><In v={pForm.provider} ph="deepseek / openai / local" on={(x) => setPForm({ ...pForm, provider: x })} /></Field>
                <Field l="接口地址"><In v={pForm.baseUrl} ph="https://api.deepseek.com/v1" on={(x) => setPForm({ ...pForm, baseUrl: x })} /></Field>
                <Field l="模型"><In v={pForm.model} ph="deepseek-chat" on={(x) => setPForm({ ...pForm, model: x })} /></Field>
                <div style={S.btns}>
                  <Btn label="测试连接" onClick={() => void api.settings.testProvider(pForm).then(setTestRes).catch(bad)} />
                  <Btn label="保存并启用" primary onClick={() => void commit()} />
                  <Btn label="取消" onClick={() => setEditingProviderId(null)} />
                </div>
              </div>
            )}
            <div style={S.note}>密钥走环境变量（重启生效）：<code style={S.code}>LOOPSOAR_API_KEY=&lt;密钥&gt;</code></div>
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
            <div key={f.id} style={S.card}>
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
              <Btn label="打开扩展目录" onClick={() => void api.extensions.openDir()} />
              <Btn label="重新扫描" onClick={() => void api.extensions.list().then((r) => { setExtensions(r.extensions); setExtensionsDir(r.dir); setExtensionSkips(r.skipped); })} />
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
                <div key={ext.manifest.id} style={S.card}>
                  <div style={S.rowBetween}>
                    <span style={S.meta}>
                      <span style={S.metaTitle}>{ext.manifest.name}</span>
                      <span style={BADGE.neutral}>v{ext.manifest.version}</span>
                      {ext.manifest.author ? <span style={S.tag}>{ext.manifest.author}</span> : null}
                    </span>
                    <span style={S.icons}>
                      <label style={S.tag}>
                        <Toggle v={ext.enabled} on={(next) => void api.extensions.setEnabled({ id: ext.manifest.id, enabled: next }).then(() => void api.extensions.list().then((r) => setExtensions(r.extensions)))} />
                      </label>
                      <Btn label="卸载" small onClick={() => void api.extensions.remove({ id: ext.manifest.id }).then(() => void api.extensions.list().then((r) => setExtensions(r.extensions)))} />
                    </span>
                  </div>
                  {ext.manifest.description ? <div style={S.providerVal}>{ext.manifest.description}</div> : null}
                  {ext.manifest.permissions && ext.manifest.permissions.length > 0 ? (
                    <div style={S.providerRows}>
                      <div style={S.providerRow}><span style={S.providerKey}>权限</span><span style={S.providerVal}>{ext.manifest.permissions.join(" · ")}</span></div>
                    </div>
                  ) : null}
                  <div style={S.providerRow}><span style={S.providerKey}>目录</span><span style={S.providerVal}>{ext.dir}</span></div>
                </div>
              ))
            )}
            <div style={S.note}>安全：扩展只提供清单与入口声明；工具执行仍走沙箱与权限确认，不绕过四要素校验。</div>
          </div>
        );

      case "skills":
        return (
          <div>
            <Head t="技能（Skills）" h="独立子系统：SKILL.md 纯文本（frontmatter + 正文），只做提示词注入，不提供任何工具" />
            <div style={S.note}>技能目录：<code style={S.code}>{skillsDir || "—"}</code></div>
            <div style={S.btns}>
              <Btn label="打开技能目录" onClick={() => void api.skills.openDir()} />
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
                <div key={sk.id} style={S.card}>
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
            <Head t="MCP 服务" h="独立子系统：通过 stdio JSON-RPC 连接外部工具服务；工具以 mcp__&lt;server&gt;__&lt;tool&gt; 注册进工具表" />
            <div style={S.note}>配置文件：<code style={S.code}>{mcpConfigPath || "—"}</code></div>
            <div style={S.card}>
              <div style={S.formHead}>添加 MCP 服务器</div>
              <Field l="名称"><In v={mcpForm.name} ph="filesystem / github" on={(x) => setMcpForm({ ...mcpForm, name: x })} /></Field>
              <Field l="启动命令"><In v={mcpForm.command} ph="npx / node / uvx" on={(x) => setMcpForm({ ...mcpForm, command: x })} /></Field>
              <Field l="参数" h="空格分隔"><In v={mcpForm.args} ph="-y @modelcontextprotocol/server-filesystem D:/work" on={(x) => setMcpForm({ ...mcpForm, args: x })} /></Field>
              <div style={S.btns}>
                <Btn
                  label="添加"
                  primary
                  onClick={() =>
                    void api.mcp
                      .add({
                        name: mcpForm.name.trim() || "mcp",
                        command: mcpForm.command.trim() || "npx",
                        args: mcpForm.args.trim() ? (mcpForm.args.match(/"[^"]*"|\S+/g) ?? []).map((x) => x.replace(/^"|"$/g, "")) : [],
                      })
                      .then((r) => {
                        setMcpServers(r.servers);
                        setMcpForm({ name: "", command: "", args: "" });
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
                <div key={srv.id} style={S.card}>
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
                    <div style={S.providerRow}><span style={S.providerKey}>命令</span><span style={S.providerVal}>{[srv.command, ...srv.args].join(" ")}</span></div>
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
          <Field l="工作区根" h="规则查找与沙箱根"><div style={S.rowEnd}><In v={prefs.workspaceRoot ?? ""} ph={locations.workspaceRoot} on={(x) => setPrefs({ ...prefs, workspaceRoot: x })} /><Btn label="浏览…" small onClick={() => void api.dialog.pickPath({ kind: "directory", title: "选择工作区根" }).then((r) => { if (r.path) setPrefs({ ...prefs, workspaceRoot: r.path }); })} /></div></Field>
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
  }, [section, loading, api, prefs, locations, perms, provider, pForm, testRes, rules, drafts, deleted, mem, mForm, mEdit, diag, about, savePrefs, savePerms, saveProvider, saveRules, addMemory, saveMemEdit, bad, providerItems, activeProviderId, editingProviderId, extensions, extensionsDir, extensionSkips, ok, skills, skillsDir, skillSkips, mcpServers, mcpConfigPath, mcpForm]);

  return (
    <div style={S.overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={S.panel}>
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
          <div style={S.content}>
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
function In({ v, ph, on }: { v: string; ph?: string; on: (x: string) => void }) {
  return <input style={S.input} value={v} placeholder={ph} onChange={(e) => on(e.target.value)} />;
}
function Area({ v, rows, on }: { v: string; rows: number; on: (x: string) => void }) {
  return <textarea style={S.area} rows={rows} value={v} onChange={(e) => on(e.target.value)} spellCheck={false} />;
}
function Btn({ label, onClick, primary, small }: { label: string; onClick: () => void; primary?: boolean; small?: boolean }) {
  return <button type="button" className={primary ? "btn-primary" : "btn-ghost"} style={{ ...(primary ? S.primary : S.ghost), ...(small ? S.small : {}) }} onClick={onClick}>{label}</button>;
}
function SaveBtn({ onClick, label }: { onClick: () => void; label: string }) {
  return <div style={{ display: "flex", justifyContent: "flex-end", paddingTop: 14 }}><Btn label={label} primary onClick={onClick} /></div>;
}
function RuleCard({ d, max, on, onDel }: { d: DraftRule; max: number; on: (p: Partial<DraftRule>) => void; onDel: () => void }) {
  const bytes = new TextEncoder().encode(d.content).length;
  return (<div style={S.card}>
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
