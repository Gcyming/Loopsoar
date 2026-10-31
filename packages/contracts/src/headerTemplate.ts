/**
 * 请求头模板（纯逻辑，单一产地）：供应商标配的限制通常要求客户端标识与"每请求/每会话"ID。
 *
 * 语法：`{{变量名}}`，渲染时替换为运行时值；未知变量保持原样（避免误删鉴权值）。
 * 可用变量（UI 帮助与保存校验共用这份清单）：
 *   sessionId 当前会话 ID（每个会话稳定，适合 x-opencode-session 等）
 *   provider  供应商 id（如 opencode-go）
 *   model     当前模型 id
 *   requestId 每次 HTTP 请求新生成的 UUID（适合要求幂等/追踪头的服务）
 *   timestamp 每次请求的 ISO 时间
 */

export const HEADER_TEMPLATE_VARIABLES = ["sessionId", "provider", "model", "requestId", "timestamp"] as const;

export type HeaderTemplateVariable = (typeof HEADER_TEMPLATE_VARIABLES)[number];

export interface HeaderTemplateVars extends Partial<Record<HeaderTemplateVariable, string>> {}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** 渲染单个请求头值：已知变量替换，未知变量原样保留。 */
export function renderHeaderValue(value: string, vars: HeaderTemplateVars): string {
  return value.replace(PLACEHOLDER, (match, rawName: string) => {
    const name = rawName as HeaderTemplateVariable;
    if (!HEADER_TEMPLATE_VARIABLES.includes(name)) return match;
    return vars[name] ?? "";
  });
}

/** 渲染整组请求头。 */
export function renderHeaderTemplates(
  headers: Record<string, string> | undefined,
  vars: HeaderTemplateVars,
): Record<string, string> {
  if (!headers) return {};
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    output[key] = renderHeaderValue(value, vars);
  }
  return output;
}

/** 校验模板里是否有未知变量（设置页保存前提示，避免用户以为生效了）。 */
export function unknownHeaderTemplateVariables(headers: Record<string, string> | undefined): string[] {
  if (!headers) return [];
  const unknown = new Set<string>();
  for (const value of Object.values(headers)) {
    for (const match of value.matchAll(PLACEHOLDER)) {
      if (!HEADER_TEMPLATE_VARIABLES.includes(match[1] as HeaderTemplateVariable)) unknown.add(match[1]);
    }
  }
  return [...unknown];
}
