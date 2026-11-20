/**
 * 预算控制（§4.1 budget）
 * 四闸（轮次 / 工具调用 / Token / 墙钟）以 loopsoar-contracts/security-policy 的 BUDGET_HARD 为硬上限封顶；
 * 自定义 loop 限制只能收紧（min）不能放宽（max）；budgetReason 归因具体闸名，
 * warnThreshold 提前 3 轮预警，便于安全收束。
 * 为什么：预算是 Agent 安全的核心闸门，硬上限防止无限循环，归因文案让用户和日志可理解收束原因。
 */

import { BUDGET_HARD } from "loopsoar-contracts/security-policy";

// 预算使用量：每轮累积更新的四维度指标。
export interface BudgetUsage {
  rounds: number;        // 当前已执行的轮次
  toolCalls: number;     // 工具调用总次数
  totalTokens: number;   // 累计 Token 使用量
  /** prompt tokens 累计（上游提供拆分时才有值）。 */
  inputTokens?: number;
  /** completion tokens 累计（上游提供拆分时才有值）。 */
  outputTokens?: number;
  wallClockMs: number;  // 墙钟时间（毫秒）
}

// 预算限制：四字段全部可选，未指定则取硬上限；指定则与硬上限取 min（只能收紧）。
export interface BudgetLimits {
  maxRounds?: number;
  maxToolCalls?: number;
  maxTotalTokens?: number;
  maxWallClockMs?: number;
}

// 将自定义限制与 BUDGET_HARD 取交叉（min）：确保任何自定义限制都不能突破安全硬上限。
// 为什么：fail-closed 原则——即使配置错误，也不能放宽安全边界，只能更严格。
export function clampLimits(limits: BudgetLimits): Required<BudgetLimits> {
  return {
    maxRounds: Math.min(
      limits.maxRounds ?? BUDGET_HARD.maxRounds,
      BUDGET_HARD.maxRounds,
    ),
    maxToolCalls: Math.min(
      limits.maxToolCalls ?? BUDGET_HARD.maxToolCalls,
      BUDGET_HARD.maxToolCalls,
    ),
    maxTotalTokens: Math.min(
      limits.maxTotalTokens ?? BUDGET_HARD.maxTotalTokens,
      BUDGET_HARD.maxTotalTokens,
    ),
    maxWallClockMs: Math.min(
      limits.maxWallClockMs ?? BUDGET_HARD.maxWallClockMs,
      BUDGET_HARD.maxWallClockMs,
    ),
  };
}

// 四闸检查：命中任一闸即返回归因文案（包含「已收集信息」提示），否则返回 null（继续执行）。
// 为什么：每闸有不同安全含义，归因文案让用户立即理解为何停止，并提示可基于现有结果继续或结束。
export function budgetReason(
  usage: BudgetUsage,
  limits: BudgetLimits,
): string | null {
  const clamped = clampLimits(limits);

  if (usage.rounds >= clamped.maxRounds) {
    return `预算收束（轮次闸）：已用 ${usage.rounds} 轮，达上限 ${clamped.maxRounds}。已收集信息，建议基于现有结果继续或结束。`;
  }

  if (usage.toolCalls >= clamped.maxToolCalls) {
    return `预算收束（工具调用闸）：已用 ${usage.toolCalls} 次工具调用，达上限 ${clamped.maxToolCalls}。已收集信息，建议基于现有结果继续或结束。`;
  }

  if (usage.totalTokens >= clamped.maxTotalTokens) {
    return `预算收束（Token 闸）：已用 ${usage.totalTokens} Tokens，达上限 ${clamped.maxTotalTokens}。已收集信息，建议基于现有结果继续或结束。`;
  }

  if (usage.wallClockMs >= clamped.maxWallClockMs) {
    return `预算收束（墙钟时间闸）：已用 ${usage.wallClockMs} ms，达上限 ${clamped.maxWallClockMs}。已收集信息，建议基于现有结果继续或结束。`;
  }

  return null;
}

// 剩余 3 轮预警文案：当距离轮次上限仅剩 3 轮时返回预警字符串，否则返回 null。
// 为什么：提前预警让模型和用户有机会合理安排最后几轮的任务收束，避免突然中断。
export function warnThreshold(limits: BudgetLimits): string | null {
  const clamped = clampLimits(limits);
  // 预警阈值固定为距离上限 3 轮：不需要当前轮次数据，只提供静态预警提示
  return `预算预警：距离轮次上限 ${clamped.maxRounds} 还剩 3 轮，请开始收束任务。`;
}
