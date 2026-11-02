/**
 * SSRF 判据（纯逻辑，零 node 依赖）。
 *
 * 为什么单独成模块：私网/保留地址判定被四处复用——websearch 抓取、platform 的 DNS 钉扎抓取、
 * 浏览器 webRequest 守卫、模型服务探测。若各自复制一份 CIDR 逻辑，任何一处漏段都是绕过口子。
 * 因此这里只做纯函数：URL 解析 + 主机名/协议/端口校验 + 15 段 CIDR 比对 + IPv6 展开/映射判定。
 * 真正发起连接（并钉扎到已校验 IP）由 platform 层负责，本模块不做 DNS、不联网。
 *
 * 安全取向：fail-closed —— 解析失败、DNS 返回空、IP 串畸形，一律按「危险」处理。
 */
import {
  MAX_REDIRECTS,
  PRIVATE_NET_RANGES,
  SSRF_ALLOWED_PORTS,
  SSRF_BLOCKED_HOSTNAMES,
} from "loopsoar-contracts/security-policy";

/** 契约中的私网/保留网段：IPv4 base 为四段，IPv6 base 为两段 16 位分组。 */
export interface PrivateNetRange {
  readonly v: 4 | 6;
  readonly base: readonly number[];
  readonly prefix: number;
}

/** SSRF 拦截错误的统一前缀：tool 层可直接把 message 展示给用户。 */
export const SSRF_ERROR_PREFIX = "SSRF 拦截：";

/** 可被上层单独捕获的 SSRF 拦截错误（message 仍是可读中文）。 */
export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(`${SSRF_ERROR_PREFIX}${message}`);
    this.name = "SsrfBlockedError";
  }
}

function block(message: string): never {
  throw new SsrfBlockedError(message);
}

/** 是否允许回环地址（默认不允许；本地模型服务/浏览器本地页面按调用方显式开启）。 */
export interface SsrfCheckOptions {
  allowLoopback?: boolean;
}

/** DNS 解析函数形状（由 platform 层注入，便于测试与替换）。 */
export type IpResolver = (host: string) => Promise<string[]>;

/* ────────────────────────────── IP 字面量解析 ────────────────────────────── */

function stripBrackets(host: string): string {
  const text = host.trim();
  return text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
}

/** IPv4 字面量 → 32 位无符号整数；非法返回 null（严格十进制，不接受八进制/短写，URL 已规范化）。 */
function parseIpv4(raw: string): number | null {
  const text = stripBrackets(raw);
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (parts.some((part) => part > 255)) return null;
  return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0);
}

/** IPv6 字面量 → 8 个 16 位分组；非法返回 null。支持 :: 压缩、IPv4 结尾、%zone。 */
function parseIpv6(raw: string): number[] | null {
  let text = stripBrackets(raw).toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone); // 链路本地 zone id（fe80::1%eth0）：去掉后按地址判定
  if (!text.includes(":")) return null;

  const halves = text.split("::");
  if (halves.length > 2) return null;

  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const segments = part.split(":");
    const out: number[] = [];
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      if (seg === "") return null; // ":::" 等畸形写法
      // 末段允许 IPv4 点分写法（如 ::ffff:127.0.0.1），展开成两个分组
      if (i === segments.length - 1 && seg.includes(".")) {
        const v4 = parseIpv4(seg);
        if (v4 === null) return null;
        out.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(seg)) return null;
      out.push(parseInt(seg, 16));
    }
    return out;
  };

  const head = parseGroups(halves[0]);
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = parseGroups(halves[1]);
  if (tail === null) return null;
  const zeros = 8 - head.length - tail.length;
  if (zeros < 1) return null;
  return [...head, ...new Array<number>(zeros).fill(0), ...tail];
}

function ipv4ToString(value: number): string {
  return `${(value >>> 24) & 0xff}.${(value >>> 16) & 0xff}.${(value >>> 8) & 0xff}.${value & 0xff}`;
}

/** 分组 → 压缩后的 IPv6 文本（连接用 host；不带方括号）。 */
function ipv6ToString(groups: number[]): string {
  if (groups.every((g) => g === 0)) return "::";
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < groups.length; ) {
    if (groups[i] !== 0) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < groups.length && groups[j] === 0) j += 1;
    if (j - i >= 2 && j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestStart < 0) return hex.join(":");
  const left = hex.slice(0, bestStart).join(":");
  const right = hex.slice(bestStart + bestLen).join(":");
  return `${left}::${right}`;
}

/** IPv4-mapped IPv6（::ffff:a.b.c.d）→ 点分 IPv4；不是映射地址返回 null。 */
function mappedIpv4(groups: number[]): string | null {
  for (let i = 0; i < 5; i += 1) if (groups[i] !== 0) return null;
  if (groups[5] !== 0xffff) return null;
  return ipv4ToString(((groups[6] << 16) | groups[7]) >>> 0);
}

/** 已废弃的 IPv4-compatible（::a.b.c.d，前 96 位全零，除 :: 与 ::1）→ 点分 IPv4。 */
function compatIpv4(groups: number[]): string | null {
  for (let i = 0; i < 6; i += 1) if (groups[i] !== 0) return null;
  if (groups[6] === 0 && groups[7] <= 1) return null;
  return ipv4ToString(((groups[6] << 16) | groups[7]) >>> 0);
}

/** 是否 IP 字面量（IPv4/IPv6；IPv6 允许带方括号）。用于「主机名判定」与「IP 判定」分流。 */
export function isIpLiteral(host: string): boolean {
  const text = String(host ?? "").trim();
  if (!text) return false;
  return parseIpv4(text) !== null || (text.includes(":") && parseIpv6(text) !== null);
}

/** IP 字面量 → 规范化文本（IPv4 点分 / IPv6 压缩形式）；非法返回 null。 */
export function normalizeIpLiteral(host: string): string | null {
  const v4 = parseIpv4(host);
  if (v4 !== null) return ipv4ToString(v4);
  const groups = parseIpv6(host);
  if (groups !== null) return ipv6ToString(groups);
  return null;
}

/* ────────────────────────────── 私网 / 保留地址判定 ────────────────────────────── */

/** IPv6 网段 base 还原成 8 个分组：prefix<=32 时 base 是前两组；更大前缀时 base 视为 [高64位,低64位]（契约中仅 ::1/128）。 */
function ipv6RangeBaseGroups(range: PrivateNetRange): number[] {
  const base = range.base;
  const groups = new Array<number>(8).fill(0);
  if (range.prefix <= 32) {
    groups[0] = base[0] ?? 0;
    groups[1] = base[1] ?? 0;
    return groups;
  }
  // ::1/128 在契约里写作 base=[0,1]，即「高 64 位 = 0，低 64 位 = 1」；按 128 位数值展开。
  const value = (BigInt(base[0] ?? 0) << 64n) | BigInt(base[1] ?? 0);
  for (let i = 0; i < 8; i += 1) {
    groups[i] = Number((value >> BigInt(112 - i * 16)) & 0xffffn);
  }
  return groups;
}

/** 前缀位逐步比对（不做字符串前缀，避免 7/10/128 这类非半字节前缀判错）。 */
function ipv6Matches(groups: number[], range: PrivateNetRange): boolean {
  const baseGroups = ipv6RangeBaseGroups(range);
  let remaining = range.prefix;
  for (let i = 0; i < 8 && remaining > 0; i += 1) {
    const bits = Math.min(16, remaining);
    const mask = bits >= 16 ? 0xffff : (0xffff << (16 - bits)) & 0xffff;
    if ((groups[i] & mask) !== (baseGroups[i] & mask)) return false;
    remaining -= bits;
  }
  return true;
}

function ipv4Matches(value: number, ranges: readonly PrivateNetRange[]): boolean {
  for (const range of ranges) {
    if (range.v !== 4) continue;
    const base = range.base;
    const baseValue = (((base[0] << 24) | (base[1] << 16) | (base[2] << 8) | base[3]) >>> 0);
    const mask = range.prefix <= 0 ? 0 : (0xffffffff << (32 - range.prefix)) >>> 0;
    if ((value & mask) === (baseValue & mask)) return true;
  }
  return false;
}

/** 契约 15 段之外的兜底保留地址（组播/保留/广播）：它们不是可抓取的公网单播目标。 */
function isExtraReservedIpv4(value: number): boolean {
  const top = (value >>> 28) & 0xf;
  return top === 0xe /* 224/4 组播 */ || top === 0xf /* 240/4 保留，含 255.255.255.255 广播 */;
}

/**
 * 纯函数：IP 命中私网/保留地址 → true（危险，需拒绝）。
 * 覆盖契约 15 段（含 ::1/fc00::/7/fe80::/10）、IPv4-mapped IPv6、IPv6 unspecified。
 * 非法 IP 字符串一律返回 true（fail-closed，调用方不必再判空）。
 */
export function isPrivateOrReservedIp(
  ip: string,
  ranges: readonly PrivateNetRange[] = PRIVATE_NET_RANGES,
): boolean {
  const text = String(ip ?? "").trim();
  if (!text) return true;

  const v4 = parseIpv4(text);
  if (v4 !== null) return ipv4Matches(v4, ranges) || isExtraReservedIpv4(v4);

  const groups = parseIpv6(text);
  if (groups === null) return true;
  // ::（unspecified）不是合法目的地，契约 15 段未覆盖，这里显式拦截
  if (groups.every((g) => g === 0)) return true;

  const mapped = mappedIpv4(groups);
  if (mapped !== null) {
    const mappedValue = parseIpv4(mapped) as number;
    return ipv4Matches(mappedValue, ranges) || isExtraReservedIpv4(mappedValue);
  }
  const compat = compatIpv4(groups);
  if (compat !== null) {
    const compatValue = parseIpv4(compat) as number;
    return ipv4Matches(compatValue, ranges) || isExtraReservedIpv4(compatValue);
  }
  for (const range of ranges) {
    if (range.v !== 6) continue;
    if (ipv6Matches(groups, range)) return true;
  }
  return false;
}

/** 是否回环地址（127.0.0.0/8、::1、以及映射/兼容形式的 127.x）。非法输入返回 false。 */
export function isLoopbackIp(ip: string): boolean {
  const text = String(ip ?? "").trim();
  const v4 = parseIpv4(text);
  if (v4 !== null) return (v4 >>> 24) === 127;
  const groups = parseIpv6(text);
  if (groups === null) return false;
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1
  const mapped = mappedIpv4(groups);
  if (mapped !== null) return (parseIpv4(mapped) as number) >>> 24 === 127;
  const compat = compatIpv4(groups);
  if (compat !== null) return (parseIpv4(compat) as number) >>> 24 === 127;
  return false;
}

/* ────────────────────────────── 主机名 / 端口判定 ────────────────────────────── */

const BLOCKED_HOSTNAMES = new Set<string>(SSRF_BLOCKED_HOSTNAMES as readonly string[]);
const ALLOWED_PORTS = new Set<number>(SSRF_ALLOWED_PORTS as readonly number[]);

/** 主机名规范化：小写 + 去尾部点（防 `localhost.` 这类绕过）。 */
export function normalizeHostname(host: string): string {
  const text = String(host ?? "").trim().toLowerCase();
  return text.replace(/\.+$/, "");
}

/** 回环主机名（localhost / *.localhost）；仅名字层面，不解析 DNS。 */
export function isLoopbackHostname(host: string): boolean {
  const normalized = normalizeHostname(host);
  return normalized === "localhost" || normalized.endsWith(".localhost");
}

/**
 * 纯函数：主机名是否内部/保留名 → true（应拒绝）。
 * 覆盖：localhost、*.local（mDNS）、云元数据黑名单、单标签内部名（无点的计算机名/intranet）。
 * IP 字面量不在这里判，交给 isPrivateOrReservedIp（调用方分流）。
 */
export function isBlockedHostname(host: string): boolean {
  const raw = String(host ?? "").trim();
  if (!raw) return true;
  if (isIpLiteral(raw)) return false; // IP 字面量交给 IP 判定
  const normalized = normalizeHostname(raw);
  if (!normalized) return true;
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  if (normalized === "local" || normalized.endsWith(".local")) return true;
  if (BLOCKED_HOSTNAMES.has(normalized)) return true;
  // 单标签名（无点）通常是内网主机名/容器名，一律拒绝
  if (!normalized.includes(".")) return true;
  return false;
}

/** 端口是否在契约白名单内（80/443/8080/8443）。 */
export function isAllowedPort(port: number): boolean {
  return ALLOWED_PORTS.has(port);
}

function effectivePort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

/* ────────────────────────────── 对外断言（抛可读中文错误） ────────────────────────────── */

/**
 * 断言一个 URL 是「可安全抓取的公网 http(s) URL」，返回解析后的 URL。
 * 校验：仅 http/https → 拒绝 userinfo → 内部主机名/私网 IP → 端口白名单（回环例外）。
 * allowLoopback=true 时放行 127.0.0.1/::1/localhost（本地模型服务、E2E 页面），端口不设限。
 */
export function assertPublicHttpUrl(rawUrl: string, opts: SsrfCheckOptions = {}): URL {
  const allowLoopback = opts.allowLoopback === true;
  const raw = String(rawUrl ?? "");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    block(`无法解析 URL（${raw.slice(0, 200) || "空"}）`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    block(`仅允许 http/https 协议（当前 ${url.protocol}）`);
  }
  if (url.username || url.password) {
    block("URL 不允许携带用户名/密码（userinfo）");
  }
  const host = url.hostname;
  if (!host) block("URL 缺少主机名");

  let loopbackTarget = false;
  if (isIpLiteral(host)) {
    if (isLoopbackIp(host)) {
      loopbackTarget = true;
      if (!allowLoopback) block(`拒绝访问回环地址 ${host}`);
    } else if (isPrivateOrReservedIp(host)) {
      block(`拒绝访问私网/保留地址 ${host}`);
    }
  } else if (isLoopbackHostname(host)) {
    loopbackTarget = true;
    if (!allowLoopback) block(`拒绝访问回环主机名 ${host}`);
  } else if (isBlockedHostname(host)) {
    block(`拒绝访问内部主机名 ${host}`);
  }

  // 回环目标由调用方显式放行时不限制端口（本地服务端口各异）；公网目标只允许常规 Web 端口
  if (!loopbackTarget || !allowLoopback) {
    const port = effectivePort(url);
    if (!isAllowedPort(port)) {
      block(`端口 ${port} 不在允许范围（${SSRF_ALLOWED_PORTS.join(" / ")}）`);
    }
  }
  return url;
}

/**
 * 断言 URL 公网可抓取，并在 DNS 解析后二次校验（防御 DNS rebinding：调用方应把连接钉扎到返回的 IP）。
 * 规则：解析结果为空 → 拒绝；任一 IP 命中私网/保留 → 拒绝（fail-closed，不做「有公网就放行」）。
 * allowLoopback=true 时回环 IP 放行（其余私网仍拒绝）。
 */
export async function assertPublicUrlWithDns(
  rawUrl: string,
  resolveIps: IpResolver,
  opts: SsrfCheckOptions = {},
): Promise<{ url: URL; ips: string[] }> {
  const allowLoopback = opts.allowLoopback === true;
  const url = assertPublicHttpUrl(rawUrl, opts);
  const host = url.hostname;

  if (isIpLiteral(host)) {
    const literal = normalizeIpLiteral(host);
    if (literal === null) block(`无法识别的主机地址 ${host}`);
    return { url, ips: [literal] };
  }

  let resolved: string[] = [];
  try {
    const list = await resolveIps(host);
    if (Array.isArray(list)) {
      resolved = list
        .map((item) => String(item ?? "").trim())
        .filter((item) => item.length > 0);
    }
  } catch {
    resolved = [];
  }
  if (resolved.length === 0) block(`无法解析主机名 ${host}`);

  const normalizedIps: string[] = [];
  for (const ip of resolved) {
    if (!isIpLiteral(ip)) block(`DNS 返回了非法地址（${String(ip).slice(0, 100)}）`);
    const normalized = normalizeIpLiteral(ip) as string;
    if (isLoopbackIp(normalized)) {
      if (!allowLoopback) block(`主机名 ${host} 解析到回环地址 ${normalized}`);
    } else if (isPrivateOrReservedIp(normalized)) {
      block(`主机名 ${host} 解析到私网/保留地址 ${normalized}`);
    }
    normalizedIps.push(normalized);
  }
  return { url, ips: normalizedIps };
}

/** 默认最大重定向次数（契约单一产地，供 platform 层直接复用）。 */
export { MAX_REDIRECTS };
