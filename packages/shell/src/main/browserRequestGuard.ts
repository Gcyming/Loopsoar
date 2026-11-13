/**
 * 浏览器请求守卫（shell 主进程，纯逻辑，零 electron 依赖）。
 *
 * 为什么需要：标签页里跑的网页内容不可信。恶意页面/被诱导的 Agent 可以发起
 * `http://169.254.169.254/`、`http://192.168.x.x/`、`ws://127.0.0.1:...` 之类请求把内部服务
 * 暴露给页面 JS（SSRF 的浏览器侧入口）。这里在 Electron `webRequest.onBeforeRequest` 上做两层判定：
 *   ① 纯函数策略（同步）：协议白名单 + 主机名/私网 IP 判定（IP 字面量不需要 DNS）；
 *   ② DNS 校验（异步，带 5 分钟 LRU 缓存）：域名解析结果里出现私网/保留 IP 即拦截（防 DNS rebinding）。
 *
 * 回环策略：E2E 与本地开发页面需要 127.0.0.1（默认放行），
 * 设置环境变量 `LOOPSOAR_STRICT_NET=1` 后不再放行（生产严格模式）。
 */
import {
  AD_BLOCK_HOST_SUFFIXES,
  AD_BLOCK_URL_PATTERNS,
} from "loopsoar-contracts/security-policy";
import {
  isBlockedHostname,
  isIpLiteral,
  isLoopbackHostname,
  isLoopbackIp,
  isPrivateOrReservedIp,
} from "loopsoar-core/websearch";

/** 守卫判定结果：允许或拦截（拦截必须带可读原因，用于日志/诊断）。 */
export interface BrowserRequestDecision {
  action: "allow" | "block";
  reason?: string;
  /** 拦截类别：adblock=广告/追踪；缺省=SSRF/协议等安全拦截（装配层据此在日志里标注）。 */
  kind?: "adblock";
}

/** 浏览器允许的协议：页面/WebSocket 够用，且都能被 SSRF 判据覆盖。 */
const BROWSER_SAFE_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);

function allow(): BrowserRequestDecision {
  return { action: "allow" };
}

function block(reason: string): BrowserRequestDecision {
  return { action: "block", reason };
}

/** URL → 主机名（仅用于日志，避免把完整 URL 的查询参数打进日志）。 */
function hostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname || "(空主机)";
  } catch {
    return "(无法解析的 URL)";
  }
}

/* ────────────────────────── 广告/追踪判定（纯函数，契约常量驱动） ────────────────────────── */

const AD_HOST_SUFFIXES: readonly string[] = AD_BLOCK_HOST_SUFFIXES.map((suffix) => String(suffix).toLowerCase());
const AD_URL_PATTERNS: readonly string[] = AD_BLOCK_URL_PATTERNS.map((pattern) => String(pattern).toLowerCase());

export interface AdBlockMatch {
  kind: "host" | "url";
  detail: string;
}

/**
 * 纯函数：URL 是否命中广告/追踪规则（命中返回匹配细节，未命中 null）。
 * 规则来自 contracts 单一产地：
 *   · 域名后缀：host === suffix 或 host 以 ".suffix" 结尾（子域命中；带点边界防 notdoubleclick.net 误杀）；
 *   · URL 片段：pathname+search 包含契约片段（如 /collect?v=、/gtag/js），大小写不敏感。
 * IP 字面量与非常规 scheme 不参与广告判定（它们由 SSRF/协议层负责）。
 */
export function matchAdBlockUrl(rawUrl: string): AdBlockMatch | null {
  let url: URL;
  try {
    url = new URL(String(rawUrl ?? ""));
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "ws:" && url.protocol !== "wss:") {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (!host || isIpLiteral(host)) return null;

  for (const suffix of AD_HOST_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return { kind: "host", detail: suffix };
  }
  const withQuery = `${url.pathname}${url.search}`.toLowerCase();
  for (const pattern of AD_URL_PATTERNS) {
    if (withQuery.includes(pattern)) return { kind: "url", detail: pattern };
  }
  return null;
}

function blockAd(match: AdBlockMatch): BrowserRequestDecision {
  const what = match.kind === "host" ? `域名后缀 ${match.detail}` : `URL 片段 ${match.detail}`;
  return { action: "block", kind: "adblock", reason: `广告/追踪请求拦截（${what}）` };
}

export interface BrowserRequestPolicyOptions {
  /** 是否放行回环（127.0.0.1/::1/localhost）；默认 true，`LOOPSOAR_STRICT_NET=1` 时强制关闭。 */
  allowLoopback?: boolean;
  /**
   * 广告/追踪拦截开关（缺省 true，遵循偏好 adBlockEnabled）。
   * 传函数以便装配层每次请求读取最新偏好（设置改完即时生效）；传 false 完全跳过广告判定。
   */
  adBlock?: boolean | (() => boolean);
}

export type BrowserRequestPolicy = (url: string) => BrowserRequestDecision;

/**
 * 创建同步 URL 策略：仅 http/https/ws/wss；拒绝内部主机名、私网/保留 IP、userinfo、非标准 scheme；
 * 广告/追踪开关打开时按契约后缀/片段拦截（kind="adblock" 供日志标注）。
 * 注意：域名是否解析到私网由 createBrowserRequestChecker 的异步 DNS 层补判。
 */
export function createBrowserRequestPolicy(opts: BrowserRequestPolicyOptions = {}): BrowserRequestPolicy {
  // 严格模式通过环境变量全局收紧（发布版可默认开启，E2E/本地开发不设即可）
  const strictNet = process.env.LOOPSOAR_STRICT_NET === "1";
  const allowLoopback = (opts.allowLoopback ?? true) && !strictNet;
  const adBlockEnabled = (): boolean =>
    typeof opts.adBlock === "function" ? opts.adBlock() : opts.adBlock ?? true;

  return (rawUrl: string): BrowserRequestDecision => {
    let url: URL;
    try {
      url = new URL(String(rawUrl ?? ""));
    } catch {
      return block("无法解析的 URL");
    }
    // DevTools 前端/扩展内部资源：Chromium 自己的协议，网页 JS 无法伪造发起（不是 SSRF 面）；
    // 放行它们，否则 F12 调试器会因 ERR_BLOCKED_BY_CLIENT 打不开，扩展资源也可能被误杀。
    if (url.protocol === "devtools:" || url.protocol === "chrome-extension:" || url.protocol === "chrome:") {
      return allow();
    }
    if (!BROWSER_SAFE_PROTOCOLS.has(url.protocol)) {
      return block(`非浏览器安全协议（${url.protocol}）`);
    }
    if (url.username || url.password) {
      return block("URL 携带用户名/密码");
    }
    const host = url.hostname;
    if (!host) return block("URL 缺少主机名");

    // IP 字面量：不解析 DNS 就能定论（fail-closed：非回环且命中私网段即拒）
    if (isIpLiteral(host)) {
      if (isLoopbackIp(host)) {
        return allowLoopback ? allow() : block(`严格模式下拒绝回环地址 ${host}`);
      }
      if (isPrivateOrReservedIp(host)) return block(`拒绝私网/保留地址 ${host}`);
      return allow();
    }

    if (isLoopbackHostname(host)) {
      return allowLoopback ? allow() : block(`严格模式下拒绝回环主机名 ${host}`);
    }
    if (isBlockedHostname(host)) return block(`拒绝内部主机名 ${host}`);

    // 广告/追踪：放最后判——内网/危险地址的拦截原因优先展示（安全告警不被广告拦截掩盖）
    if (adBlockEnabled()) {
      const ad = matchAdBlockUrl(rawUrl);
      if (ad) return blockAd(ad);
    }
    return allow();
  };
}

/* ────────────────────────── 异步 DNS 校验（带缓存） ────────────────────────── */

export interface BrowserRequestCheckerOptions {
  /** DNS 解析（由装配层注入 node:dns 或测试桩）。 */
  resolveIps: (host: string) => Promise<string[]>;
  /** DNS 结果缓存时长；默认 5 分钟（页面高频请求同一域名时不重复解析）。 */
  cacheTtlMs?: number;
  /** URL 同步策略；默认 createBrowserRequestPolicy()。 */
  policy?: BrowserRequestPolicy;
  /** 缓存条目上限（LRU，防止恶意页面刷域名撑爆主进程内存）。 */
  maxCacheEntries?: number;
  /** 广告/追踪拦截开关（仅在未注入 policy 时用于构造默认策略；缺省 true）。 */
  adBlock?: boolean | (() => boolean);
}

export type BrowserRequestChecker = (url: string) => Promise<BrowserRequestDecision>;

interface CacheEntry {
  expiresAt: number;
  decision: BrowserRequestDecision;
}

/**
 * 创建异步请求校验器：先跑同步策略，再对域名做 DNS 校验（结果 LRU 缓存）。
 * 任何异常都走 fail-closed（拦截），绝不因解析失败而放行。
 */
export function createBrowserRequestChecker(options: BrowserRequestCheckerOptions): BrowserRequestChecker {
  const policy = options.policy ?? createBrowserRequestPolicy({ adBlock: options.adBlock });
  const cacheTtlMs = options.cacheTtlMs ?? 300_000;
  const maxCacheEntries = options.maxCacheEntries ?? 256;
  const cache = new Map<string, CacheEntry>();

  // 回环是否被允许：用策略自身对规范回环 URL 的判定反推，
  // 保证 DNS 层与 URL 层对「回环」态度一致（严格模式下两处都拒绝）。
  const loopbackAllowed =
    policy("http://127.0.0.1/").action === "allow" || policy("http://[::1]/").action === "allow";

  const readCache = (host: string): BrowserRequestDecision | null => {
    const hit = cache.get(host);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      cache.delete(host);
      return null;
    }
    // LRU：命中后移到队尾
    cache.delete(host);
    cache.set(host, hit);
    return hit.decision;
  };

  const writeCache = (host: string, decision: BrowserRequestDecision): void => {
    if (cache.size >= maxCacheEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(host, { expiresAt: Date.now() + cacheTtlMs, decision });
  };

  return async (rawUrl: string): Promise<BrowserRequestDecision> => {
    const decided = policy(rawUrl);
    if (decided.action === "block") return decided;

    // Chromium 内部协议（devtools:/chrome-extension:/chrome:）不参与 DNS 判定：同步策略已放行，
    // 这里不能再拿 hostname 去解析，否则 F12/扩展资源会被「无法解析主机名」误杀。
    try {
      const scheme = new URL(String(rawUrl ?? "")).protocol;
      if (!["http:", "https:", "ws:", "wss:"].includes(scheme)) return allow();
    } catch {
      // 交给下面统一处理
    }

    let url: URL;
    try {
      url = new URL(String(rawUrl ?? ""));
    } catch {
      return block("无法解析的 URL");
    }
    const host = url.hostname;
    if (isIpLiteral(host)) return allow(); // 同步策略已完整判定 IP 字面量

    const cached = readCache(host);
    if (cached) return cached;

    let ips: string[] = [];
    try {
      const list = await options.resolveIps(host);
      if (Array.isArray(list)) ips = list.map((ip) => String(ip ?? "").trim()).filter((ip) => ip.length > 0);
    } catch {
      ips = [];
    }

    let decision: BrowserRequestDecision;
    if (ips.length === 0) {
      decision = block(`无法解析主机名 ${host}`);
    } else if (ips.some((ip) => !isIpLiteral(ip))) {
      decision = block(`主机名 ${host} 解析出非法地址`);
    } else {
      const loopbacks = ips.filter((ip) => isLoopbackIp(ip));
      const internal = ips.find((ip) => !isLoopbackIp(ip) && isPrivateOrReservedIp(ip));
      if (internal) {
        decision = block(`主机名 ${host} 解析到私网/保留地址 ${internal}`);
      } else if (loopbacks.length > 0 && loopbacks.length !== ips.length) {
        // 同时解析出回环与公网：典型 DNS rebinding 特征，fail-closed
        decision = block(`主机名 ${host} 解析结果混有回环与非回环地址`);
      } else if (loopbacks.length > 0 && !loopbackAllowed) {
        decision = block(`严格模式下拒绝解析到回环的主机名 ${host}`);
      } else {
        decision = allow();
      }
    }
    writeCache(host, decision);
    return decision;
  };
}

/** 从请求 URL 提取主机名（供装配层写拦截日志；不打印完整 URL 的查询参数）。 */
export function browserRequestHost(rawUrl: string): string {
  return hostOf(rawUrl);
}
