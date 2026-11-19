/**
 * 设置 · 外观分区。
 *
 * 侧栏卷轴参数有独立的本地状态与持久化（localStorage），继续挂在 Settings 的 `body`
 * useMemo 里只会把父级依赖数组越拉越长。拆出后父组件只负责把偏好和通知回调传进来。
 */
import React, { useState } from "react";
import { BRAND } from "./theme.js";
import { Btn, Field, Head, S, Seg } from "./settingsUi.js";
import TopicRail from "./TopicRail.js";
import { DEFAULT_CHAT_RAIL, loadRailParams, saveRailParams, type RailParams } from "./railParams.js";
import { useT } from "./i18n.js";
import type { LoopsoarAPI, Preferences } from "./types.js";

const THEME_BASE_OPTIONS: [string, string][] = [
  ["soft", "settings.appearance.theme.soft"],
  ["classic", "settings.appearance.theme.classic"],
];

const SLIDER_DEFS: {
  key: keyof Pick<RailParams, "w" | "amp" | "lam0" | "lam1" | "spd" | "tap" | "bumpReach" | "bumpSigma">;
  labelKey: string;
  min: number;
  max: number;
  step: number;
  fmt: (v: number) => string;
}[] = [
  { key: "w", labelKey: "settings.appearance.slider.w", min: 6, max: 32, step: 1, fmt: (v) => `${v}px` },
  { key: "amp", labelKey: "settings.appearance.slider.amp", min: 0, max: 100, step: 1, fmt: (v) => `${v}%` },
  { key: "lam0", labelKey: "settings.appearance.slider.lam0", min: 8, max: 400, step: 1, fmt: (v) => `${v}px` },
  { key: "lam1", labelKey: "settings.appearance.slider.lam1", min: 8, max: 400, step: 1, fmt: (v) => `${v}px` },
  { key: "spd", labelKey: "settings.appearance.slider.spd", min: 0, max: 4, step: 0.05, fmt: (v) => v.toFixed(2) },
  { key: "tap", labelKey: "settings.appearance.slider.tap", min: 0, max: 400, step: 5, fmt: (v) => `${v}px` },
  { key: "bumpReach", labelKey: "settings.appearance.slider.bumpReach", min: 4, max: 24, step: 1, fmt: (v) => `${v}px` },
  { key: "bumpSigma", labelKey: "settings.appearance.slider.bumpSigma", min: 8, max: 32, step: 1, fmt: (v) => `${v}px` },
];

export default function AppearanceSettingsSection({
  api,
  prefs,
  onPrefsChange,
  onPreferencesSaved,
  onNotice,
  onError,
}: {
  api: LoopsoarAPI;
  prefs: Preferences | null;
  onPrefsChange: (next: Preferences) => void;
  onPreferencesSaved?: (prefs: Preferences) => void;
  onNotice: (text: string) => void;
  onError: (error: unknown) => void;
}): React.JSX.Element {
  const tr = useT();
  const [rail, setRail] = useState<RailParams>(() =>
    typeof window === "undefined" ? DEFAULT_CHAT_RAIL : loadRailParams(),
  );
  // 扩展贡献主题：跟随扩展启停即时刷新（未装扩展时为空）。
  const [extThemes, setExtThemes] = useState<{ id: string; name: string }[]>([]);
  React.useEffect(() => {
    let alive = true;
    const load = (): void => {
      void api.extensions
        .list()
        .then((result) => {
          if (alive) setExtThemes((result.contributions?.themes ?? []).map((item) => ({ id: item.id, name: item.name })));
        })
        .catch(() => {});
    };
    load();
    const off = api.on("extensions:updated", load);
    return () => {
      alive = false;
      off();
    };
  }, [api]);

  const updateRail = (patch: Partial<RailParams>): void => {
    setRail(saveRailParams(patch));
  };

  const saveAnimations = (value: string): void => {
    if (!prefs) return;
    const next = { ...prefs, animations: value as Preferences["animations"] };
    onPrefsChange(next);
    void api.settings
      .setPreferences(next)
      .then((r) => {
        onPrefsChange(r.preferences);
        onPreferencesSaved?.(r.preferences);
        onNotice(tr("settings.appearance.animationsSaved"));
      })
      .catch(onError);
  };

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
                  ...THEME_BASE_OPTIONS.map(([value, key]) => [value, tr(key)] as [string, string]),
                  ...extThemes.map((item) => [item.id, item.name] as [string, string]),
                ]}
                on={(x) => {
                  if (!prefs) return;
                  // theme 属于偏好：写入 prefs 后由通用 400ms 防抖 effect 调用 setPreferences 落盘
                  onPrefsChange({ ...prefs, theme: x as Preferences["theme"] });
                }}
              />
            </Field>
          </div>
          <div className="panel-card" style={S.card}>
            <div style={S.formHead}>{tr("settings.appearance.railParams")}</div>
            {SLIDER_DEFS.map((item) => (
              <div key={item.key} style={S.sliderRow}>
                <span style={S.sliderLabel}>{tr(item.labelKey)}</span>
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
            <div style={S.note}>{tr("settings.appearance.pauseHint")}</div>
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
