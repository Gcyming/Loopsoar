/**
 * Omnibox 解析（单一产地，纯函数）：把地址栏输入解析成「导航 URL」或「搜索 URL」。
 *
 * 规则（浏览器惯例）：
 *   · 明确 scheme（http/https）→ 当作 URL 严格校验；
 *   · 形如域名 / localhost / IP → 补 https 导航；
 *   · 其它（含空格、中文、无点号的词）→ 用偏好里的搜索引擎搜索；
 *   · 以 "?" 开头 → 强制搜索（去掉问号）；
 *   · javascript:/file:/data:/about: 等协议一律拒绝（安全边界不因搜索入口被绕过）。
 */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export type SearchEngine = "bing" | "google" | "baidu";

export type OmniboxResult =
  | { kind: "url"; url: string }
  | { kind: "search"; url: string; query: string; engine: SearchEngine }
  | { kind: "invalid"; reason: string };

export function buildSearchUrl(query: string, engine: SearchEngine = "bing"): string {
  const q = encodeURIComponent(query.trim());
  switch (engine) {
    case "google":
      return `https://www.google.com/search?q=${q}`;
    case "baidu":
      return `https://www.baidu.com/s?wd=${q}`;
    case "bing":
    default:
      return `https://www.bing.com/search?q=${q}`;
  }
}

/** 是否像 URL（域名/IP/localhost）；不像则走搜索。 */
export function isLikelyUrl(input: string): boolean {
  const raw = input.trim();
  if (!raw) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return true; // 带 scheme 交给严格校验
  if (/\s/.test(raw)) return false; // 含空白基本是搜索词
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(raw)) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(raw)) return true;
  // 域名：至少一个点，顶级域 2~24 个字母，允许端口/路径/查询
  if (/^[^\s/?#:]+\.[a-zA-Z]{2,24}(:\d+)?([/?#]|$)/.test(raw)) return true;
  return false;
}

export function resolveOmniboxInput(input: string, engine: SearchEngine = "bing"): OmniboxResult {
  const raw = input.trim();
  if (!raw) return { kind: "invalid", reason: "空地址" };

  // 强制搜索：?关键词
  if (raw.startsWith("?")) {
    const query = raw.slice(1).trim();
    if (!query) return { kind: "invalid", reason: "搜索词为空" };
    return { kind: "search", url: buildSearchUrl(query, engine), query, engine };
  }

  // "c: 语言" / "note: 内容" 这类带冒号的搜索词：冒号后紧跟空白说明它不是 URL
  // （合法 URL 不会含未编码空格），按搜索处理，不能当成未知协议拒绝。
  if (/\s/.test(raw) && /^[a-zA-Z][a-zA-Z0-9+.-]*:\s/.test(raw)) {
    return { kind: "search", url: buildSearchUrl(raw, engine), query: raw, engine };
  }

  // 显式协议：只放行 http/https（与 shell 侧同一套白名单）
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw);
  if (schemeMatch) {
    const protocol = `${schemeMatch[1].toLowerCase()}:`;
    if (!ALLOWED_PROTOCOLS.has(protocol)) {
      return { kind: "invalid", reason: `仅允许 http/https（拒绝 ${protocol}）` };
    }
  }

  if (isLikelyUrl(raw)) {
    const candidate = schemeMatch ? raw : `https://${raw}`;
    try {
      const parsed = new URL(candidate);
      if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
        return { kind: "invalid", reason: `仅允许 http/https（拒绝 ${parsed.protocol}）` };
      }
      if (!parsed.hostname) return { kind: "invalid", reason: "缺少主机名" };
      return { kind: "url", url: parsed.toString() };
    } catch {
      return { kind: "invalid", reason: `无法解析为 URL：${raw}` };
    }
  }

  // 兜底：当作搜索词
  return { kind: "search", url: buildSearchUrl(raw, engine), query: raw, engine };
}
