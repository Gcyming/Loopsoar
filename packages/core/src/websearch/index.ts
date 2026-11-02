/**
 * 安全网络抓取（§4.3 S4）
 * 安全规则：协议白名单 → DNS → IP SSRF 检查 → fetch → 逐跳重查（maxRedirects 5）。
 *
 * 判据统一收敛到 ../net/ssrf（与 platform 的 DNS 钉扎抓取、浏览器守卫、模型探测共用一套 CIDR 逻辑），
 * 本文件只保留「抓取流程编排」；ssrf 纯函数在这里再导出，避免上层为拿判据去 import 内部路径。
 */
import { MAX_REDIRECTS } from "loopsoar-contracts/security-policy";
import type { NetAdapter } from "../platform/types.js";
import {
  assertPublicHttpUrl,
  assertPublicUrlWithDns,
  isPrivateOrReservedIp,
} from "../net/ssrf.js";

export {
  assertPublicHttpUrl,
  assertPublicUrlWithDns,
  isAllowedPort,
  isBlockedHostname,
  isIpLiteral,
  isLoopbackHostname,
  isLoopbackIp,
  isPrivateOrReservedIp,
  normalizeHostname,
  normalizeIpLiteral,
  SSRF_ERROR_PREFIX,
  SsrfBlockedError,
} from "../net/ssrf.js";
export type { IpResolver, PrivateNetRange, SsrfCheckOptions } from "../net/ssrf.js";

/**
 * SSRF 纯函数（历史导出名，保持既有调用/测试语义）：IP 命中私网/保留 CIDR → true。
 * 新代码请直接用 isPrivateOrReservedIp（名字与行为一致）。
 */
export function ssrfCheckIp(ipStr: string): boolean {
  return isPrivateOrReservedIp(ipStr);
}

/** 抓取前的目标校验：注入了 platform 就做 DNS 层判定，否则仅做纯 URL 判定。 */
async function assertFetchTarget(rawUrl: string, platform?: { net?: NetAdapter }): Promise<URL> {
  const net = platform?.net;
  if (net && typeof net.resolveIps === "function") {
    const checked = await assertPublicUrlWithDns(rawUrl, (host) => net.resolveIps(host));
    return checked.url;
  }
  return assertPublicHttpUrl(rawUrl);
}

export async function safeFetch(
  url: string,
  opts: { timeoutMs?: number; maxChars?: number; headers?: Record<string, string> } = {},
  platform?: { net?: NetAdapter },
): Promise<{ status: number; finalUrl: string; text: string }> {
  let currentUrl = url;
  let redirectCount = 0;

  while (true) {
    // 每一跳都重新校验（含 DNS）：重定向到内网是最常见的 SSRF 绕过方式
    const target = await assertFetchTarget(currentUrl, platform);
    const controller = new AbortController();
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(target.toString(), {
        method: "GET",
        headers: { ...opts.headers, "User-Agent": "Loopsoar-S4/1.0" },
        redirect: "manual",
        signal: controller.signal,
      });
      if (resp.status >= 300 && resp.status < 400 && resp.headers.has("location")) {
        redirectCount += 1;
        if (redirectCount > MAX_REDIRECTS) {
          throw new Error(`SSRF 拦截：重定向超过最大次数 ${MAX_REDIRECTS}`);
        }
        const location = resp.headers.get("location") || "";
        currentUrl = new URL(location, target).toString();
        continue;
      }
      const text = await resp.text();
      return {
        status: resp.status,
        finalUrl: resp.url || target.toString(),
        text: opts.maxChars ? text.slice(0, opts.maxChars) : text,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
