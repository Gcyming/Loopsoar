/**
 * 敏感步骤分类器（纯逻辑，零 IO、零副作用）。
 *
 * 为什么需要「写死确认」：权限策略（设置·权限）是用户按**类别**给的长期授权（如 network=allow），
 * 但「登录 / 支付 / 不可撤销操作」一旦误触发代价不可逆——这类动作必须在**每一次执行前**单独确认，
 * 不能被类别策略或「本次会话总是允许」绕过。本模块只做判定（sensitive/category/reason），
 * 确认流程与挂起结算由 services/chat.ts 的执行器 + PermRequestBus 承担。
 *
 * 判据边界（有意保守，宁可多确认一次，也不放过不可撤销动作）：
 *   1. 只分类「动作型工具」：browser_click / browser_type / browser_navigate / terminal_run。
 *      只读工具（browser_snapshot / file_read）永不敏感——否则页面上出现「登录」二字就弹窗。
 *   2. 拉丁词按词边界匹配：`designing` 不算 sign in、`payload` 不算 pay、`rm-notes.txt` 不算 rm。
 *   3. browser_navigate 只看 host + pathname，忽略 query/hash——否则搜索「pay」也会被当成支付。
 *   4. 终端命令复用 hard_rules 的 10 条危险规则，再补「数据删除 / 强制推送 / 系统操作」语义；
 *      单文件 `rm file`（无 -f/-r）与 `npm rm` 这类包管理删除不升级为敏感，避免日常命令全变确认。
 *   5. 归一化：NFKC（全角→半角）、去零宽字符、折叠空白、小写；中文按归一化后整串包含，
 *      并显式豁免「注册表 / 注册中心 / 密码学」等明显非账号语境的短语，降低误报。
 */
import { hardRuleCheck } from "./tools/hard_rules.js";

/** 敏感类别：登录/账号、支付/交易、不可撤销操作。 */
export type SensitiveCategory = "login" | "payment" | "irreversible";

/** 类别的中文标签（reason 与 UI 展示共用，避免各处各写一份文案）。 */
export const SENSITIVE_CATEGORY_LABELS: Record<SensitiveCategory, string> = {
  login: "登录/账号",
  payment: "支付/交易",
  irreversible: "不可撤销操作",
};

export interface SensitiveStepInput {
  /** 工具名（大小写不敏感）。 */
  toolName: string;
  /** 工具参数（browser_click 的 target/text、browser_type 的 text、terminal_run 的 command…）。 */
  params?: unknown;
  /** 显式 URL（browser_navigate 也可从 params.url 取，两者都看）。 */
  url?: string;
}

export interface SensitiveStepVerdict {
  sensitive: boolean;
  category: SensitiveCategory | null;
  /** 人读原因，形如「敏感步骤：支付/交易（命中「支付」）」；非敏感时缺省。 */
  reason?: string;
}

/** 会被分类的动作型工具（其余工具一律不敏感）。 */
export const SENSITIVE_ACTION_TOOLS = ["browser_click", "browser_type", "browser_navigate", "terminal_run"] as const;

/** 扫描参数的硬上限：防止把超大工具入参（整页 HTML）当文本扫。 */
const MAX_SCAN_CHARS = 8_000;
const MAX_SCAN_ITEMS = 40;
const MAX_DEPTH = 3;

const ZERO_WIDTH_RE = /[\u200b-\u200f\u2060\ufeff]/g;

/** 明显非账号语境的豁免短语（原文先归一化再按包含匹配）。 */
const EXEMPT_PHRASES = ["注册表", "注册中心", "注册机", "密码学", "密码本", "密码算法"];

/** 文本归一化：NFKC（全角→半角）→ 去零宽 → 折叠空白 → 小写。 */
export function normalizeSensitiveText(raw: string): string {
  return String(raw ?? "")
    .normalize("NFKC")
    .replace(ZERO_WIDTH_RE, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** 拉丁词边界包装：前后不得是字母/数字，避免子串误报（designing / payload）。 */
function latinWord(pattern: string): RegExp {
  return new RegExp(`(?<![a-z0-9])(?:${pattern})(?![a-z0-9])`);
}

interface LatinRule {
  category: SensitiveCategory;
  token: string;
  re: RegExp;
}

interface CjkRule {
  category: SensitiveCategory;
  token: string;
}

/** 拉丁规则（匹配在 normalizeSensitiveText 之后的文本上，故无需 /i）。 */
const LATIN_RULES: readonly LatinRule[] = [
  // 不可撤销
  { category: "irreversible", token: "unsubscribe", re: latinWord("un[-_ ]?subscribe") },
  { category: "irreversible", token: "delete account", re: latinWord("delete[-_ ]?(?:my[-_ ]?)?account") },
  { category: "irreversible", token: "deactivate account", re: latinWord("(?:deactivate|close)[-_ ]?(?:my[-_ ]?)?account") },
  { category: "irreversible", token: "wipe/erase all", re: latinWord("wipe|erase[-_ ]?all") },
  // 支付/交易
  { category: "payment", token: "pay/payment", re: latinWord("pay|payment|payments") },
  { category: "payment", token: "checkout", re: latinWord("checkout|check[-_ ]?out") },
  { category: "payment", token: "purchase", re: latinWord("purchase|buy[-_ ]?now") },
  { category: "payment", token: "transfer/remit", re: latinWord("transfer|remit(?:tance)?") },
  { category: "payment", token: "billing", re: latinWord("billing") },
  { category: "payment", token: "recharge/top-up", re: latinWord("recharge|top[-_ ]?up") },
  { category: "payment", token: "subscribe", re: latinWord("subscribe|subscription") },
  // 登录/账号
  { category: "login", token: "log in/login", re: latinWord("log[-_ ]?in") },
  { category: "login", token: "sign in", re: latinWord("sign[-_ ]?in") },
  { category: "login", token: "sign up", re: latinWord("sign[-_ ]?up") },
  { category: "login", token: "register", re: latinWord("register") },
  { category: "login", token: "password", re: latinWord("password|passwd|passcode") },
  { category: "login", token: "2FA/OTP", re: latinWord("2fa|otp") },
];

/** 中文规则（匹配在紧凑串 compact 上，无需词边界）。 */
const CJK_RULES: readonly CjkRule[] = [
  { category: "irreversible", token: "删除账户" },
  { category: "irreversible", token: "删除账号" },
  { category: "irreversible", token: "注销账户" },
  { category: "irreversible", token: "注销账号" },
  { category: "irreversible", token: "注销" },
  { category: "irreversible", token: "退订" },
  { category: "payment", token: "确认订单" },
  { category: "payment", token: "支付" },
  { category: "payment", token: "付款" },
  { category: "payment", token: "购买" },
  { category: "payment", token: "下单" },
  { category: "payment", token: "转账" },
  { category: "payment", token: "汇款" },
  { category: "payment", token: "充值" },
  { category: "login", token: "登录" },
  { category: "login", token: "登陆" },
  { category: "login", token: "注册" },
  { category: "login", token: "密码" },
  { category: "login", token: "验证码" },
];

/** 类别判定优先级：不可撤销 > 支付 > 登录（一条文本同时命中时按更严重的报）。 */
const CATEGORY_ORDER: readonly SensitiveCategory[] = ["irreversible", "payment", "login"];

function verdict(category: SensitiveCategory, reason: string): SensitiveStepVerdict {
  return { sensitive: true, category, reason };
}

/** 命中 → 生成统一 reason：`敏感步骤：<类别>（<细节>）`。 */
function hit(category: SensitiveCategory, detail: string): SensitiveStepVerdict {
  return verdict(category, `敏感步骤：${SENSITIVE_CATEGORY_LABELS[category]}（${detail}）`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** 收集参数里的全部字符串（限深/限量/限长），用于文本类工具的多字段扫描。 */
function collectStrings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > MAX_DEPTH || value == null) return out;
  if (typeof value === "string") {
    if (out.length < MAX_SCAN_ITEMS && out.join(" ").length < MAX_SCAN_CHARS) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, MAX_SCAN_ITEMS)) collectStrings(item, out, depth + 1);
    return out;
  }
  const rec = asRecord(value);
  if (rec) {
    for (const item of Object.values(rec).slice(0, MAX_SCAN_ITEMS)) collectStrings(item, out, depth + 1);
  }
  return out;
}

/** 去掉豁免短语后的紧凑串（中文用）。 */
function compactForCjk(spaced: string): string {
  let text = spaced.replace(/\s+/g, "");
  for (const phrase of EXEMPT_PHRASES) text = text.split(phrase).join(" ");
  return text;
}

/** 文本命中：优先级 irreversible > payment > login；先中文（含全半角归一化）再拉丁词边界。 */
function matchText(raw: string): SensitiveStepVerdict {
  const spaced = normalizeSensitiveText(raw);
  if (!spaced) return { sensitive: false, category: null };
  const compact = compactForCjk(spaced);
  for (const category of CATEGORY_ORDER) {
    const cjk = CJK_RULES.find((rule) => rule.category === category && compact.includes(rule.token));
    if (cjk) return hit(category, `命中「${cjk.token}」`);
    const latin = LATIN_RULES.find((rule) => rule.category === category && rule.re.test(spaced));
    if (latin) return hit(category, `命中「${latin.token}」`);
  }
  return { sensitive: false, category: null };
}

/** browser_click / browser_type：扫描 selector / text / placeholder / aria-label 等全部字符串参数。 */
function classifyBrowserAction(params: unknown): SensitiveStepVerdict {
  const text = collectStrings(params).join(" \n ");
  return matchText(text);
}

interface UrlTarget {
  hostLabels: string[];
  pathTokens: string[];
}

/** URL → 主机标签 + 路径词（路径按非字母数字切词，`payment-api` 也算 payment）。 */
function parseUrlTarget(rawUrl: string): UrlTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
  } catch {
    return null;
  }
  const hostLabels = parsed.hostname.toLowerCase().split(".").filter(Boolean);
  let pathname = parsed.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // 保留原样：非法编码按原始 pathname 匹配
  }
  const pathTokens = pathname
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return { hostLabels, pathTokens };
}

/** 域名标签 / 路径词的敏感判定（忽略 query 与 hash）。 */
const HOST_LABELS: Record<SensitiveCategory, readonly string[]> = {
  irreversible: ["unsubscribe", "delete-account", "close-account"],
  payment: ["pay", "payment", "payments", "checkout", "billing", "paypal", "alipay", "stripe", "braintree", "adyen"],
  login: ["login", "signin", "sign-in", "auth", "accounts", "account", "sso", "idp", "secure", "passport"],
};

const PATH_TOKENS: Record<SensitiveCategory, readonly string[]> = {
  irreversible: ["unsubscribe", "delete", "deactivate", "close"],
  payment: [
    "pay",
    "payment",
    "payments",
    "checkout",
    "purchase",
    "order",
    "orders",
    "billing",
    "transfer",
    "remittance",
    "subscribe",
    "subscription",
    "recharge",
    "topup",
  ],
  login: ["login", "signin", "signup", "register", "auth", "oauth", "authorize", "password", "passwd", "sso", "mfa", "2fa"],
};

function classifyUrl(rawUrl: string): SensitiveStepVerdict {
  const target = parseUrlTarget(rawUrl);
  if (!target) {
    // 解析不了就当文本处理，但先剥掉 query，避免 ?q=pay 误报
    return matchText(rawUrl.split(/[?#]/)[0]);
  }
  for (const category of CATEGORY_ORDER) {
    const label = target.hostLabels.find((item) => HOST_LABELS[category].includes(item));
    if (label) return hit(category, `域名含「${label}」`);
    const token = target.pathTokens.find((item) => PATH_TOKENS[category].includes(item));
    if (token) return hit(category, `路径含「${token}」`);
  }
  return { sensitive: false, category: null };
}

/** browser_navigate：看 URL（host+path）；没有 URL 时退回文本匹配（去掉 url 本身以免查参误报）。 */
function classifyNavigate(input: SensitiveStepInput): SensitiveStepVerdict {
  const rec = asRecord(input.params);
  const explicit = typeof input.url === "string" ? input.url.trim() : "";
  const fromParams = typeof rec?.url === "string" ? rec.url.trim() : "";
  const rawUrl = explicit || fromParams;
  if (rawUrl) {
    const byUrl = classifyUrl(rawUrl);
    if (byUrl.sensitive) return byUrl;
  }
  const rest = collectStrings(rec ? { ...rec, url: undefined } : input.params).join(" \n ");
  return matchText(rest);
}

const TERMINAL_RULES: readonly { token: string; re: RegExp }[] = [
  { token: "rm 递归/强制", re: /\brm\s+(?:-[a-z]*[rf][a-z]*\s+)+/ },
  { token: "rmdir /s", re: /\brmdir\s+(?:\/[a-z]*s|\/q)/ },
  { token: "del 永久删除", re: /\bdel\s+(?:\/[a-z]+\s+)*[^\s|&;<>]+/ },
  { token: "Remove-Item 递归/强制", re: /\b(?:remove-item|ri)\b[^|]*-(?:recurse|force)/ },
  { token: "format 磁盘", re: /\bformat\s+[a-z]:/ },
  { token: "mkfs/diskpart", re: /\b(?:mkfs|diskpart)\b/ },
  { token: "dd 写盘", re: /\bdd\s+if=/ },
  { token: "关机/重启", re: /\b(?:shutdown|reboot|poweroff|halt|stop-computer|restart-computer)\b/ },
  { token: "DROP DATABASE/TABLE", re: /\bdrop\s+(?:database|schema|table)\b/ },
  { token: "TRUNCATE TABLE", re: /\btruncate\s+table\b/ },
  { token: "DELETE FROM", re: /\bdelete\s+from\b/ },
  { token: "git push --force", re: /\bgit\s+push\b[^|]*\s(?:--force|-f)\b/ },
  { token: "git reset --hard", re: /\bgit\s+reset\s+--hard\b/ },
  { token: "git clean -fdx", re: /\bgit\s+clean\s+-[a-z]*[fdx]/ },
  { token: "reg delete", re: /\breg\s+delete\b/ },
  { token: "cipher /w", re: /\bcipher\s+\/w/ },
  { token: "bcdedit", re: /\bbcdedit\b/ },
  { token: "curl|bash 管道执行", re: /\b(?:curl|wget)\s+[^|]*\|\s*(?:bash|sh|zsh)\b/ },
];

/** terminal_run：hard_rules（10 条危险规则）优先，再补语义规则；单文件 rm / npm rm 不升级。 */
function classifyTerminal(params: unknown): SensitiveStepVerdict {
  const rec = asRecord(params);
  const command =
    typeof rec?.command === "string"
      ? rec.command
      : typeof rec?.cmd === "string"
        ? rec.cmd
        : collectStrings(params).join(" ");
  const spaced = normalizeSensitiveText(command);
  if (!spaced) return { sensitive: false, category: null };
  const hard = hardRuleCheck(spaced);
  if (hard.blocked) {
    return hit("irreversible", hard.reason ?? "命中危险命令规则");
  }
  for (const rule of TERMINAL_RULES) {
    if (rule.re.test(spaced)) return hit("irreversible", `命令匹配「${rule.token}」`);
  }
  return { sensitive: false, category: null };
}

/**
 * 入口：判定一次工具调用是否属于敏感步骤。
 * 非动作型工具、参数为空、全部规则未命中 → `{sensitive:false, category:null}`。
 */
export function classifySensitiveStep(input: SensitiveStepInput): SensitiveStepVerdict {
  const toolName = normalizeSensitiveText(input?.toolName ?? "");
  if (!toolName || !(SENSITIVE_ACTION_TOOLS as readonly string[]).includes(toolName)) {
    return { sensitive: false, category: null };
  }
  if (toolName === "terminal_run") return classifyTerminal(input.params);
  if (toolName === "browser_navigate") return classifyNavigate(input);
  return classifyBrowserAction(input.params);
}
