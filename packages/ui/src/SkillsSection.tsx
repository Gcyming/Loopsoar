/**
 * 设置 · 技能：扫描/启停技能库。拆自 Settings.tsx 的 skills 分区，保持原有
 * 数据由父组件加载，本组件只负责渲染与触发刷新，避免设置页继续膨胀。
 */
import * as React from "react";
import { BADGE, BRAND } from "./theme.js";
import { useT } from "./i18n.js";
import type { SkillRecord } from "./types.js";

const S = {
  note: { fontSize: 11.5, color: BRAND.linenFaint, lineHeight: 1.7, marginBottom: 8 },
  code: { fontFamily: "ui-monospace, Consolas, monospace", fontSize: 11, color: BRAND.linenMuted, marginLeft: 6 },
  btns: { display: "flex", alignItems: "center", gap: 10, paddingTop: 12, flexWrap: "wrap" as const },
  btn: {
    padding: "6px 12px",
    borderRadius: 7,
    border: `1px solid ${BRAND.borderStrong}`,
    background: "transparent",
    color: BRAND.linenMuted,
    fontSize: 12.5,
    cursor: "pointer",
  },
  errText: { fontSize: 11.5, color: BRAND.danger, lineHeight: 1.6, marginTop: 4 },
  dashed: { border: `1px dashed ${BRAND.border}`, borderRadius: 10, padding: 20, color: BRAND.linenFaint, fontSize: 12, textAlign: "center" as const },
  card: { border: `1px solid ${BRAND.border}`, borderRadius: 10, padding: 12, marginBottom: 10, background: BRAND.inkPanel },
  rowBetween: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 6 },
  meta: { display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" as const },
  metaTitle: { fontSize: 13, fontWeight: 700, color: BRAND.linen },
  tag: { fontSize: 10.5, color: BRAND.linenFaint, border: `1px solid ${BRAND.border}`, borderRadius: 999, padding: "1px 7px" },
  icons: { display: "flex", alignItems: "center", gap: 6 },
  providerVal: { color: BRAND.linen, fontFamily: "ui-monospace, Consolas, monospace", fontSize: 11, wordBreak: "break-all" as const },
  providerRows: { display: "flex", flexDirection: "column" as const, gap: 4, marginTop: 6 },
  providerRow: { display: "flex", gap: 8, fontSize: 11.5 },
  providerKey: { width: 54, flexShrink: 0, color: BRAND.linenFaint },
  remove: {
    border: "none",
    background: "transparent",
    color: BRAND.danger,
    fontSize: 11,
    cursor: "pointer",
    padding: "2px 4px",
  },
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
  knob: { width: 16, height: 16, borderRadius: "50%", background: BRAND.linenMuted, transition: "transform 140ms ease, background 140ms" },
  knobOn: { transform: "translateX(18px)", background: BRAND.ink },
};

function Toggle({ value, onChange }: { value: boolean; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      className="settings-toggle"
      style={{ ...S.toggle, ...(value ? S.toggleOn : {}) }}
      onClick={() => onChange(!value)}
      aria-pressed={value}
    >
      <span style={{ ...S.knob, ...(value ? S.knobOn : {}) }} />
    </button>
  );
}

export interface SkillsSectionProps {
  skills: SkillRecord[];
  skillsDir: string;
  skillSkips: { dir: string; reason: string }[];
  onOpenDir: () => Promise<void>;
  onReload: () => Promise<void>;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}

export default function SkillsSection({ skills, skillsDir, skillSkips, onOpenDir, onReload, onToggle, onRemove }: SkillsSectionProps): React.ReactElement {
  const tr = useT();
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 700, color: BRAND.linen, marginBottom: 4 }}>{tr("settings.skills.head")}</div>
      <div style={S.note}>{tr("settings.skills.headHint")}</div>
      <div style={S.note}>{tr("settings.skills.dir")}<code style={S.code}>{skillsDir || "—"}</code></div>
      <div style={S.btns}>
        <button type="button" style={S.btn} onClick={() => void onOpenDir()}>{tr("settings.skills.openDir")}</button>
        <button type="button" style={S.btn} onClick={() => void onReload()}>{tr("settings.rescan")}</button>
      </div>
      {skillSkips.length > 0 ? (
        <div style={S.note}>
          {tr("settings.skills.skipped", { count: skillSkips.length })}
          {skillSkips.map((item) => <div key={item.dir} style={S.errText}>{tr("settings.skipItem", { path: item.dir, reason: item.reason })}</div>)}
        </div>
      ) : null}
      {skills.length === 0 ? (
        <div style={S.dashed}>{tr("settings.skills.empty")}</div>
      ) : (
        skills.map((skill) => (
          <div key={skill.id} className="panel-card" style={S.card}>
            <div style={S.rowBetween}>
              <span style={S.meta}>
                <span style={S.metaTitle}>{skill.frontmatter.name}</span>
                {skill.frontmatter.version ? <span style={BADGE.neutral}>v{skill.frontmatter.version}</span> : null}
                {skill.warnings && skill.warnings.length > 0 ? <span style={BADGE.warn} title={skill.warnings.join(" / ")}>{tr("settings.skills.tolerance")}</span> : null}
                {(skill.frontmatter.tags ?? []).map((tag) => <span key={tag} style={S.tag}>#{tag}</span>)}
              </span>
              <span style={S.icons}>
                <Toggle value={skill.enabled} onChange={(next) => void onToggle(skill.id, next)} />
                {!skill.enabled &&
                ((skill.frontmatter.tags ?? []).includes("candidate") ||
                  (skill.frontmatter.tags ?? []).includes("auto-candidate")) ? (
                  <button type="button" style={S.remove} onClick={() => void onRemove(skill.id)}>
                    {tr("settings.skills.remove")}
                  </button>
                ) : null}
              </span>
            </div>
            <div style={S.providerVal}>{skill.frontmatter.description}</div>
            <div style={S.providerRows}>
              {skill.frontmatter.whenToUse ? <div style={S.providerRow}><span style={S.providerKey}>{tr("settings.skills.whenToUse")}</span><span style={S.providerVal}>{skill.frontmatter.whenToUse}</span></div> : null}
              <div style={S.providerRow}><span style={S.providerKey}>{tr("settings.skills.body")}</span><span style={S.providerVal}>{tr("settings.bytes", { bytes: skill.bytes })}</span></div>
            </div>
          </div>
        ))
      )}
      <div style={S.note}>{tr("settings.skills.isolation")}</div>
    </div>
  );
}
