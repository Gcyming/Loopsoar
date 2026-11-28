/**
 * 「通用」里后加的扩展项：通知/提示音、图片输入（视觉）与上下文压缩阈值。
 * 为什么拆出来：Settings.tsx 是组合根，受 1400 行预算约束；新增字段应放进独立组件。
 */
import * as React from "react";
import type { Preferences } from "./types.js";
import { useT } from "./i18n.js";
import { Field, Seg, Toggle } from "./settingsUi.js";

export function SettingsGeneralExtras({
  prefs,
  onChange,
}: {
  prefs: Preferences;
  onChange: (next: Preferences) => void;
}): React.JSX.Element {
  const tr = useT();
  return (
    <>
      <Field anchor="notifications" l={tr("settings.general.notifications")} h={tr("settings.general.notificationsHint")}>
        <Toggle v={prefs.notificationsEnabled ?? true} on={(x) => onChange({ ...prefs, notificationsEnabled: x })} />
      </Field>
      <Field anchor="notificationSound" l={tr("settings.general.notificationSound")} h={tr("settings.general.notificationSoundHint")}>
        <Toggle v={prefs.notificationSoundEnabled ?? true} on={(x) => onChange({ ...prefs, notificationSoundEnabled: x })} />
      </Field>
      <Field anchor="imageInput" l={tr("settings.general.imageInput")} h={tr("settings.general.imageInputHint")}>
        <Toggle v={prefs.imageInputEnabled ?? true} on={(x) => onChange({ ...prefs, imageInputEnabled: x })} />
      </Field>
      <Field anchor="compressRatio" l={tr("settings.general.compressRatio")} h={tr("settings.general.compressRatioHint")}>
        <Seg
          v={String(prefs.contextCompressRatio ?? 0.75)}
          opts={[
            ["0.6", "60%"],
            ["0.7", "70%"],
            ["0.75", "75%"],
            ["0.8", "80%"],
            ["0.9", "90%"],
          ]}
          on={(x) => onChange({ ...prefs, contextCompressRatio: Number(x) })}
        />
      </Field>
    </>
  );
}
