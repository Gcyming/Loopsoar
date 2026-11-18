/**
 * 设置面板的纯模型/格式化逻辑（P2-1 第一步）。
 *
 * 从 Settings.tsx 抽出与 React 无关的部分，便于单测，也避免这个 2.8k 行组件继续膨胀。
 * 不碰 DOM/IPC，只做类型、推导和文本 ⇄ 对象转换。
 */
import {
  HEADER_TEMPLATE_VARIABLES,
  unknownHeaderTemplateVariables,
} from "loopsoar-contracts/headerTemplate";
import { getLanguage } from "./i18n.js";
import type { LoopInfo } from "./types.js";

/** 翻译函数签名（与 i18n.ts 的 useT 返回一致）。 */
export type TFunc = (key: string, params?: Record<string, string | number>) => string;

export interface DraftRule {
  key: string;
  name: string;
  scope: "global" | "workspace";
  enabled: boolean;
  content: string;
  persisted: boolean;
  path: string;
  workspaceId?: string;
  workspaceName?: string;
  workspaceRoot?: string;
}

/** 取翻译；key 缺失（词典未覆盖）时回退到调用方给的原文，绝不显示裸 key。 */
export function localized(tr: TFunc, key: string, fallback: string): string {
  const text = tr(key);
  return text === key ? fallback : text;
}

/** Agent-Loop 类型推导：builtin 标记优先，其余按 id 约定（声明式 decl… / 脚本 script…）。 */
export function loopKindOf(loop: LoopInfo): "builtin" | "declarative" | "script" | "custom" {
  if (loop.builtin) return "builtin";
  // 后端已带真实 kind 时直接用（L2 声明式 / L3 脚本），否则按 id 约定兜底
  if (loop.kind === "declarative" || loop.kind === "script") return loop.kind;
  const id = loop.id.toLowerCase();
  if (id.includes("decl")) return "declarative";
  if (id.includes("script") || /\.(m?js|cjs|ts|py)$/.test(id)) return "script";
  return "custom";
}

/** 请求头文本 ⇄ 对象：每行一条 `Key: Value`；空行忽略，非法行抛可读错误（文案走 i18n）。 */
export function parseHeaderLines(text: string, tr: TFunc): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const [index, line] of lines.entries()) {
    const colon = line.indexOf(":");
    if (colon <= 0) throw new Error(tr("settings.providers.headerFormatError", { line: index + 1 }));
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!key || /\s/.test(key)) throw new Error(tr("settings.providers.headerKeyError", { line: index + 1 }));
    headers[key] = value;
  }
  if (Object.keys(headers).length > 30) throw new Error(tr("settings.providers.headerMax"));
  const unknown = unknownHeaderTemplateVariables(headers);
  if (unknown.length > 0) {
    throw new Error(tr("settings.providers.headerUnknownVars", {
      names: unknown.map((name) => `{{${name}}}`).join(", "),
      available: HEADER_TEMPLATE_VARIABLES.join(" / "),
    }));
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

export function formatHeaderLines(headers?: Record<string, string>): string {
  if (!headers) return "";
  return Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join("\n");
}

/** 时间戳展示（回退记录等；按当前语言短格式，非法值显示「时间未知」）。 */
export function formatWhen(at: number, tr: TFunc): string {
  if (!Number.isFinite(at) || at <= 0) return tr("settings.timeUnknown");
  return new Date(at).toLocaleString(getLanguage() === "en-US" ? "en-US" : "zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
