/**
 * PlanCard —— slime「任务规划」卡的 Loopsoar 实现。
 * 数据来自 Agent 的计划类工具（todo_write / plan / 计划工具）调用参数：
 *   steps/todos/items: [{ content, status }]
 * 纯展示组件（无 IPC）。
 */
import * as React from "react";
import { BRAND } from "./theme.js";

export interface PlanStep {
  content: string;
  status: "pending" | "in_progress" | "done";
}

export interface PlanCardProps {
  steps: PlanStep[];
}

export default function PlanCard({ steps }: PlanCardProps): React.ReactElement | null {
  if (steps.length === 0) return null;
  const done = steps.filter((s) => s.status === "done").length;
  const active = steps.find((s) => s.status === "in_progress");
  return (
    <div style={styles.card}>
      <div style={styles.head}>
        <span style={styles.title}>任务规划</span>
        <span style={{ ...styles.progress, color: done === steps.length ? "#4ade80" : BRAND.linenFaint }}>
          {done}/{steps.length}
        </span>
      </div>
      {active ? <div style={styles.active} title={active.content}>· {active.content}</div> : null}
      <div style={styles.list}>
        {steps.map((step, index) => {
          const mark = step.status === "done" ? "✓" : step.status === "in_progress" ? "•" : "○";
          const color =
            step.status === "done" ? "#4ade80" : step.status === "in_progress" ? BRAND.ochreHover : BRAND.linenFaint;
          return (
            <div key={`${index}-${step.content}`} style={styles.item} data-status={step.status}>
              <span style={{ ...styles.mark, color }}>{mark}</span>
              <span style={{ ...styles.text, opacity: step.status === "done" ? 0.65 : 1 }}>{step.content}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    margin: "6px 0 10px",
    padding: "9px 11px",
    borderRadius: 10,
    border: `1px solid ${BRAND.border}`,
    background: "rgba(17, 19, 24, 0.65)",
  },
  head: { display: "flex", alignItems: "center", gap: 8, marginBottom: 4 },
  title: { fontSize: 12, fontWeight: 700, color: BRAND.linen },
  progress: { fontSize: 10.5, fontVariantNumeric: "tabular-nums" },
  active: { fontSize: 11, color: BRAND.ochreHover, marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  list: { display: "flex", flexDirection: "column", gap: 3 },
  item: { display: "flex", alignItems: "flex-start", gap: 7, fontSize: 11.8, lineHeight: 1.55 },
  mark: { width: 12, flex: "none", textAlign: "center", fontSize: 11 },
  text: { color: BRAND.linenMuted, minWidth: 0, wordBreak: "break-word" },
};
