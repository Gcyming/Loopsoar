/**
 * 设置 · 关于 → 数据与诊断 / 自动更新（从 Settings.tsx 拆出，避免组合根继续变长）。
 *
 * 两块的共同点：都需要一组「用户确认后才执行」的动作 + 状态回显；
 * 拆成独立组件后 Settings 只负责布局，业务动作集中在这里。
 */
import { useCallback, useEffect, useState } from "react";
import { useT } from "./i18n.js";
import { Btn, S } from "./settingsUi.js";
import type { LoopsoarAPI, UpdateInfoView } from "./types.js";

export interface AboutToolsSectionProps {
  api: LoopsoarAPI | null;
  /** 当前版本（「已是最新」文案用）。 */
  version: string;
}

export default function AboutToolsSection({ api, version }: AboutToolsSectionProps) {
  const tr = useT();
  const [dataMessage, setDataMessage] = useState("");
  const [dataBusy, setDataBusy] = useState(false);
  const [update, setUpdate] = useState<UpdateInfoView | null>(null);

  /** 关于页的数据操作：打开数据目录 / 导出备份 / 导出诊断包（共用一份提示）。 */
  const runDataAction = useCallback(async (action: "open" | "backup" | "diagnostics") => {
    if (!api) return;
    setDataBusy(true);
    setDataMessage("");
    try {
      if (action === "open") {
        const res = await api.settings.openDataDir();
        setDataMessage(res.ok ? tr("settings.about.data.opened") : tr("settings.about.data.failed", { error: res.error ?? "" }));
        return;
      }
      const res = action === "backup" ? await api.settings.exportBackup({}) : await api.settings.exportDiagnostics({});
      if (res.canceled) { setDataMessage(tr("settings.about.data.canceled")); return; }
      if (res.error) { setDataMessage(tr("settings.about.data.failed", { error: res.error })); return; }
      setDataMessage(tr("settings.about.data.done", { path: res.path ?? "", files: String(res.files ?? 0) }));
    } catch (err) {
      setDataMessage(tr("settings.about.data.failed", { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setDataBusy(false);
    }
  }, [api, tr]);

  /** 自动更新：初始化状态并订阅主进程事件；按钮按状态分流（检查/下载/安装）。 */
  useEffect(() => {
    if (!api) return;
    let alive = true;
    void api.update.status().then((value) => { if (alive) setUpdate(value); }).catch(() => undefined);
    const off = api.on("update:state", (payload) => setUpdate(payload as UpdateInfoView));
    return () => { alive = false; off(); };
  }, [api]);

  const runUpdate = useCallback(async () => {
    if (!api || !update) return;
    if (update.state === "available") { setUpdate(await api.update.download()); return; }
    if (update.state === "downloaded") {
      const res = await api.update.install();
      if (!res.ok) setDataMessage(tr("settings.about.data.failed", { error: res.error ?? "" }));
      return;
    }
    setUpdate(await api.update.check());
  }, [api, update, tr]);

  const openDoc = (doc: "license" | "privacy"): void => {
    void api?.settings.openDoc({ doc }).then((res) => {
      if (!res.ok) setDataMessage(tr("settings.about.data.failed", { error: res.error ?? "" }));
    });
  };

  return (
    <>
      <div style={S.box}>
        <div style={S.boxTitle}>{tr("settings.about.data.title")}</div>
        <div style={S.note}>{tr("settings.about.data.hint")}</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Btn label={tr("settings.about.data.open")} onClick={() => void runDataAction("open")} disabled={dataBusy} />
          <Btn label={tr("settings.about.data.backup")} onClick={() => void runDataAction("backup")} disabled={dataBusy} />
          <Btn label={tr("settings.about.data.diagnostics")} onClick={() => void runDataAction("diagnostics")} disabled={dataBusy} />
        </div>
        {dataMessage ? <div style={S.note}>{dataMessage}</div> : null}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
          <Btn label={tr("settings.about.license")} small onClick={() => openDoc("license")} />
          <Btn label={tr("settings.about.privacy")} small onClick={() => openDoc("privacy")} />
        </div>
      </div>
      <div style={S.box}>
        <div style={S.boxTitle}>{tr("settings.about.update.title")}</div>
        <div style={S.note}>
          {update?.state === "disabled" ? tr("settings.about.update.disabled")
            : update?.state === "downloading" ? tr("settings.about.update.downloading", { percent: String(update.percent ?? 0) })
            : update?.state === "downloaded" ? tr("settings.about.update.downloaded", { version: update.version ?? "" })
            : update?.state === "available" ? tr("settings.about.update.available", { version: update.version ?? "" })
            : update?.state === "error" ? tr("settings.about.update.error", { error: update.error ?? "" })
            : update?.state === "not-available" ? tr("settings.about.update.latest", { version })
            : tr("settings.about.update.hint")}
        </div>
        <Btn
          label={update?.state === "available" ? tr("settings.about.update.download")
            : update?.state === "downloaded" ? tr("settings.about.update.install")
            : tr("settings.about.update.check")}
          small
          disabled={!update || update.state === "disabled" || update.state === "downloading" || update.state === "checking" || update.state === "installing"}
          onClick={() => void runUpdate()}
        />
      </div>
    </>
  );
}
