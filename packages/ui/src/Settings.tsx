import React, { useCallback, useEffect, useMemo, useState } from "react";
import { BRAND } from "./theme.js";
import { Icon } from "./Icon.js";
import type {
  AboutInfo,
  DiagnosticsInfo,
  LoopsoarAPI,
  PermissionsState,
  Preferences,
  ProviderStatus,
  RulesSnapshot,
  TestProviderResult,
} from "./types.js";

/**
 * 设置面板（S3）：左侧分组导航 + 右侧单分区内容，替代 slime 那种「16 个 tab 平铺」的混乱结构。
 * 分区：通用 / 权限 / 供应商 / 规则 / 高级 / 关于。
 * 全部数据经 preload 白名单（window.loopsoarAPI.settings.*），无新增通道之外的旁路。
 */

type SectionId = "general" | "permissions" | "providers" | "rules" | "advanced" | "about";

const SECTIONS: { id: SectionId; label: string; icon: string; hint: string }[] = [
  { id: "general", label: "通用", icon: "settings", hint: "外观、搜索、启动行为" },
  { id: "permissions", label: "权限", icon: "check", hint: "工具类别的默认决策" },
  { id: "providers", label: "供应商", icon: "cloud-upload", hint: "模型服务与连通性" },
  { id: "rules", label: "规则", icon: "file", hint: "AGENTS.md 规则文件" },
  { id: "advanced", label: "高级", icon: "terminal", hint: "路径与版本诊断" },
  { id: "about", label: "关于", icon: "bulb", hint: "版本与品牌信息" },
];

interface SettingsProps {
  api: LoopsoarAPI | null;
  onClose: () => void;
  onPreferencesSaved?: (prefs: Preferences) => void;
}

export default function Settings({ api, onClose, onPreferencesSaved }: SettingsProps): React.JSX.Element {
  const [section, setSection] = useState<SectionId>("general");
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [loading, setLoading] = useState(true);

  // 各分区状态
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [permState, setPermState] = useState<PermissionsState | null>(null);
  const [provider, setProvider] = useState<ProviderStatus | null>(null);
  const [providerForm, setProviderForm] = useState({ provider: "", baseUrl: "", model: "" });
  const [testResult, setTestResult] = useState<TestProviderResult | null>(null);
  const [rules, setRules] = useState<RulesSnapshot | null>(null);
  const [rulesForm, setRulesForm] = useState<{
    global: { enabled: boolean; content: string };
    workspace: { enabled: boolean; content: string };
  } | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsInfo | null>(null);
  const [about, setAbout] = useState<AboutInfo | null>(null);

  const fail = useCallback((err: unknown): void => {
    setNotice({ kind: "error", text: err instanceof Error ? err.message : String(err) });
  }, []);
  const succeed = useCallback((text: string): void => {
    setNotice({ kind: "ok", text });
  }, []);

  useEffect(() => {
    if (!api) {
      setLoading(false);
      return;
    }
    void (async () => {
      try {
        const [prefsRes, permRes, providerRes, rulesRes, diagRes, aboutRes] = await Promise.allSettled([
          api.settings.getPreferences(),
          api.settings.getPermissions(),
          api.settings.getProvider(),
          api.settings.getRules(),
          api.settings.diagnostics(),
          api.settings.about(),
        ]);
        if (prefsRes.status === "fulfilled") setPrefs(prefsRes.value.preferences);
        if (permRes.status === "fulfilled") setPermState(permRes.value);
        if (providerRes.status === "fulfilled") {
          setProvider(providerRes.value);
          setProviderForm({
            provider: providerRes.value.provider ?? "",
            baseUrl: providerRes.value.baseUrl ?? "",
            model: providerRes.value.model ?? "",
          });
        }
        if (rulesRes.status === "fulfilled") {
          setRules(rulesRes.value);
          setRulesForm({
            global: { enabled: rulesRes.value.global.enabled, content: rulesRes.value.global.content },
            workspace: {
              enabled: rulesRes.value.workspace.enabled,
              content: rulesRes.value.workspace.content,
            },
          });
        }
        if (diagRes.status === "fulfilled") setDiagnostics(diagRes.value);
        if (aboutRes.status === "fulfilled") setAbout(aboutRes.value);
      } catch (err) {
        fail(err);
      } finally {
        setLoading(false);
      }
    })();
  }, [api, fail]);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const savePrefs = useCallback(async (): Promise<void> => {
    if (!api || !prefs) return;
    try {
      const res = await api.settings.setPreferences(prefs);
      setPrefs(res.preferences);
      onPreferencesSaved?.(res.preferences);
      succeed("通用设置已保存");
    } catch (err) {
      fail(err);
    }
  }, [api, prefs, onPreferencesSaved, succeed, fail]);

  const savePermissions = useCallback(async (): Promise<void> => {
    if (!api || !permState) return;
    try {
      const res = await api.settings.setPermissions(permState.permissions);
      setPermState({ ...permState, permissions: res.permissions });
      succeed("权限策略已保存");
    } catch (err) {
      fail(err);
    }
  }, [api, permState, succeed, fail]);

  const saveProvider = useCallback(async (): Promise<void> => {
    if (!api) return;
    try {
      const res = await api.settings.setProvider(providerForm);
      setProvider((prev) =>
        prev
          ? { ...prev, configured: true, provider: providerForm.provider, baseUrl: providerForm.baseUrl, model: providerForm.model, usable: res.usable, reason: res.reason ?? null }
          : prev,
      );
      succeed("模型服务配置已保存");
    } catch (err) {
      fail(err);
    }
  }, [api, providerForm, succeed, fail]);

  const testProvider = useCallback(async (): Promise<void> => {
    if (!api) return;
    setTestResult(null);
    try {
      const res = await api.settings.testProvider(providerForm);
      setTestResult(res);
    } catch (err) {
      fail(err);
    }
  }, [api, providerForm, fail]);

  const saveRules = useCallback(async (): Promise<void> => {
    if (!api || !rulesForm) return;
    try {
      const res = await api.settings.setRules(rulesForm);
      setRules((prev) => (prev ? { ...prev, merged: res.merged } : prev));
      const refreshed = await api.settings.getRules();
      setRules(refreshed);
      succeed("规则文件已保存并生效");
    } catch (err) {
      fail(err);
    }
  }, [api, rulesForm, succeed, fail]);

  const sectionContent = useMemo((): React.JSX.Element => {
    if (loading) return <div style={styles.empty}>加载设置…</div>;
    if (!api) return <div style={styles.empty}>未在 Electron shell 中运行，设置不可用。</div>;

    switch (section) {
      case "general":
        return prefs ? (
          <div>
            <SectionTitle title="通用" hint="外观、搜索与启动行为（保存在 config/preferences.json）" />
            <Field label="语言">
              <Segmented
                value={prefs.language}
                options={[
                  { value: "zh-CN", label: "简体中文" },
                  { value: "en-US", label: "English" },
                ]}
                onChange={(v) => setPrefs({ ...prefs, language: v as Preferences["language"] })}
              />
            </Field>
            <Field label="动效强度" hint="无 CSS 动画依赖环境也可正常工作">
              <Segmented
                value={prefs.animations}
                options={[
                  { value: "full", label: "完整" },
                  { value: "reduced", label: "弱化" },
                  { value: "off", label: "关闭" },
                ]}
                onChange={(v) => setPrefs({ ...prefs, animations: v as Preferences["animations"] })}
              />
            </Field>
            <Field label="默认搜索引擎" hint="omnibox 输入非 URL 内容时使用">
              <Segmented
                value={prefs.searchEngine}
                options={[
                  { value: "bing", label: "Bing" },
                  { value: "google", label: "Google" },
                  { value: "duckduckgo", label: "DuckDuckGo" },
                ]}
                onChange={(v) => setPrefs({ ...prefs, searchEngine: v as Preferences["searchEngine"] })}
              />
            </Field>
            <Field label="启动时恢复上次会话" hint="会话持久化接入后生效">
              <Toggle
                checked={prefs.restoreSession}
                onChange={(v) => setPrefs({ ...prefs, restoreSession: v })}
              />
            </Field>
            <Field label="下载目录" hint="留空 = 系统下载文件夹">
              <input
                style={styles.input}
                value={prefs.downloadDir ?? ""}
                placeholder="例如 D:\\Downloads\\Loopsoar"
                onChange={(e) => setPrefs({ ...prefs, downloadDir: e.target.value })}
              />
            </Field>
            <SaveRow onSave={savePrefs} />
          </div>
        ) : (
          <div style={styles.empty}>读取失败</div>
        );

      case "permissions":
        return permState ? (
          <div>
            <SectionTitle
              title="权限"
              hint="按工具类别设定默认决策：允许直接执行 / 每次询问 / 直接拒绝。危险命令与敏感路径始终二次确认。"
            />
            {permState.categories.map((cat) => (
              <Field key={cat.key} label={cat.label} hint={cat.description}>
                <Segmented
                  value={permState.permissions[cat.key as keyof typeof permState.permissions] as string}
                  options={[
                    { value: "allow", label: "允许" },
                    { value: "confirm", label: "询问" },
                    { value: "deny", label: "拒绝" },
                  ]}
                  onChange={(v) =>
                    setPermState({
                      ...permState,
                      permissions: { ...permState.permissions, [cat.key]: v },
                    })
                  }
                />
              </Field>
            ))}
            <Field label="危险操作始终确认" hint="不随类别放行（硬规则兜底）">
              <Toggle
                checked={permState.permissions.confirmDangerousAlways}
                onChange={(v) =>
                  setPermState({
                    ...permState,
                    permissions: { ...permState.permissions, confirmDangerousAlways: v },
                  })
                }
              />
            </Field>
            <Field label="额外工作目录" hint="每行一个绝对路径；沙箱根之外的允许范围">
              <textarea
                style={styles.textareaSmall}
                rows={3}
                value={permState.permissions.workspaceRoots.join("\n")}
                placeholder="D:\\projects\\demo"
                onChange={(e) =>
                  setPermState({
                    ...permState,
                    permissions: {
                      ...permState.permissions,
                      workspaceRoots: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean),
                    },
                  })
                }
              />
            </Field>
            <div style={styles.note}>
              当前工作区根：<code style={styles.code}>{permState.workspaceRoot}</code>
            </div>
            <SaveRow onSave={savePermissions} />
          </div>
        ) : (
          <div style={styles.empty}>读取失败</div>
        );

      case "providers":
        return (
          <div>
            <SectionTitle
              title="供应商"
              hint="OpenAI 兼容接口。API Key 只从环境变量读取（LOOPSOAR_API_KEY / OPENAI_API_KEY），不落盘、不回传。"
            />
            <div style={styles.statusRow}>
              <span style={styles.statusLabel}>当前状态</span>
              <span style={styles.statusValue}>
                {provider?.configured
                  ? `${provider.provider} · ${provider.model}${provider.usable ? "" : `（${provider.reason}）`}`
                  : "未配置"}
              </span>
              <span style={provider?.hasApiKey ? styles.badgeOk : styles.badgeWarn}>
                {provider?.hasApiKey ? "密钥已就绪" : "缺少密钥"}
              </span>
            </div>
            <Field label="服务商名称">
              <input
                style={styles.input}
                value={providerForm.provider}
                placeholder="deepseek / openai / local"
                onChange={(e) => setProviderForm({ ...providerForm, provider: e.target.value })}
              />
            </Field>
            <Field label="接口地址（baseUrl）">
              <input
                style={styles.input}
                value={providerForm.baseUrl}
                placeholder="https://api.deepseek.com/v1"
                onChange={(e) => setProviderForm({ ...providerForm, baseUrl: e.target.value })}
              />
            </Field>
            <Field label="模型名">
              <input
                style={styles.input}
                value={providerForm.model}
                placeholder="deepseek-chat"
                onChange={(e) => setProviderForm({ ...providerForm, model: e.target.value })}
              />
            </Field>
            <div style={styles.buttonRow}>
              <button type="button" className="btn-ghost" style={styles.ghostButton} onClick={testProvider}>
                <Icon name="bolt" size={13} style={{ marginRight: 5 }} />
                测试连接
              </button>
              <button type="button" className="btn-primary" style={styles.primaryButton} onClick={saveProvider}>
                保存配置
              </button>
              {testResult ? (
                <span style={testResult.ok ? styles.testOk : styles.testFail}>
                  {testResult.ok ? "✓ " : "✕ "}
                  {testResult.message}
                </span>
              ) : null}
            </div>
            <div style={styles.note}>
              设置环境变量后需重启应用生效：
              <code style={styles.code}>LOOPSOAR_API_KEY=&lt;你的密钥&gt;</code>
            </div>
          </div>
        );

      case "rules":
        return rules && rulesForm ? (
          <div>
            <SectionTitle
              title="规则（AGENTS.md）"
              hint="项目根 AGENTS.md 随仓库共享；全局规则仅本机生效。写入顺序：全局 → 项目（后者更贴近当前任务）。
              规则不得覆盖身份铁律与安全策略（注入时自动附加护栏声明）。"
            />
            <RuleEditor
              title="项目规则"
              path={rules.workspace.path}
              exists={rules.workspace.exists}
              maxBytes={rules.maxFileBytes}
              value={rulesForm.workspace}
              onChange={(next) => setRulesForm({ ...rulesForm, workspace: next })}
            />
            <RuleEditor
              title="全局规则"
              path={rules.global.path}
              exists={rules.global.exists}
              maxBytes={rules.maxFileBytes}
              value={rulesForm.global}
              onChange={(next) => setRulesForm({ ...rulesForm, global: next })}
            />
            <div style={styles.mergeBox}>
              <div style={styles.mergeTitle}>合并结果</div>
              <div style={styles.mergeMeta}>
                注入 {rules.merged.included.length} 份 · 共 {rules.merged.totalBytes} 字节 · 跳过{" "}
                {rules.merged.skipped.length} 份
              </div>
              {rules.merged.skipped.length > 0 ? (
                <ul style={styles.skipList}>
                  {rules.merged.skipped.map((s) => (
                    <li key={s.path}>
                      {s.path}：{s.reason}
                    </li>
                  ))}
                </ul>
              ) : null}
              {rules.merged.text ? (
                <pre style={styles.preview}>{rules.merged.text.slice(0, 1200)}</pre>
              ) : (
                <div style={styles.note}>当前没有生效的规则内容。</div>
              )}
            </div>
            <SaveRow onSave={saveRules} saveLabel="保存规则" />
          </div>
        ) : (
          <div style={styles.empty}>读取失败</div>
        );

      case "advanced":
        return diagnostics ? (
          <div>
            <SectionTitle title="高级 / 诊断" hint="路径与运行时版本（排查问题时使用）" />
            <div style={styles.kvGrid}>
              <Kv k="数据目录" v={diagnostics.paths.dataDir} />
              <Kv k="配置目录" v={diagnostics.paths.configDir} />
              <Kv k="规则目录" v={diagnostics.paths.rulesDir} />
              <Kv k="工作区根" v={diagnostics.paths.workspaceRoot} />
              <Kv k="应用版本" v={diagnostics.versions.app} />
              <Kv k="Electron" v={diagnostics.versions.electron} />
              <Kv k="Chrome" v={diagnostics.versions.chrome} />
              <Kv k="Node" v={diagnostics.versions.node} />
            </div>
            {diagnostics.extra && Object.keys(diagnostics.extra).length > 0 ? (
              <div style={styles.mergeBox}>
                <div style={styles.mergeTitle}>运行时统计</div>
                <div style={styles.kvGrid}>
                  {Object.entries(diagnostics.extra).map(([k, v]) => (
                    <Kv key={k} k={k} v={String(v)} />
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div style={styles.empty}>读取失败</div>
        );

      case "about":
        return about ? (
          <div>
            <SectionTitle title="关于" hint="Loopsoar —— 浏览器优先的本地 AI Agent" />
            <div style={styles.aboutHead}>
              <img src="./logo.png" alt="Loopsoar" width={56} height={56} style={styles.aboutLogo} />
              <div>
                <div style={styles.aboutName}>{about.name}</div>
                <div style={styles.aboutVersion}>版本 {about.version}</div>
              </div>
            </div>
            <div style={styles.kvGrid}>
              <Kv k="应用 ID" v={about.appId} />
              <Kv k="应用协议" v={about.protocol} />
              <Kv k="Electron" v={about.electron} />
              <Kv k="Node" v={about.node} />
              <Kv k="品牌资产" v={about.brandAssetSource} />
              <Kv k="许可" v={about.license} />
            </div>
            <div style={styles.note}>
              规则文件遵循 AGENTS.md 约定（项目根系、全局规则、CLAUDE.md 兼容回退），
              参考：OpenCode Rules / Claude Code memory / Cursor Rules。
            </div>
          </div>
        ) : (
          <div style={styles.empty}>读取失败</div>
        );
      default:
        return <div style={styles.empty} />;
    }
  }, [
    section,
    loading,
    api,
    prefs,
    permState,
    provider,
    providerForm,
    testResult,
    rules,
    rulesForm,
    diagnostics,
    about,
    savePrefs,
    savePermissions,
    saveProvider,
    saveRules,
    testProvider,
  ]);

  return (
    <div style={styles.overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={styles.panel}>
        <div style={styles.panelHeader}>
          <span style={styles.panelTitle}>设置</span>
          <button type="button" className="icon-btn" title="关闭（Esc）" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </div>
        <div style={styles.panelBody}>
          <nav style={styles.nav}>
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`settings-nav-item${section === s.id ? " is-active" : ""}`}
                style={{ ...styles.navItem, ...(section === s.id ? styles.navItemActive : {}) }}
                onClick={() => setSection(s.id)}
              >
                <Icon name={s.icon} size={15} style={styles.navIcon} />
                <span style={styles.navText}>
                  <span style={styles.navLabel}>{s.label}</span>
                  <span style={styles.navHint}>{s.hint}</span>
                </span>
              </button>
            ))}
          </nav>
          <div style={styles.content}>
            {sectionContent}
            {notice ? (
              <div style={notice.kind === "ok" ? styles.noticeOk : styles.noticeError}>{notice.text}</div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------- 基础控件 -------------------------------- */

function SectionTitle({ title, hint }: { title: string; hint: string }): React.JSX.Element {
  return (
    <div style={styles.sectionHead}>
      <div style={styles.sectionTitle}>{title}</div>
      <div style={styles.sectionHint}>{hint}</div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div style={styles.field}>
      <div style={styles.fieldLabel}>
        <span>{label}</span>
        {hint ? <span style={styles.fieldHint}>{hint}</span> : null}
      </div>
      <div style={styles.fieldControl}>{children}</div>
    </div>
  );
}

function Segmented({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <div style={styles.segmented}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={`settings-seg${value === opt.value ? " is-active" : ""}`}
          style={{ ...styles.segItem, ...(value === opt.value ? styles.segItemActive : {}) }}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }): React.JSX.Element {
  return (
    <button
      type="button"
      className="settings-toggle"
      style={{ ...styles.toggle, ...(checked ? styles.toggleOn : {}) }}
      onClick={() => onChange(!checked)}
      aria-pressed={checked}
    >
      <span style={{ ...styles.toggleKnob, ...(checked ? styles.toggleKnobOn : {}) }} />
    </button>
  );
}

function RuleEditor({
  title,
  path,
  exists,
  maxBytes,
  value,
  onChange,
}: {
  title: string;
  path: string;
  exists: boolean;
  maxBytes: number;
  value: { enabled: boolean; content: string };
  onChange: (next: { enabled: boolean; content: string }) => void;
}): React.JSX.Element {
  const bytes = new TextEncoder().encode(value.content).length;
  return (
    <div style={styles.ruleCard}>
      <div style={styles.ruleHead}>
        <span style={styles.ruleTitle}>
          {title}
          <span style={exists ? styles.badgeOk : styles.badgeWarn}>{exists ? "已存在" : "未创建"}</span>
        </span>
        <label style={styles.ruleEnable}>
          <input
            type="checkbox"
            checked={value.enabled}
            onChange={(e) => onChange({ ...value, enabled: e.target.checked })}
          />
          启用
        </label>
      </div>
      <div style={styles.rulePath}>
        <code style={styles.code}>{path}</code>
        <span style={bytes > maxBytes ? styles.testFail : styles.ruleBytes}>
          {bytes} / {maxBytes} 字节
        </span>
      </div>
      <textarea
        style={styles.rulesTextarea}
        rows={6}
        spellCheck={false}
        placeholder={"# 项目规则\n\n- 构建命令：pnpm build\n- 代码风格：…"}
        value={value.content}
        onChange={(e) => onChange({ ...value, content: e.target.value })}
      />
    </div>
  );
}

function SaveRow({ onSave, saveLabel = "保存" }: { onSave: () => void; saveLabel?: string }): React.JSX.Element {
  return (
    <div style={styles.saveRow}>
      <button type="button" className="btn-primary" style={styles.primaryButton} onClick={onSave}>
        {saveLabel}
      </button>
    </div>
  );
}

function Kv({ k, v }: { k: string; v: string }): React.JSX.Element {
  return (
    <div style={styles.kvRow}>
      <span style={styles.kvKey}>{k}</span>
      <span style={styles.kvValue} title={v}>
        {v}
      </span>
    </div>
  );
}

/* ---------------------------------- 样式 ---------------------------------- */

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(8, 9, 12, 0.62)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 50,
    animation: "fadeOnly 140ms ease both",
  },
  panel: {
    width: "min(920px, 92vw)",
    height: "min(640px, 86vh)",
    display: "flex",
    flexDirection: "column",
    background: BRAND.inkRaised,
    border: `1px solid ${BRAND.border}`,
    borderRadius: 12,
    overflow: "hidden",
    boxShadow: "0 24px 60px rgba(0,0,0,0.55)",
  },
  panelHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 14px",
    borderBottom: `1px solid ${BRAND.border}`,
    background: BRAND.ink,
  },
  panelTitle: { fontSize: 13, fontWeight: 700, letterSpacing: 0.5 },
  panelBody: { display: "flex", flex: 1, minHeight: 0 },
  nav: {
    width: 186,
    flexShrink: 0,
    borderRight: `1px solid ${BRAND.border}`,
    padding: 8,
    display: "flex",
    flexDirection: "column",
    gap: 2,
    background: BRAND.ink,
    overflowY: "auto",
  },
  navItem: {
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    padding: "8px 10px",
    borderRadius: 8,
    border: "none",
    background: "transparent",
    color: BRAND.linenMuted,
    cursor: "pointer",
    textAlign: "left",
    transition: "background 120ms, color 120ms",
  },
  navItemActive: { background: BRAND.ochreSoft, color: BRAND.linen },
  navIcon: { marginTop: 2, flex: "none" },
  navText: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
  navLabel: { fontSize: 12.5, fontWeight: 600 },
  navHint: { fontSize: 10.5, color: BRAND.linenFaint, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  content: { flex: 1, minWidth: 0, overflowY: "auto", padding: "16px 20px" },
  sectionHead: { marginBottom: 14 },
  sectionTitle: { fontSize: 15, fontWeight: 700 },
  sectionHint: { marginTop: 4, fontSize: 11.5, color: BRAND.linenMuted, lineHeight: 1.6 },
  field: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 16,
    padding: "10px 0",
    borderBottom: `1px solid ${BRAND.border}`,
  },
  fieldLabel: { display: "flex", flexDirection: "column", gap: 3, fontSize: 12.5, color: BRAND.linen, minWidth: 150 },
  fieldHint: { fontSize: 10.5, color: BRAND.linenFaint, lineHeight: 1.5 },
  fieldControl: { flex: 1, display: "flex", justifyContent: "flex-end", alignItems: "center", minWidth: 0 },
  input: {
    width: "100%",
    maxWidth: 380,
    height: 30,
    padding: "0 10px",
    borderRadius: 7,
    border: `1px solid ${BRAND.border}`,
    background: BRAND.ink,
    color: BRAND.linen,
    fontSize: 12.5,
    outline: "none",
  },
  textareaSmall: {
    width: "100%",
    maxWidth: 380,
    borderRadius: 7,
    border: `1px solid ${BRAND.border}`,
    background: BRAND.ink,
    color: BRAND.linen,
    fontSize: 12,
    padding: 8,
    resize: "vertical",
    outline: "none",
  },
  segmented: {
    display: "inline-flex",
    border: `1px solid ${BRAND.border}`,
    borderRadius: 8,
    overflow: "hidden",
    background: BRAND.ink,
  },
  segItem: {
    padding: "5px 12px",
    border: "none",
    background: "transparent",
    color: BRAND.linenMuted,
    fontSize: 12,
    cursor: "pointer",
    transition: "background 120ms, color 120ms",
  },
  segItemActive: { background: BRAND.ochre, color: BRAND.ink, fontWeight: 700 },
  toggle: {
    width: 40,
    height: 22,
    borderRadius: 11,
    border: `1px solid ${BRAND.borderStrong}`,
    background: BRAND.ink,
    padding: 2,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    transition: "background 140ms, border-color 140ms",
  },
  toggleOn: { background: BRAND.ochre, borderColor: BRAND.ochre },
  toggleKnob: {
    width: 16,
    height: 16,
    borderRadius: "50%",
    background: BRAND.linenMuted,
    transition: "transform 140ms ease, background 140ms",
  },
  toggleKnobOn: { transform: "translateX(18px)", background: BRAND.ink },
  saveRow: { display: "flex", justifyContent: "flex-end", paddingTop: 14 },
  primaryButton: {
    padding: "6px 16px",
    borderRadius: 7,
    border: "none",
    background: BRAND.ochre,
    color: BRAND.ink,
    fontWeight: 700,
    fontSize: 12.5,
    cursor: "pointer",
  },
  ghostButton: {
    padding: "6px 12px",
    borderRadius: 7,
    border: `1px solid ${BRAND.borderStrong}`,
    background: "transparent",
    color: BRAND.linenMuted,
    fontSize: 12.5,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
  },
  buttonRow: { display: "flex", alignItems: "center", gap: 10, paddingTop: 14, flexWrap: "wrap" },
  statusRow: { display: "flex", alignItems: "center", gap: 10, padding: "8px 0 12px" },
  statusLabel: { fontSize: 11.5, color: BRAND.linenFaint },
  statusValue: { fontSize: 12.5, color: BRAND.linen },
  badgeOk: {
    fontSize: 10.5,
    padding: "2px 7px",
    borderRadius: 999,
    background: "rgba(94,234,212,0.14)",
    color: "#5eead4",
    marginLeft: 6,
  },
  badgeWarn: {
    fontSize: 10.5,
    padding: "2px 7px",
    borderRadius: 999,
    background: "rgba(200,118,60,0.18)",
    color: BRAND.ochreHover,
    marginLeft: 6,
  },
  testOk: { fontSize: 11.5, color: "#5eead4" },
  testFail: { fontSize: 11.5, color: "#f87171" },
  note: { marginTop: 12, fontSize: 11, color: BRAND.linenFaint, lineHeight: 1.7 },
  code: {
    fontFamily: "ui-monospace, Consolas, monospace",
    fontSize: 10.5,
    background: BRAND.ink,
    padding: "1px 5px",
    borderRadius: 4,
    color: BRAND.linenMuted,
  },
  ruleCard: {
    border: `1px solid ${BRAND.border}`,
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    background: BRAND.inkPanel,
  },
  ruleHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 },
  ruleTitle: { fontSize: 12.5, fontWeight: 700, display: "inline-flex", alignItems: "center" },
  ruleEnable: { fontSize: 11.5, color: BRAND.linenMuted, display: "inline-flex", alignItems: "center", gap: 6 },
  rulePath: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, margin: "8px 0" },
  ruleBytes: { fontSize: 10.5, color: BRAND.linenFaint },
  rulesTextarea: {
    width: "100%",
    boxSizing: "border-box",
    borderRadius: 7,
    border: `1px solid ${BRAND.border}`,
    background: BRAND.ink,
    color: BRAND.linen,
    fontSize: 12,
    lineHeight: 1.6,
    padding: 10,
    resize: "vertical",
    outline: "none",
    fontFamily: "ui-monospace, Consolas, monospace",
  },
  mergeBox: {
    border: `1px solid ${BRAND.border}`,
    borderRadius: 10,
    padding: 12,
    marginTop: 12,
    background: BRAND.inkPanel,
  },
  mergeTitle: { fontSize: 12, fontWeight: 700, marginBottom: 6 },
  mergeMeta: { fontSize: 11, color: BRAND.linenMuted, marginBottom: 8 },
  skipList: { margin: "4px 0 8px 18px", padding: 0, fontSize: 11, color: BRAND.ochreHover, lineHeight: 1.7 },
  preview: {
    margin: 0,
    maxHeight: 180,
    overflow: "auto",
    fontSize: 11,
    lineHeight: 1.6,
    color: BRAND.linenMuted,
    background: BRAND.ink,
    borderRadius: 7,
    padding: 10,
    whiteSpace: "pre-wrap",
  },
  kvGrid: { display: "grid", gap: 6 },
  kvRow: { display: "flex", gap: 12, fontSize: 11.5, alignItems: "baseline" },
  kvKey: { width: 96, flexShrink: 0, color: BRAND.linenFaint },
  kvValue: { color: BRAND.linen, wordBreak: "break-all", fontFamily: "ui-monospace, Consolas, monospace" },
  aboutHead: { display: "flex", alignItems: "center", gap: 14, marginBottom: 16 },
  aboutLogo: { borderRadius: 10 },
  aboutName: { fontSize: 18, fontWeight: 800 },
  aboutVersion: { fontSize: 12, color: BRAND.linenMuted, marginTop: 2 },
  noticeOk: { marginTop: 14, padding: "8px 12px", borderRadius: 8, background: "rgba(94,234,212,0.12)", color: "#5eead4", fontSize: 11.5 },
  noticeError: { marginTop: 14, padding: "8px 12px", borderRadius: 8, background: "rgba(248,113,113,0.12)", color: "#f87171", fontSize: 11.5 },
  empty: { fontSize: 12, color: BRAND.linenFaint, padding: 20 },
};
