/**
 * 安全策略常量集合（唯一产地）。
 * 这些常量用于沙箱判定、敏感文件检查、私网范围对比、预算上限等安全控制。
 */

/**
 * 敏感文件名与模式列表。
 * 来源：安全审计清单（包括身份文件、私钥、配置加密、认证令牌等）。
 */
export const SENSITIVE_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".env",
  "id_rsa",
  "id_ed25519",
  "*.pem",
  "*.key",
  "config/providers.enc.json",
  "config/auth_token*",
];

/**
 * 受保护的源代码目录（禁止工具操作越界进入）。
 */
export const PROTECTED_SOURCE_DIRS = [
  ".git",
  "node_modules",
  "packages/contracts/gen",
];

/**
 * 私网 CIDR 数据（IPv4 与 IPv6），共 15 段。
 * 纯数据格式：v=4|6，base 为数字数组（v4 四段，v6 两段 [hi,lo]），prefix 为前缀长度。
 * 用于 websearch / sandbox 的 SSRF 检查。
 */
export const PRIVATE_NET_RANGES = [
  // RFC 1918：私有 IPv4 网络地址 10.0.0.0/8
  { v: 4 as const, base: [10, 0, 0, 0] as const, prefix: 8 },
  // RFC 1918：私有 IPv4 网络地址 172.16.0.0/12
  { v: 4 as const, base: [172, 16, 0, 0] as const, prefix: 12 },
  // RFC 1918：私有 IPv4 网络地址 192.168.0.0/16
  { v: 4 as const, base: [192, 168, 0, 0] as const, prefix: 16 },
  // RFC 3927：链路本地地址 169.254.0.0/16（自动私网配置 APIPA）
  { v: 4 as const, base: [169, 254, 0, 0] as const, prefix: 16 },
  // 回环地址 127.0.0.0/8
  { v: 4 as const, base: [127, 0, 0, 0] as const, prefix: 8 },
  // RFC 1122："本网络" 0.0.0.0/8
  { v: 4 as const, base: [0, 0, 0, 0] as const, prefix: 8 },
  // RFC 6598：运营商级 NAT（共享地址空间）100.64.0.0/10
  { v: 4 as const, base: [100, 64, 0, 0] as const, prefix: 10 },
  // RFC 6890：IETF 保留 192.0.0.0/24
  { v: 4 as const, base: [192, 0, 0, 0] as const, prefix: 24 },
  // RFC 5737：TEST-NET-1 192.0.2.0/24
  { v: 4 as const, base: [192, 0, 2, 0] as const, prefix: 24 },
  // RFC 2544：网络互连设备测试 198.18.0.0/15
  { v: 4 as const, base: [198, 18, 0, 0] as const, prefix: 15 },
  // RFC 5737：TEST-NET-2 198.51.100.0/24
  { v: 4 as const, base: [198, 51, 100, 0] as const, prefix: 24 },
  // RFC 5737：TEST-NET-3 203.0.113.0/24
  { v: 4 as const, base: [203, 0, 113, 0] as const, prefix: 24 },
  // IPv6 回环 ::1/128（base=[0,1] 表示 hi=0, lo=1 的大整数格式）
  { v: 6 as const, base: [0, 1] as const, prefix: 128 },
  // IPv6 唯一本地地址 fc00::/7（base=[64512, 0]，64512 = 0xfc00）
  { v: 6 as const, base: [64512, 0] as const, prefix: 7 },
  // IPv6 链路本地 fe80::/10（base=[65152, 0]，65152 = 0xfe80）
  { v: 6 as const, base: [65152, 0] as const, prefix: 10 },
] as const;

/**
 * 最大重定向次数（SSRF 与网络请求安全上限）。
 */
export const MAX_REDIRECTS = 5;

/**
 * 文件写入最大字节数（约 5 MB），防止写入爆炸。
 */
export const FILE_WRITE_MAX_BYTES = 5_242_880;

/**
 * 终端命令执行超时（30 秒）。
 */
export const TERMINAL_TIMEOUT_MS = 30_000;

/**
 * 终端输出最大字节数（约 8 MB），防止输出爆炸。
 */
export const TERMINAL_MAX_BYTES = 8_388_608;

/**
 * 心跳间隔（15 秒），用于长任务静默检测。
 */
export const HEARTBEAT_MS = 15_000;

/**
 * 预算硬上限（四闸封顶）。
 * 任何自定义循环只能收紧，不能超过此上限。
 */
export const BUDGET_HARD = {
  maxRounds: 500,
  maxToolCalls: 10_000,
  maxTotalTokens: 12_000_000,
  maxWallClockMs: 10_800_000, // 3 小时
} as const;

/**
 * 循环健康监控阈值（安全模式后备）。
 */
export const LOOP_HEALTH = {
  silentTimeoutMs: 90_000, // 自定义 loop runner 的静默超时（工具层默认不硬杀）
  /** 工具长时间无输出只提示、不中止（用户要求把大型任务的决定权交给 Agent）。 */
  silentWarnMs: 90_000,
  noProgressRounds: 5,     // 无进展轮次 5 轮
} as const;

/**
 * 默认显示行数限制。
 */
export const DISPLAY_LIMIT_DEFAULT = 1200;

/* ───────────────────────── 终端持久会话（P0 终端子系统） ───────────────────────── */

/** 同时存活的终端会话上限（每会话每环境一个，全应用封顶）。 */
export const TERMINAL_MAX_SESSIONS = 8;
/** 终端空闲回收时间（30 分钟无输入/输出即回收，防止进程泄漏）。 */
export const TERMINAL_IDLE_MS = 30 * 60 * 1000;
/** 单终端回放缓冲上限（512KB，超出丢弃最旧输出）。 */
export const TERMINAL_BUFFER_BYTES = 512 * 1024;
/** 终端原始输入单次上限（16KB）。 */
export const TERMINAL_INPUT_MAX_BYTES = 16_384;

/* ───────────────────────── 网络安全（SSRF / DNS 钉扎） ───────────────────────── */

/**
 * SSRF 主机名黑名单：IP 段之外的内部名称别名（解析前后都要判）。
 * 为什么还要黑名单：部分云元数据服务用固定内部域名，只判 IP 段会漏。
 */
export const SSRF_BLOCKED_HOSTNAMES = [
  "localhost",
  "metadata",
  "metadata.google.internal",
  "instance-data",
] as const;

/** SSRF：禁止的端口之外，仅允许这些显式端口直连（80/443 为常规 Web）。 */
export const SSRF_ALLOWED_PORTS = [80, 443, 8080, 8443] as const;

/* ───────────────────────── 广告/追踪拦截（浏览器功能面 MVP） ───────────────────────── */

/**
 * 广告/追踪域名后缀（webRequest 请求层拦截；子域命中即拦截）。
 * 为什么用后缀而不是正则：请求量大，后缀匹配 O(1) 且易审计；误杀可通过设置整体开关规避。
 */
export const AD_BLOCK_HOST_SUFFIXES = [
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "google-analytics.com",
  "googletagmanager.com",
  "googletagservices.com",
  "adservice.google.com",
  "amazon-adsystem.com",
  "adsystem.amazon.com",
  "scorecardresearch.com",
  "quantserve.com",
  "outbrain.com",
  "taboola.com",
  "criteo.com",
  "criteo.net",
  "adsrvr.org",
  "pubmatic.com",
  "rubiconproject.com",
  "openx.net",
  "adnxs.com",
  "moatads.com",
  "zedo.com",
  "serving-sys.com",
  "2mdn.net",
  "adform.net",
  "smartadserver.com",
  "casalemedia.com",
  "sharethrough.com",
  "teads.tv",
  "tremorhub.com",
  "3lift.com",
  "bidswitch.net",
  "sitescout.com",
  "mathtag.com",
  "agkn.com",
  "krxd.net",
  "bluekai.com",
  "demdex.net",
  "omtrdc.net",
  "everesttech.net",
] as const;

/** 广告/追踪 URL 片段（路径级补充；后缀不命中的常见追踪端点）。 */
export const AD_BLOCK_URL_PATTERNS = [
  "/ads/",
  "/adserver/",
  "/advert/",
  "/analytics.js",
  "/gtag/js",
  "/collect?v=",
  "/pagead/",
  "/pixel.gif",
  "/tracker/",
  "/telemetry/",
] as const;

/* ───────────────────────── 文件 IPC ───────────────────────── */

/** 文件读取 IPC 单次最大字节数（约 5MB，防止一次拉爆主进程）。 */
export const FILE_READ_MAX_BYTES = 5_242_880;
