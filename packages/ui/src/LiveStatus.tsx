/**
 * LiveStatus —— slime「实时状态行」的 Loopsoar 移植版。
 *
 * 位置：Agent 回复最下方（随消息块内渲染）。
 * 内容：主句（正在思考 / 已发出请求、等待上游返回…）+ 副句（已用时 · 上下文占用）
 *      + 阶段超过 5s 后的陪伴语（不随机、不闪烁）。
 * 计时器只在本组件内，避免整页每秒重渲染。
 */
import * as React from "react";
import { BRAND } from "./theme.js";

export interface LiveStatusProps {
  startedAt: number;
  contextPct: number | null;
  runningTool?: boolean;
  /** 是否已经收到正文（收到后文案改为「正在输出」） */
  hasText?: boolean;
}

export default function LiveStatus({ startedAt, contextPct, runningTool, hasText }: LiveStatusProps): React.ReactElement {
  const [now, setNow] = React.useState<number>(() => Date.now());

  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const text = runningTool
    ? "思考与工具调用进行中"
    : hasText
      ? "正在输出"
      : seconds >= 5
        ? "已发出请求，等待上游返回"
        : "正在思考";
  const cheer = seconds >= 5 ? "别急，好东西值得多等几秒 🍀" : null;

  return (
    <div style={styles.wrap}>
      <div style={styles.mainRow}>
        <span className="text-scan-light" style={styles.text}>
          {text}
          {seconds >= 5 ? "…" : ""}
        </span>
        <span style={styles.detail}>
          · {seconds}s
          {contextPct !== null
            ? ` · 上下文 ${contextPct === 0 && seconds >= 0 ? "<1" : contextPct}%`
            : ""}
        </span>
      </div>
      {cheer ? <span style={styles.cheer}>{cheer}</span> : null}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { display: "flex", flexDirection: "column", gap: 2, padding: "4px 0 8px 44px" },
  mainRow: { display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", minWidth: 0 },
  text: { fontSize: 13, fontWeight: 600, color: BRAND.linen },
  detail: { fontSize: 11.5, color: BRAND.linenFaint },
  cheer: { fontSize: 12.5, color: BRAND.linenMuted, fontWeight: 500 },
};
