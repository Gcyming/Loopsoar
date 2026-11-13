/**
 * 浏览器加载失败分类（纯函数，单一产地；StartPage/BrowserSurface 与单测共用）。
 *
 * Chromium net error code → 用户可理解类别；shell 已过滤 -3 ERR_ABORTED，
 * 这里仍按 generic 兜底（防御其它来源的失败事件）。
 */

/** 与 shell 侧 BrowserLoadFailure 同形（tabs 事件透传；UI 不 import 主进程类型）。 */
export interface BrowserLoadFailureInfo {
  code: number;
  description: string;
  url: string;
  isMainFrame?: boolean;
}

export type BrowserFailureKind = "offline" | "dns" | "refused" | "timeout" | "ssl" | "blocked" | "generic";

/** Chromium net error code → 用户可理解的失败类别（顺序即优先级）。 */
export function classifyLoadFailure(failure: BrowserLoadFailureInfo): BrowserFailureKind {
  const code = failure.code;
  const desc = (failure.description || "").toUpperCase();
  if (code === -106 || desc.includes("INTERNET_DISCONNECTED")) return "offline";
  if (code === -105 || code === -137 || desc.includes("NAME_NOT_RESOLVED") || desc.includes("NAME_RESOLUTION")) return "dns";
  if (code === -102 || code === -109 || desc.includes("CONNECTION_REFUSED") || desc.includes("ADDRESS_UNREACHABLE")) {
    return "refused";
  }
  if (code === -7 || code === -118 || desc.includes("TIMED_OUT") || desc.includes("TIMEOUT")) return "timeout";
  if ((code <= -200 && code > -300) || code === -107 || desc.includes("CERT") || desc.includes("SSL")) return "ssl";
  if (code === -20 || desc.includes("BLOCKED")) return "blocked";
  return "generic";
}
