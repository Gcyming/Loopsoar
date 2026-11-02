/**
 * web_search 工具（shell 装配层）：按设置里的搜索引擎抓取网页搜索结果，解析成紧凑文本列表。
 *
 * 为什么要自己抓 HTML：不引入第三方搜索 API 依赖（零新增依赖），且出网必须走
 * platform.net.request（DNS 钉扎 + 逐跳 SSRF 校验）——禁止裸 fetch，否则等于绕过上轮的 SSRF 防护。
 * 引擎：bing / duckduckgo；google 没有稳定的免 JS 结果页，按产品约定用 DuckDuckGo 兜底（description 里说明）。
 */
import { z } from "zod";
import type { LoopsoarPlatform, NetAdapter } from "loopsoar-core/platform";
import type { ToolRegistry, ToolResult } from "loopsoar-core/tools/registry";

export type SearchEngine = "bing" | "google" | "duckduckgo";

export interface SearchToolsDeps {
  /** 当前偏好的搜索引擎（每次执行时读取，设置改动即时生效）。 */
  getEngine: () => SearchEngine | string | undefined;
  /** 平台适配层（取 net.request）；ctx.platform 优先，这里作为装配层兜底。 */
  getPlatform?: () => Pick<LoopsoarPlatform, "net"> | { net?: NetAdapter } | undefined;
  /** 默认结果条数（上限 10）；未注入时用 5。 */
  getMaxResults?: () => number | undefined;
}

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

/** 搜索请求超时（12s）与最大响应字符数（200k，足够容纳常见结果页）。 */
const SEARCH_TIMEOUT_MS = 12_000;
const SEARCH_MAX_CHARS = 200_000;
const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_HARD_CAP = 10;

const ENGINE_LABEL: Record<SearchEngine, string> = {
  bing: "Bing",
  duckduckgo: "DuckDuckGo",
  google: "Google（DuckDuckGo 兜底）",
};

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 LoopsoarBot/0.0";

/** 归一化引擎名：未知值按 bing 处理；google 在 URL 层降级到 DuckDuckGo。 */
export function normalizeSearchEngine(raw: string | undefined): SearchEngine {
  const text = String(raw ?? "").trim().toLowerCase();
  if (text === "duckduckgo" || text === "ddg") return "duckduckgo";
  if (text === "google") return "google";
  return "bing";
}

/**
 * 构造结果页 URL。返回实际使用的引擎（google → duckduckgo 兜底）。
 * query 一律 encodeURIComponent，避免空格/#/& 破坏查询语义。
 */
export function buildSearchUrl(engine: SearchEngine, query: string): { url: string; engine: SearchEngine } {
  const q = encodeURIComponent(query);
  switch (engine) {
    case "duckduckgo":
      return { url: `https://html.duckduckgo.com/html/?q=${q}`, engine: "duckduckgo" };
    case "google":
      // Google 结果页依赖 JS/反爬，纯 HTML 抓取不稳定；产品约定用 DuckDuckGo 兜底
      return { url: `https://html.duckduckgo.com/html/?q=${q}`, engine: "duckduckgo" };
    case "bing":
    default:
      return { url: `https://www.bing.com/search?q=${q}`, engine: "bing" };
  }
}

/* ────────────────────────────── HTML 解析（纯函数） ────────────────────────────── */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  middot: "·",
  times: "×",
  copy: "©",
};

/** HTML 实体解码（命名 + 十进制 + 十六进制）。 */
export function decodeHtmlEntities(text: string): string {
  return String(text ?? "").replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (raw, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : raw;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : raw;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? raw;
  });
}

/** 去标签 + 解实体 + 折叠空白（用于标题/摘要）。内联标签按浏览器语义不产生空白，直接去掉。 */
function cleanHtmlText(html: string): string {
  return decodeHtmlEntities(
    String(html ?? "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/?(?:strong|b|em|i|span|a|mark|u|font)\b[^>]*>/gi, "")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

/** 取标签属性值（兼容属性顺序任意：class 在 href 前/后都能取到）。 */
function attrOf(attrs: string, name: string): string {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i");
  const match = re.exec(attrs);
  return match ? (match[2] ?? match[3] ?? "") : "";
}

function safeBase64UrlDecode(value: string): string | null {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return null;
  }
}

/**
 * 结果链接归一化：
 *   · 相对/protocol-relative → 用结果页 URL 解析；
 *   · DuckDuckGo 跳转链（/l/?uddg=）→ 取出真实目标；
 *   · Bing 跳转链（/ck/a?...&u=a1<base64>）→ 尽力解码；
 *   · 仅保留 http/https（javascript:/mailto:/data: 一律丢弃）。
 */
export function resolveResultUrl(href: string, baseUrl: string): string | null {
  const raw = decodeHtmlEntities(String(href ?? "").trim());
  if (!raw) return null;
  if (/^(?:javascript|mailto|data|tel|file):/i.test(raw)) return null;

  let url: URL;
  try {
    url = new URL(raw.startsWith("//") ? `https:${raw}` : raw, baseUrl);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  // DuckDuckGo HTML 版：真实结果在 uddg 参数里
  if (host.endsWith("duckduckgo.com") && /\/l\//.test(url.pathname)) {
    const target = url.searchParams.get("uddg") ?? url.searchParams.get("u");
    if (target) {
      const decoded = (() => {
        try {
          return decodeURIComponent(target);
        } catch {
          return target;
        }
      })();
      try {
        const nested = new URL(decoded);
        if (nested.protocol === "http:" || nested.protocol === "https:") return nested.toString();
      } catch {
        // 继续用原链接
      }
    }
  }
  // Bing 跳转链：u=a1<base64url(真实 URL)>
  if (host.endsWith("bing.com") && url.pathname.startsWith("/ck/a")) {
    const u = url.searchParams.get("u") ?? "";
    if (u.startsWith("a1")) {
      const decoded = safeBase64UrlDecode(u.slice(2));
      if (decoded && /^https?:\/\//i.test(decoded)) return decoded;
    }
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.toString();
}

interface RawAnchor {
  attrs: string;
  inner: string;
  endIndex: number;
}

/** 顺序扫描全部 <a> 标签（属性顺序无关；用于 DDG 结果锚点定位）。 */
function scanAnchors(html: string): RawAnchor[] {
  const out: RawAnchor[] = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    out.push({ attrs: match[1] ?? "", inner: match[2] ?? "", endIndex: re.lastIndex });
  }
  return out;
}

/** Bing：li.b_algo 块内 h2>a + p 摘要。 */
function parseBingResults(html: string, baseUrl: string): SearchResultItem[] {
  const results: SearchResultItem[] = [];
  const blockRe = /<li\b([^>]*)>([\s\S]*?)<\/li>/gi;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(html)) !== null) {
    const attrs = match[1] ?? "";
    if (!/\bb_algo\b/.test(attrOf(attrs, "class"))) continue;
    const block = match[2] ?? "";

    const titleMatch = /<h2\b[^>]*>[\s\S]*?<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(block);
    if (!titleMatch) continue;
    const href = attrOf(titleMatch[1] ?? "", "href");
    const title = cleanHtmlText(titleMatch[2] ?? "");
    const url = resolveResultUrl(href, baseUrl);
    if (!url) continue;

    let snippet = "";
    const captionMatch = /<div\b[^>]*\bclass\s*=\s*"[^"]*\b(?:b_caption|b_lineclamp[0-9]*)\b[^"]*"[^>]*>[\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(
      block,
    );
    if (captionMatch) {
      snippet = cleanHtmlText(captionMatch[1] ?? "");
    } else {
      const pMatch = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block);
      if (pMatch) snippet = cleanHtmlText(pMatch[1] ?? "");
    }
    results.push({ title: title || url, url, snippet });
  }
  return results;
}

/** DuckDuckGo HTML 版：a.result__a 为标题链接，其后紧跟 .result__snippet。 */
function parseDuckDuckGoResults(html: string, baseUrl: string): SearchResultItem[] {
  const results: SearchResultItem[] = [];
  for (const anchor of scanAnchors(html)) {
    if (!/\bresult__a\b/.test(attrOf(anchor.attrs, "class"))) continue;
    const href = attrOf(anchor.attrs, "href");
    const title = cleanHtmlText(anchor.inner);
    const url = resolveResultUrl(href, baseUrl);
    if (!url) continue;

    // 摘要锚点/容器在标题之后不远处（限制扫描窗口，避免误取到下一个结果）
    const tail = html.slice(anchor.endIndex, anchor.endIndex + 3000);
    const snippetMatch = /<(?:a|div|td|span)\b[^>]*\bclass\s*=\s*"[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td|span)>/i.exec(
      tail,
    );
    const snippet = snippetMatch ? cleanHtmlText(snippetMatch[1] ?? "") : "";
    results.push({ title: title || url, url, snippet });
  }
  return results;
}

/** 解析结果页 HTML（导出便于单测/复用到其它抓取场景）。 */
export function parseSearchResults(engine: SearchEngine, html: string, baseUrl: string): SearchResultItem[] {
  const byEngine = engine === "duckduckgo" || engine === "google" ? parseDuckDuckGoResults : parseBingResults;
  const seen = new Set<string>();
  const out: SearchResultItem[] = [];
  for (const item of byEngine(html, baseUrl)) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    out.push(item);
  }
  return out;
}

/** 结果列表 → 模型可读文本：`1. 标题\n   URL\n   摘要`。 */
export function formatSearchResults(results: SearchResultItem[]): string {
  return results
    .map((item, index) => {
      const lines = [`${index + 1}. ${item.title || item.url}`, `   ${item.url}`];
      if (item.snippet) lines.push(`   ${item.snippet}`);
      return lines.join("\n");
    })
    .join("\n");
}

function clampMaxResults(value: number | undefined): number {
  const raw = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_MAX_RESULTS;
  return Math.max(1, Math.min(MAX_RESULTS_HARD_CAP, raw));
}

/** 反爬/验证页识别：命中时给可读错误，而不是伪造「空结果」。 */
function looksLikeBlockPage(html: string): boolean {
  const head = html.slice(0, 20_000).toLowerCase();
  return (
    head.includes("unusual traffic") ||
    head.includes("captcha") ||
    head.includes("are you a robot") ||
    head.includes("人机验证") ||
    head.includes("异常流量")
  );
}

/* ────────────────────────────── 工具注册 ────────────────────────────── */

/** 注册 web_search 工具（name/schema/权限固定；引擎与平台由装配层注入）。 */
export function registerSearchTools(registry: ToolRegistry, deps: SearchToolsDeps): void {
  registry.register({
    name: "web_search",
    description:
      "联网搜索网页，返回标题/链接/摘要列表（结果来自 Bing 或 DuckDuckGo；设置里选择 Google 时自动用 DuckDuckGo 兜底）",
    permissions: { network: true },
    schema: z.object({
      query: z.string().min(1).max(500),
      maxResults: z.number().int().min(1).max(MAX_RESULTS_HARD_CAP).optional(),
    }),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const params = (ctx.params ?? {}) as { query?: unknown; maxResults?: unknown };
        const query = typeof params.query === "string" ? params.query.trim() : "";
        if (!query) return { ok: false, content: "[错误] 缺少 query 参数" };

        const engine = normalizeSearchEngine(deps.getEngine());
        const maxResults = clampMaxResults(
          typeof params.maxResults === "number" ? params.maxResults : deps.getMaxResults?.(),
        );
        // ctx.platform 由执行器注入；deps.getPlatform 作为装配层兜底（单元测试/异步装配场景）
        const net =
          (ctx.platform?.net as NetAdapter | undefined) ??
          (deps.getPlatform?.()?.net as NetAdapter | undefined);
        if (!net || typeof net.request !== "function") {
          return { ok: false, content: "[错误] 网络适配器未就绪（无法搜索）" };
        }

        const { url, engine: effectiveEngine } = buildSearchUrl(engine, query);
        const response = await net.request({
          url,
          method: "GET",
          timeoutMs: SEARCH_TIMEOUT_MS,
          maxChars: SEARCH_MAX_CHARS,
          allowLoopback: false,
          headers: {
            "user-agent": USER_AGENT,
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
          },
        });
        if (response.status < 200 || response.status >= 300) {
          return {
            ok: false,
            content: `[错误] 搜索请求失败：HTTP ${response.status}（引擎：${ENGINE_LABEL[effectiveEngine]}）`,
          };
        }
        const html = response.text ?? "";
        if (looksLikeBlockPage(html)) {
          return {
            ok: false,
            content: `[错误] 搜索引擎返回反爬/验证页（${ENGINE_LABEL[effectiveEngine]}），请稍后重试或更换搜索引擎`,
          };
        }
        const baseUrl = response.finalUrl || url;
        const results = parseSearchResults(effectiveEngine, html, baseUrl).slice(0, maxResults);
        if (results.length === 0) {
          return {
            ok: true,
            content: `[空结果] 没有找到与「${query}」相关的网页结果（引擎：${ENGINE_LABEL[effectiveEngine]}）`,
          };
        }
        return { ok: true, content: formatSearchResults(results) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, content: `[错误] ${message}` };
      }
    },
  });
}
