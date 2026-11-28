/**
 * 上下文占用（UI 进度环的数据源）。
 *
 * 两条来源：
 *   1. 后端 tool_loop 每轮 progress 上报的 used/cap（token）：能拿到上游 usage.inputTokens 时是实测值，
 *      否则是按「消息 + 工具 schema」估算的值 —— 它看得见 system 提示与工具结果，比 UI 本地估算准；
 *   2. 后端尚未上报时的本地兜底：按字符类别估算（CJK ≈1 字/token，其余 ≈3.6 字符/token）。
 *      旧实现统一 4 字符/token，中文会话低估 3 倍以上，进度环长期显示「还有很大空间」。
 *
 * 为什么单独成文件：App.tsx 是组合根、行数被架构守卫钉住；算法与状态不该继续堆进根组件。
 */
import * as React from "react";

export type ContextUsageSource = "measured" | "estimated";

export interface LiveContextUsage {
  sessionId: string;
  used: number;
  cap: number;
  source: ContextUsageSource;
}

/** 本地兜底 token 估算（与 core/contextCompress.estimateTokens 同口径）。 */
export function estimateContextTokens(texts: readonly string[]): number {
  let cjk = 0;
  let other = 0;
  for (const text of texts) {
    for (const char of text) {
      const cp = char.codePointAt(0) ?? 0;
      if (
        (cp >= 0x3040 && cp <= 0x30ff) ||
        (cp >= 0x3400 && cp <= 0x4dbf) ||
        (cp >= 0x4e00 && cp <= 0x9fff) ||
        (cp >= 0xac00 && cp <= 0xd7af) ||
        (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xff00 && cp <= 0xffef)
      ) {
        cjk += 1;
      } else {
        other += 1;
      }
    }
  }
  return Math.max(1, Math.ceil(cjk + other / 3.6));
}

/** 进度环数值：used/cap 为 token，pct 已夹到 0~100。 */
export interface ContextRing {
  used: number;
  cap: number;
  pct: number;
  source: ContextUsageSource;
}

/**
 * 会话级上下文占用：后端上报（实测优先）→ 本地估算兜底。
 * 入参直接收「文本数组」而不是已算好的数字：调用方不必重复实现估算口径。
 */
export function useContextUsage(input: {
  sessionId: string | null;
  texts: readonly string[];
  /** 模型声明的上下文窗口；未配置时回退 128k（与旧 UI 行为一致）。 */
  contextWindow?: number;
}): {
  ring: ContextRing;
  reportContextUsage: (
    sessionId: string,
    used: number,
    cap: number,
    source: ContextUsageSource,
  ) => void;
} {
  const [liveContext, setLiveContext] = React.useState<LiveContextUsage | null>(null);
  const reportContextUsage = React.useCallback(
    (sessionId: string, used: number, cap: number, source: ContextUsageSource): void => {
      setLiveContext({ sessionId, used, cap, source });
    },
    [],
  );
  const active = liveContext && liveContext.sessionId === input.sessionId ? liveContext : null;
  const fallbackCap =
    input.contextWindow && input.contextWindow > 0 ? input.contextWindow : 128_000;
  const cap = active && active.cap > 0 ? active.cap : fallbackCap;
  const used = active?.used ?? estimateContextTokens(input.texts);
  return {
    ring: {
      used,
      cap,
      pct: Math.min(100, Math.round((used / cap) * 100)),
      source: active?.source ?? "estimated",
    },
    reportContextUsage,
  };
}
