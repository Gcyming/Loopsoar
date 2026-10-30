/**
 * ContextRing —— slime「上下文消耗圆环」的 Loopsoar 实现。
 * 绿 <60% / 黄 60~85% / 红 >85%；中心显示百分比；title 显示 tokens/cap。
 * 纯展示组件（无 IPC）。
 */
import * as React from "react";
import { BRAND } from "./theme.js";

export interface ContextRingProps {
  used: number;
  cap: number;
  loading?: boolean;
}

const SIZE = 18;
const STROKE = 2.2;

export default function ContextRing({ used, cap, loading }: ContextRingProps): React.ReactElement {
  const safeCap = Math.max(1, cap);
  const ratio = Math.min(1, Math.max(0, used / safeCap));
  const pct = Math.round(ratio * 100);
  const color = ratio < 0.6 ? "#4ade80" : ratio < 0.85 ? "#f2b855" : "#f87171";
  const radius = (SIZE - STROKE) / 2;
  const circumference = 2 * Math.PI * radius;
  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
      title={`上下文消耗：${used.toLocaleString()} / ${safeCap.toLocaleString()} tokens（${pct}%）${loading ? " · 生成中，数值随输出推进" : ""}`}
    >
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} style={{ flex: "none" }}>
        <circle cx={SIZE / 2} cy={SIZE / 2} r={radius} fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth={STROKE} />
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={`${circumference * ratio} ${circumference}`}
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
          style={{ transition: "stroke-dasharray 240ms ease, stroke 240ms ease" }}
        />
      </svg>
      <span style={{ fontSize: 9.5, color: BRAND.linenFaint, fontVariantNumeric: "tabular-nums" }}>{pct}%</span>
    </span>
  );
}
