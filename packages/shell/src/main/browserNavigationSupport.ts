/**
 * 浏览器导航辅助（与宿主状态机解耦，避免 browserHost 继续膨胀）：
 * 程序化导航/新标签打开时需要补齐「用户点击链接」等价的 Referer，否则防盗链站点
 * （下载站/图床/学校系统）会对 Agent 直接打开的链接返回 403。
 */

/**
 * 防盗链下载站的 Referer 兼容清单（实测：CLDisk 的 Tencent WAF 对空 Referer 返回 403，
 * 对引导来源站（chaoxing.com）或下载站自身 origin 返回 200）。
 * 这类站点不校验「具体页面」，只校验来源域在白名单里；Agent 程序化导航/新标签常常
 * 没有 Referer，于是下载链接全变 403。对这类域统一补目标站 origin 最稳。
 */
const DOWNLOAD_REFERER_HOSTS = ["cldisk.com", "clisk.com"];

/** URL 是否属于防盗链下载域（含子域）。 */
export function isDownloadHost(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return DOWNLOAD_REFERER_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

/** 防盗链下载域的安全 Referer（目标站 origin + "/"）；非下载域返回 undefined。 */
export function downloadCompatibleReferer(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    return isDownloadHost(rawUrl) ? `${url.origin}/` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 计算程序化导航的 Referer（模仿用户点击链接）：
 * - 源/目标必须都是 http(s)，且不是同一 URL；
 * - 一律给**完整路径 + 查询串**（不含 hash）：签名下载链接的防盗链（如 CLisk）常校验
 *   路径/来源页，跨源只给 origin 仍会被 WAF 判成非法来源。
 */
export function refererForNavigation(from: string, to: string): string | undefined {
  try {
    const source = new URL(from);
    const target = new URL(to);
    const http = (u: URL): boolean => u.protocol === "http:" || u.protocol === "https:";
    if (!http(source) || !http(target)) return undefined;
    if (source.href === target.href) return undefined;
    return `${source.origin}${source.pathname}${source.search}`;
  } catch {
    return undefined;
  }
}
