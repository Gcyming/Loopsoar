/**
 * 设置页的通用控件与样式表（从 Settings.tsx 抽出，避免单一文件继续膨胀）。
 * 只放无业务状态的展示控件；设置分区仍由 Settings.tsx 编排。
 */
import * as React from "react";
import { LAYOUT } from "loopsoar-contracts/layout";
import { BADGE, BRAND } from "./theme.js";
import { useT } from "./i18n.js";
import { type DraftRule } from "./settingsModel.js";

/* ── 小控件 ── */
export function Head({ t, h }: { t: string; h: string }) {
  return <div style={{ marginBottom: 14 }}><div style={{ fontSize: 15, fontWeight: 700 }}>{t}</div><div style={{ marginTop: 4, fontSize: 11.5, color: BRAND.linenMuted, lineHeight: 1.6 }}>{h}</div></div>;
}

export function Field({ l, h, children }: { l: string; h?: string; children: React.ReactNode }) {
  return <div style={S.field}><div style={S.fieldLabel}><span>{l}</span>{h ? <span style={S.fieldHint}>{h}</span> : null}</div><div style={S.fieldCtl}>{children}</div></div>;
}
export function Seg({ v, opts, on }: { v: string; opts: [string, string][]; on: (x: string) => void }) {
  return <div style={S.seg}>{opts.map(([val, label]) => (
    <button key={val} type="button" className={`settings-seg${v === val ? " is-active" : ""}`} style={{ ...S.segItem, ...(v === val ? S.segOn : {}) }} onClick={() => on(val)}>{label}</button>
  ))}</div>;
}
export function Toggle({ v, on, title, testId }: { v: boolean; on: (x: boolean) => void; title?: string; testId?: string }) {
  return (
    <button
      type="button"
      className="settings-toggle"
      style={{ ...S.toggle, ...(v ? S.toggleOn : {}) }}
      onClick={() => on(!v)}
      aria-pressed={v}
      title={title}
      aria-label={title}
      data-testid={testId}
    >
      <span style={{ ...S.knob, ...(v ? S.knobOn : {}) }} />
    </button>
  );
}
export function CategoryCombo({
  value,
  onChange,
  options,
  labelOf,
  placeholder,
}: {
  value: string;
  onChange: (x: string) => void;
  options: string[];
  labelOf: (key: string) => string;
  placeholder: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<string | null>(null);
  // 失焦/选择时把「本地化标签」还原成规范 key；自定义文本原样保留
  const commit = (text: string) => {
    const matched = options.find((option) => labelOf(option) === text.trim());
    onChange(matched ?? text.trim());
    setDraft(null);
  };
  return (
    <div style={comboWrap}>
      <input
        style={{ ...S.input, maxWidth: "none", paddingRight: 22 }}
        value={draft ?? labelOf(value)}
        placeholder={placeholder}
        onFocus={() => {
          setDraft(labelOf(value));
          setOpen(true);
        }}
        onChange={(event) => {
          setDraft(event.target.value);
          onChange(event.target.value);
        }}
        onBlur={() => commit(draft ?? labelOf(value))}
      />
      <button
        type="button"
        style={comboArrow}
        aria-label="展开选项"
        onMouseDown={(event) => {
          event.preventDefault();
          setOpen((open) => !open);
        }}
      >
        ▾
      </button>
      {open && options.length > 0 ? (
        <div style={comboMenu}>
          {options.slice(0, 40).map((option) => (
            <button
              key={option}
              type="button"
              style={comboItem}
              onMouseDown={(event) => {
                event.preventDefault();
                onChange(option);
                setDraft(null);
                setOpen(false);
              }}
            >
              {labelOf(option)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function Combo({ v, ph, on, options, style }: { v: string; ph?: string; on: (x: string) => void; options: string[]; style?: React.CSSProperties }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div style={{ ...comboWrap, ...style }}>
      <input
        style={{ ...S.input, maxWidth: "none", paddingRight: 22 }}
        value={v}
        placeholder={ph}
        onChange={(event) => on(event.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 140)}
      />
      <button
        type="button"
        style={comboArrow}
        aria-label="展开选项"
        onMouseDown={(event) => {
          event.preventDefault();
          setOpen((value) => !value);
        }}
      >
        ▾
      </button>
      {open && options.length > 0 ? (
        <div style={comboMenu}>
          {options.slice(0, 40).map((option) => (
            <button
              key={option}
              type="button"
              style={comboItem}
              onMouseDown={(event) => {
                event.preventDefault();
                on(option);
                setOpen(false);
              }}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export const memoryBlock: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  padding: "10px 0",
  borderBottom: `1px solid ${BRAND.border}`,
};

export const memoryFormGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr) auto",
  gap: 8,
  width: "100%",
  alignItems: "center",
};
export const memoryFormRow: React.CSSProperties = { display: "flex", gap: 8, width: "100%", alignItems: "center" };
const comboWrap: React.CSSProperties = { position: "relative", minWidth: 0 };
const comboArrow: React.CSSProperties = {
  position: "absolute",
  right: 2,
  top: 2,
  bottom: 2,
  width: 22,
  border: "none",
  background: "transparent",
  color: "#a8a29a",
  cursor: "pointer",
  fontSize: 10,
};
const comboMenu: React.CSSProperties = {
  position: "absolute",
  zIndex: 60,
  top: "100%",
  left: 0,
  right: 0,
  marginTop: 2,
  maxHeight: 180,
  overflowY: "auto",
  background: BRAND.inkRaised,
  border: `1px solid ${BRAND.border}`,
  borderRadius: 8,
  boxShadow: "0 12px 28px rgba(0,0,0,0.45)",
  padding: 3,
};
const comboItem: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  border: "none",
  borderRadius: 5,
  background: "transparent",
  color: "#d8d2c8",
  padding: "5px 8px",
  fontSize: 12,
  cursor: "pointer",
};

export function In({ v, ph, on, type, style }: { v: string; ph?: string; on: (x: string) => void; type?: string; style?: React.CSSProperties }) {
  return <input style={{ ...S.input, ...style }} value={v} placeholder={ph} type={type ?? "text"} onChange={(e) => on(e.target.value)} />;
}
export function Area({ v, rows, on, wide, full, ph }: { v: string; rows: number; on: (x: string) => void; wide?: boolean; full?: boolean; ph?: string }) {
  return (
    <textarea
      style={
        wide
          ? { ...S.area, maxWidth: "none", width: "100%", minWidth: 240, fontFamily: "ui-monospace, Consolas, monospace" }
          : full
            ? { ...S.area, maxWidth: "none", width: "100%" }
            : S.area
      }
      rows={rows}
      value={v}
      placeholder={ph ?? (wide ? "x-opencode-session: {{sessionId}}\nUser-Agent: Loopsoar/1.0" : undefined)}
      onChange={(e) => on(e.target.value)}
      spellCheck={false}
    />
  );
}
export function Btn({ label, onClick, primary, small }: { label: string; onClick: () => void; primary?: boolean; small?: boolean }) {
  return (
    <button
      type="button"
      className={primary ? "btn-primary" : "btn-ghost"}
      style={{ ...(primary ? S.primary : S.ghost), ...(small ? S.small : {}), whiteSpace: "nowrap", flexShrink: 0 }}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
export function SaveBtn({ onClick, label }: { onClick: () => void; label: string }) {
  return <div style={{ display: "flex", justifyContent: "flex-end", paddingTop: 14 }}><Btn label={label} primary onClick={onClick} /></div>;
}
export function RuleCard({ d, max, workspaces, on, onDel, onPick }: {
  d: DraftRule;
  max: number;
  workspaces: { id: string; name: string; root: string }[];
  on: (p: Partial<DraftRule>) => void;
  onDel: () => void;
  onPick: (workspaceId: string) => void;
}) {
  const tr = useT();
  const bytes = new TextEncoder().encode(d.content).length;
  return (<div className="panel-card" style={S.card}>
    <div style={S.rowBetween}>
      <span style={S.meta}><span style={BADGE.neutral}>{d.scope === "workspace" ? tr("settings.rules.scopeWorkspace") : tr("settings.rules.scopeGlobal")}</span><span style={bytes > max ? S.errText : S.tag}>{tr("settings.bytesOf", { bytes, max })}</span></span>
      <span style={S.icons}><Toggle v={d.enabled} on={(next) => on({ enabled: next })} /><Btn label={tr("settings.delete")} small onClick={onDel} /></span>
    </div>
    {d.scope === "workspace" ? (
      <div style={{ display: "grid", gridTemplateColumns: "minmax(180px, 280px) 1fr", gap: 8, alignItems: "center" }}>
        <select
          style={{ ...S.input, maxWidth: "none", paddingRight: 8 }}
          value={d.workspaceId ?? ""}
          onChange={(event) => onPick(event.target.value)}
          title={d.workspaceRoot ?? ""}
        >
          {workspaces.length === 0 ? <option value="">{tr("settings.rules.noWorkspaces")}</option> : null}
          {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <span style={S.meta}>
          <span style={BADGE.neutral}>{d.name}</span>
          <span style={{ ...S.tag, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={d.workspaceRoot ?? ""}>{d.workspaceRoot ?? ""}</span>
        </span>
      </div>
    ) : (
      <input style={S.ruleName} value={d.name} onChange={(e) => on({ name: e.target.value })} />
    )}
    <textarea style={S.rulesArea} rows={4} spellCheck={false} value={d.content} placeholder={tr("settings.rules.namePlaceholder")} onChange={(e) => on({ content: e.target.value })} />
  </div>);
}
export function Stat({ l, v }: { l: string; v: number }) {
  return <div style={S.stat}><div style={S.statV}>{v}</div><div style={S.tag}>{l}</div></div>;
}
export function Kv({ k, v }: { k: string; v: string }) {
  return <div style={S.kvRow}><span style={S.kvKey}>{k}</span><span style={S.kvVal} title={v}>{v}</span></div>;
}

export const S: Record<string, React.CSSProperties> = {
  /** 覆盖层从标题栏下方开始：保证窗口最小化/最大化/关闭按钮在任何整页界面都可见可点
   *  （用户 m02115：全屏页盖住 TitleBar，右上角关闭点多次都退不出）。 */
  overlay: { position: "fixed", top: LAYOUT.TITLE_BAR_HEIGHT, left: 0, right: 0, bottom: 0, background: "rgba(8,9,12,0.62)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, animation: "fadeOnly 140ms ease both" },
  panel: { width: "min(960px, 94vw)", height: "min(690px, calc(100% - 32px))", display: "flex", flexDirection: "column", background: BRAND.inkRaised, border: `1px solid ${BRAND.border}`, borderRadius: 12, overflow: "hidden", boxShadow: "0 24px 60px rgba(0,0,0,0.55)" },
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
  fieldLabel: { display: "flex", flexDirection: "column", gap: 3, fontSize: 12.5, color: BRAND.linen, minWidth: 140, maxWidth: 400 },
  fieldHint: { fontSize: 10.5, color: BRAND.linenFaint, lineHeight: 1.5, overflowWrap: "anywhere" },
  fieldCtl: { flex: 1, display: "flex", justifyContent: "flex-end", alignItems: "center", minWidth: 0 },
  input: { width: "100%", maxWidth: 380, height: 30, padding: "0 10px", borderRadius: 7, border: `1px solid ${BRAND.border}`, background: BRAND.ink, color: BRAND.linen, fontSize: 12.5, outline: "none", boxSizing: "border-box" },
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
  /** 模型工具条：全选拨片 + 计数摘要（借鉴 slime：主开关独立一行，不再挤在表头里）。 */
  modelToolbar: { display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" },
  modelToolLabel: { display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12, color: BRAND.linenMuted },
  modelToolHint: { fontSize: 11.5, color: BRAND.linenFaint },
  /** 模型 ID 搜索框：占满剩余宽度，贴左；草稿输入与「添加」仍靠右。 */
  modelSearch: {
    flex: 1,
    minWidth: 180,
    height: 30,
    padding: "0 10px",
    borderRadius: 7,
    border: `1px solid ${BRAND.border}`,
    background: BRAND.ink,
    color: BRAND.linen,
    fontSize: 12.5,
    outline: "none",
  },
  modelAddRow: { display: "flex", gap: 6, alignItems: "center", marginBottom: 8, justifyContent: "space-between" },
  tableWrap: { maxHeight: 380, overflow: "auto", border: `1px solid ${BRAND.border}`, borderRadius: 8 },
  table: { width: "100%", minWidth: 1080, borderCollapse: "collapse", fontSize: 11.5 },
  th: { textAlign: "left", padding: "6px 6px", color: BRAND.linenFaint, fontWeight: 600, borderBottom: `1px solid ${BRAND.border}`, whiteSpace: "nowrap" },
  thNarrow: { textAlign: "left", padding: "6px 4px", color: BRAND.linenFaint, fontWeight: 600, borderBottom: `1px solid ${BRAND.border}`, width: 62, whiteSpace: "nowrap" },
  thTiny: { textAlign: "center", padding: "6px 3px", color: BRAND.linenFaint, fontWeight: 600, borderBottom: `1px solid ${BRAND.border}`, width: 38 },
  td: { padding: "3px 4px", borderBottom: `1px solid ${BRAND.border}` },
  tdCenter: { padding: "3px 3px", borderBottom: `1px solid ${BRAND.border}`, textAlign: "center" },
  tblInput: { width: "100%", height: 24, padding: "0 5px", borderRadius: 5, border: `1px solid ${BRAND.border}`, background: BRAND.ink, color: BRAND.linen, fontSize: 11, outline: "none", boxSizing: "border-box" },
  /** 三态能力列（函数调用 / 结构化输出）：auto=自动/未知、supported=支持、unsupported=不支持。 */
  thState: { textAlign: "center", padding: "6px 3px", color: BRAND.linenFaint, fontWeight: 600, borderBottom: `1px solid ${BRAND.border}`, width: 52, whiteSpace: "nowrap" },
  tdState: { padding: "3px 3px", borderBottom: `1px solid ${BRAND.border}`, textAlign: "center", width: 52 },
  tblSelect: { width: "100%", height: 24, padding: "0 2px", borderRadius: 5, border: `1px solid ${BRAND.border}`, background: BRAND.ink, color: BRAND.linen, fontSize: 11, outline: "none", boxSizing: "border-box" },
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
  /** 供应商编辑大弹窗：独立于页面滚动，打开即定位到标题/顶部，保存与测试结果固定在底部状态栏 + 右上角浮动提示。 */
  modalBackdrop: {
    position: "fixed",
    top: LAYOUT.TITLE_BAR_HEIGHT,
    left: 0,
    right: 0,
    bottom: 0,
    background: "rgba(8,9,12,0.62)",
    backdropFilter: "blur(3px)",
    zIndex: 70,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
    animation: "fadeOnly 140ms ease both",
  },
  modal: {
    width: "min(1160px, 96vw)",
    maxHeight: "min(880px, calc(100% - 32px))",
    display: "flex",
    flexDirection: "column",
    background: BRAND.inkRaised,
    border: `1px solid ${BRAND.border}`,
    borderRadius: 14,
    overflow: "hidden",
    boxShadow: "0 28px 70px rgba(0,0,0,0.6)",
  },
  modalHead: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, padding: "14px 20px", borderBottom: `1px solid ${BRAND.border}`, background: BRAND.inkPanel },
  modalHeadText: { minWidth: 0 },
  modalTitle: { fontSize: 15, fontWeight: 700, color: BRAND.linen },
  modalSub: { marginTop: 4, fontSize: 11.5, color: BRAND.linenFaint, wordBreak: "break-all" },
  modalBody: { flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: "4px 20px 14px" },
  modalFoot: { display: "flex", alignItems: "center", gap: 14, padding: "10px 20px", borderTop: `1px solid ${BRAND.border}`, background: BRAND.inkPanel, flexWrap: "wrap" },
  modalStatus: { flex: 1, minWidth: 240, fontSize: 11.5, color: BRAND.linenMuted, lineHeight: 1.6, wordBreak: "break-word" },
  /** 供应商操作浮动反馈：固定右上角，成功自动消失、错误常驻，避免"提示在最下面找不到"。 */
  providerToast: {
    position: "fixed",
    top: LAYOUT.TITLE_BAR_HEIGHT + 16,
    right: 22,
    zIndex: 80,
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    maxWidth: 440,
    padding: "10px 14px",
    borderRadius: 10,
    fontSize: 12,
    lineHeight: 1.6,
    boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
    border: `1px solid ${BRAND.border}`,
  },
  providerToastOk: { background: "rgba(18,52,44,0.96)", color: "#5eead4", borderColor: "rgba(94,234,212,0.35)" },
  providerToastErr: { background: "rgba(56,22,24,0.96)", color: "#f87171", borderColor: "rgba(248,113,113,0.35)" },
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
  // 搜索引擎（设置 · 搜索引擎）：Chrome 式「一行一个引擎 + 左侧单选圆点」的列表。
  engineList: { display: "flex", flexDirection: "column", gap: 8, maxWidth: 640 },
  engineRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    width: "100%",
    padding: "10px 12px",
    borderRadius: 10,
    border: `1px solid ${BRAND.border}`,
    background: BRAND.inkRaised,
    color: BRAND.linen,
    cursor: "pointer",
    textAlign: "left",
    transition: "border-color 120ms, background 120ms",
  },
  engineRowActive: { borderColor: BRAND.ochre, background: "rgba(200,118,60,0.10)" },
  engineLogo: { flex: "none", display: "block", borderRadius: 5 },
  engineText: { display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 },
  engineName: { fontSize: 13, fontWeight: 700 },
  engineHost: { fontSize: 11, color: BRAND.linenFaint, fontFamily: "ui-monospace, Consolas, monospace" },
  engineRadio: {
    width: 18,
    height: 18,
    flex: "none",
    borderRadius: "50%",
    border: `1.5px solid ${BRAND.borderStrong}`,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    color: BRAND.ink,
  },
  engineRadioActive: { background: BRAND.ochre, borderColor: BRAND.ochre, color: BRAND.ink },
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
