/**
 * 首次启动向导（3 步）：欢迎与定位 → 配置模型供应商 → 技能/工作区/终端 → 完成。
 *
 * 边界：组件不直接改 App 状态，也不自己判断「是否首次」——
 *   · 显示与否由 App 通过 open 控制（App 用 shouldShowOnboarding()/localStorage 标记决定）；
 *   · 「打开供应商设置 / 浏览技能」通过 onOpenSettings(section) 交给 App；
 *   · 跳过/完成/关闭都会写 localStorage 'loopsoar_onboarding_done'，避免每次启动重复打扰。
 *
 * 从设置「关于」重新打开：App 只需 setOnboardingOpen(true)（见报告里的接线示例）。
 */
import * as React from "react";
import { Icon } from "./Icon.js";
import { useT } from "./i18n.js";

/** localStorage 标记：向导是否已看过（跳过/完成都算）。 */
export const ONBOARDING_DONE_KEY = "loopsoar_onboarding_done";

/** 是否已看过向导（localStorage 不可用时按「已看过」处理，不阻塞启动）。 */
export function isOnboardingDone(): boolean {
  if (typeof localStorage === "undefined") return true;
  try {
    return localStorage.getItem(ONBOARDING_DONE_KEY) === "1";
  } catch {
    return true;
  }
}

/** 标记已看过（跳过/完成）。 */
export function markOnboardingDone(): void {
  try {
    localStorage.setItem(ONBOARDING_DONE_KEY, "1");
  } catch {
    // 隐私模式等：忽略
  }
}

/** 重置标记（调试/「重新打开」用；App 可直接以 open=true 重开，不必清除）。 */
export function resetOnboarding(): void {
  try {
    localStorage.removeItem(ONBOARDING_DONE_KEY);
  } catch {
    // 忽略
  }
}

export interface OnboardingProps {
  open: boolean;
  onClose: () => void;
  /** 跳转设置（供应商/技能等分区）；由 App 注入。 */
  onOpenSettings: (section?: string) => void;
}

const TOTAL_STEPS = 3;

export default function Onboarding({ open, onClose, onOpenSettings }: OnboardingProps): React.ReactElement | null {
  const tr = useT();
  const dialogRef = React.useRef<HTMLDivElement | null>(null);
  const [step, setStep] = React.useState(0);

  // 每次重新打开都从第 1 步开始（从设置重开时不残留上次进度）
  React.useEffect(() => {
    if (open) setStep(0);
  }, [open]);

  const finish = React.useCallback((): void => {
    markOnboardingDone();
    onClose();
  }, [onClose]);

  // Esc = 跳过（与「跳过」按钮一致：写标记后关闭）
  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      finish();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, finish]);

  // 打开时把焦点放进弹窗（键盘用户可直接 Tab / Enter 操作）
  React.useEffect(() => {
    if (open) dialogRef.current?.focus();
  }, [open, step]);

  if (!open) return null;

  const steps: Array<{ title: string; body: React.ReactNode }> = [
    {
      title: tr("onboarding.welcome.title"),
      body: (
        <>
          <div className="onboarding-hero">
            <img src="./logo.png" alt="Loopsoar" width={56} height={56} style={{ borderRadius: 12 }} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 800 }}>Loopsoar</div>
              <div className="onboarding-dim">{tr("onboarding.welcome.desc")}</div>
            </div>
          </div>
          <ul className="onboarding-bullets">
            <li>
              <Icon name="search" size={14} style={styles.bulletIcon} />
              {tr("onboarding.welcome.b1")}
            </li>
            <li>
              <Icon name="agent" size={14} style={styles.bulletIcon} />
              {tr("onboarding.welcome.b2")}
            </li>
            <li>
              <Icon name="check" size={14} style={styles.bulletIcon} />
              {tr("onboarding.welcome.b3")}
            </li>
          </ul>
        </>
      ),
    },
    {
      title: tr("onboarding.provider.title"),
      body: (
        <>
          <div className="onboarding-dim">{tr("onboarding.provider.desc")}</div>
          <div className="onboarding-actions-inline">
            <button type="button" className="btn-primary onboarding-btn" onClick={() => onOpenSettings("providers")}>
              <Icon name="cloud-upload" size={14} style={{ marginRight: 6 }} />
              {tr("onboarding.provider.open")}
            </button>
          </div>
          <div className="onboarding-note">{tr("onboarding.provider.hint")}</div>
        </>
      ),
    },
    {
      title: tr("onboarding.capability.title"),
      body: (
        <>
          <div className="onboarding-dim">{tr("onboarding.capability.desc")}</div>
          <ul className="onboarding-bullets">
            <li>
              <Icon name="bulb" size={14} style={styles.bulletIcon} />
              {tr("onboarding.capability.skills")}
            </li>
            <li>
              <Icon name="folders" size={14} style={styles.bulletIcon} />
              {tr("onboarding.capability.workspace")}
            </li>
            <li>
              <Icon name="terminal" size={14} style={styles.bulletIcon} />
              {tr("terminal.panelLabel")}
            </li>
          </ul>
          <div className="onboarding-actions-inline">
            <button type="button" className="onboarding-btn" onClick={() => onOpenSettings("skills")}>
              <Icon name="bulb" size={14} style={{ marginRight: 6 }} />
              {tr("onboarding.capability.skills")}
            </button>
          </div>
          <div className="onboarding-note">{tr("onboarding.capability.footer")}</div>
        </>
      ),
    },
  ];

  const lastStep = step >= steps.length - 1;
  const current = steps[Math.min(step, steps.length - 1)];

  return (
    <div className="onboarding-overlay" data-fullpage-overlay="onboarding" role="presentation">
      <div
        ref={dialogRef}
        className="onboarding-panel"
        role="dialog"
        aria-modal="true"
        aria-label={tr("onboarding.title")}
        tabIndex={-1}
      >
        <div className="onboarding-top">
          <span className="onboarding-step">{tr("onboarding.stepOf", { current: step + 1, total: TOTAL_STEPS })}</span>
          <button type="button" className="icon-btn" title={tr("common.skip")} aria-label={tr("common.skip")} onClick={finish}>
            <Icon name="close" size={13} />
          </button>
        </div>
        <div className="onboarding-dots" aria-hidden="true">
          {Array.from({ length: TOTAL_STEPS }, (_, index) => (
            <span key={index} className={`onboarding-dot${index === step ? " is-active" : ""}`} />
          ))}
        </div>
        <div className="onboarding-body">
          <div className="onboarding-title">{current.title}</div>
          {current.body}
        </div>
        {lastStep ? (
          <div className="onboarding-foot">
            <button type="button" className="onboarding-btn onboarding-btn-ghost" onClick={finish}>
              {tr("common.skip")}
            </button>
            <button type="button" className="btn-primary onboarding-btn" onClick={finish}>
              {tr("onboarding.done.start")}
            </button>
          </div>
        ) : (
          <div className="onboarding-foot">
            <button type="button" className="onboarding-btn onboarding-btn-ghost" onClick={finish}>
              {tr("common.skip")}
            </button>
            <span style={{ flex: 1 }} />
            {step > 0 ? (
              <button type="button" className="onboarding-btn onboarding-btn-ghost" onClick={() => setStep((value) => value - 1)}>
                {tr("common.back")}
              </button>
            ) : null}
            <button type="button" className="btn-primary onboarding-btn" onClick={() => setStep((value) => value + 1)}>
              {tr("common.next")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bulletIcon: { flex: "none", color: "var(--ls-accent, #c8763c)", marginTop: 3 },
};
