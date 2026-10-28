/**
 * 工具调用策略（§4.3 S4）
 */

export function classifyToolCall(
  toolName: string,
  kind: "read" | "write" | "terminal" | "network",
  switches: { autoApprove?: string[]; requireApproval?: string[]; deny?: string[] },
): "auto" | "confirm" | "block" {
  const deny = switches?.deny ?? [];
  const require = switches?.requireApproval ?? [];
  const auto = switches?.autoApprove ?? [];

  if (deny.includes(toolName)) return "block";
  if (require.includes(toolName)) return "confirm";
  if (auto.includes(toolName)) return "auto";
  // 默认 confirm（安全默认拒绝）
  return "confirm";
}

export function explainDenial(toolName: string, kind: "read" | "write" | "terminal" | "network"): string {
  return `工具 ${toolName}（类型 ${kind}）被拒绝执行，建议检查权限或改用确认模式。`;
}
