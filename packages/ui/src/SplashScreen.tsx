/**
 * 启动加载面板（参考 slime 项目的 SplashScreen）：
 * · 在程序内首屏数据/恢复标签就绪前一直显示，避免用户看到「网页一个个弹出、标签栏抖动」；
 * · 退场走 240ms 淡出（先降透明度、再卸载），不硬切；
 * · 主题跟随 CSS 变量，不写死颜色；
 * · 阶段清单展示「在等什么」（壳层/设置/标签），不是只有一个转圈。
 */
import React from "react";
import { Icon } from "./Icon.js";

export interface SplashStep {
  label: string;
  done: boolean;
}

export interface SplashScreenProps {
  visible: boolean;
  status: string;
  steps?: SplashStep[];
  title?: string;
  subtitle?: string;
}

export default function SplashScreen({
  visible,
  status,
  steps = [],
  title = "Loopsoar",
  subtitle,
}: SplashScreenProps): React.JSX.Element | null {
  const [mounted, setMounted] = React.useState(visible);
  const [opaque, setOpaque] = React.useState(visible);

  // 首帧 HTML 的静态启动页：React 面板挂载后立即移除，避免两套启动页重叠。
  React.useEffect(() => {
    document.getElementById("boot-splash")?.remove();
  }, []);

  React.useEffect(() => {
    if (visible) {
      setMounted(true);
      const raf = window.requestAnimationFrame(() => setOpaque(true));
      return () => window.cancelAnimationFrame(raf);
    }
    setOpaque(false);
    const timer = window.setTimeout(() => setMounted(false), 260);
    return () => window.clearTimeout(timer);
  }, [visible]);

  if (!mounted) return null;

  return (
    <div
      aria-hidden={!visible}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 999,
        background: "var(--ls-bg, #0a0c10)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        opacity: opaque ? 1 : 0,
        transition: "opacity 240ms ease",
        pointerEvents: visible ? "auto" : "none",
      }}
    >
      <div style={{ width: 320, textAlign: "center" }}>
        <div style={{ position: "relative", width: 72, height: 72, margin: "0 auto 18px" }}>
          <div
            style={{
              position: "absolute",
              inset: -16,
              borderRadius: 28,
              background: "radial-gradient(circle, rgba(200,118,60,0.30), transparent 68%)",
              animation: "loopsoar-splash-breathe 2.4s ease-in-out infinite",
            }}
          />
          <img
            src="./logo.png"
            alt=""
            width={72}
            height={72}
            draggable={false}
            style={{ position: "relative", display: "block", borderRadius: 19, boxShadow: "0 10px 30px rgba(0,0,0,0.45)" }}
          />
        </div>

        <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: 0.6, color: "var(--ls-text, #ece9e2)" }}>{title}</div>
        {subtitle ? (
          <div style={{ fontSize: 11, marginTop: 3, color: "var(--ls-text-faint, #6d6862)", fontVariantNumeric: "tabular-nums" }}>
            {subtitle}
          </div>
        ) : null}

        <div style={{ width: 210, height: 4, borderRadius: 3, background: "rgba(255,255,255,0.08)", margin: "18px auto 12px", overflow: "hidden" }}>
          <div
            style={{
              width: "38%",
              height: "100%",
              borderRadius: 3,
              background: "linear-gradient(90deg, transparent, var(--ls-accent, #d98a4f), transparent)",
              animation: "loopsoar-boot-slide 1.15s ease-in-out infinite",
            }}
          />
        </div>

        <div style={{ fontSize: 12.5, color: "var(--ls-text-muted, #a09b93)", minHeight: 18 }}>{status}</div>

        {steps.length > 0 ? (
          <div style={{ marginTop: 14, display: "inline-block", textAlign: "left" }}>
            {steps.map((step) => (
              <div key={step.label} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11.5, lineHeight: "18px", color: "var(--ls-text-muted, #a09b93)" }}>
                <span style={{ width: 12, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", color: step.done ? "#4ade80" : "var(--ls-accent, #d98a4f)" }}>
                  {step.done ? <Icon name="check" size={11} /> : <span style={{ display: "inline-block", width: 5, height: 5, borderRadius: 999, background: "var(--ls-accent, #d98a4f)" }} />}
                </span>
                <span style={{ opacity: step.done ? 0.68 : 1 }}>{step.label}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <style>{`
        @keyframes loopsoar-boot-slide { 0% { transform: translateX(-120%); } 100% { transform: translateX(330%); } }
        @keyframes loopsoar-splash-breathe { 0%, 100% { opacity: .55; transform: scale(1); } 50% { opacity: 1; transform: scale(1.06); } }
      `}</style>
    </div>
  );
}
