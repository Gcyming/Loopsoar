/**
 * 浏览器工具集（Agent 的"手和眼"）：把 BrowserHost 的适配层能力注册为工具。
 *
 * 设计约束：
 *   · 只依赖 BrowserHost 的公开方法（不 import electron）；无 IPC 变化；
 *   · 权限按类别声明：读取页面 read；浏览器动作（导航/点击/输入/按键/滚动/标签…）browser
 *     （策略层独立档，默认 allow：会话「浏览器控制」开关已是显式授权；登录/支付/不可撤销动作仍逐次强制确认）；
 *     直接抓取 URL 的 web_fetch 不是浏览器操控，保持 network（默认每次确认）；
 *   · 输出限制大小（模型上下文友好），错误返回 ok:false 而不是抛异常。
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NetAdapter } from "loopsoar-core/platform";
import { classifySensitiveStep } from "loopsoar-core/sensitiveSteps";
import { agentLoopbackAllowed, isLoopbackTarget } from "./browserRequestGuard.js";
import type { ToolRegistry, ToolResult } from "loopsoar-core/tools/registry";
import type { BrowserBackend } from "./browserBackend.js";
import type { TabState } from "./browserHost.js";
import type { BrowserElementSnapshot } from "../browserAdapter/types.js";
import {
  MAX_VISIBLE_ELEMENTS,
  NAMED_KEYS,
  dropTabRegistry,
  getTabRegistry,
  isSupportedKey,
  buildDismissOverlayScript,
  buildFocusProbeScript,
  normalizeRef,
  performClick,
  performHover,
  performPressKey,
  performScrollIntoView,
  performSelect,
  performTargetPoint,
  performFocusCheck,
  performFocus,
  performType,
  performTypeReadback,
  type RefRegistry,
} from "../browserAdapter/refs.js";

const MAX_TEXT = 8000;
/** 标签列表最多展示多少条（超出只报剩余数量，防多标签会话刷屏）。 */
const MAX_TABS_SHOWN = 12;
/** 动作后的短探测窗口：捕获点击后立即开始的主框架导航。 */
const STATUS_PROBE_MS = 120;
/** 加载中轮询间隔与最长等待：命中即返回，不无谓等待。 */
const STATUS_POLL_MS = 100;
const STATUS_SETTLE_MAX_MS = 1500;

/**
 * 会话 → 标签 → 最近一次快照的令牌（键 `${sessionId}::${tabId}`）。
 *
 * 为什么不沿用会话级单键：BrowserHost.snapshot() 认的是**活动标签**，
 * 用户手动切标签后，会话级令牌会把旧 ref 解析到另一标签的注册表（串页）。
 * 改成标签级绑定后，动作只认「当前动作目标标签」的注册表，
 * 目标标签与产生令牌的标签不一致时返回可行动的 STALE_REF。
 */
const snapshotTokens = new Map<string, string>();
/** 会话 → 最近一次快照的标签 id（诊断文案「引用来自标签 A」用）。 */
const lastSnapshotTab = new Map<string, string>();
/** 绑定表上限：UI 关页/删会话不会回调这里，必须自带上限防长期浏览后无界增长。 */
const MAX_SNAPSHOT_BINDINGS = 512;

function trimSnapshotBindings(): void {
  while (snapshotTokens.size > MAX_SNAPSHOT_BINDINGS) {
    const oldest = snapshotTokens.entries().next().value as [string, string] | undefined;
    if (!oldest) break;
    snapshotTokens.delete(oldest[0]);
    dropTabRegistry(oldest[1]);
  }
  while (lastSnapshotTab.size > MAX_SNAPSHOT_BINDINGS) {
    const oldest = lastSnapshotTab.keys().next().value as string | undefined;
    if (!oldest) break;
    lastSnapshotTab.delete(oldest);
  }
}

function tokenKey(sessionId: string | undefined, tabId: string | null | undefined): string {
  return `${sessionId ?? ""}::${tabId ?? ""}`;
}

/** 目标标签（缺省活动标签）；宿主未提供 activeTabId（老实现/测试假件）时返回 null。 */
function activeTabOf(host: BrowserBackend, sessionId?: string): string | null {
  try {
    return typeof host.activeTabId === "function" ? host.activeTabId(sessionId) : null;
  } catch {
    return null;
  }
}

function registryFor(sessionId: string | undefined, tabId: string | null | undefined): RefRegistry | null {
  return getTabRegistry(snapshotTokens.get(tokenKey(sessionId, tabId)));
}

/**
 * ref 与标签的绑定校验：目标标签没有快照令牌、而本会话最近快照来自另一个标签时，
 * 直接给出可行动的 STALE_REF（说明是哪两个标签），而不是让注册表解析到别人的元素。
 * CSS / text= 不需要注册表，不参与该校验。
 */
function bindRefToTab(
  sessionId: string | undefined,
  tabId: string | null,
  target: string,
): { ok: boolean; message?: string } {
  if (!normalizeRef(target)) return { ok: true };
  if (registryFor(sessionId, tabId)) return { ok: true };
  const last = lastSnapshotTab.get(sessionId ?? "");
  if (last && tabId && last !== tabId) {
    return {
      ok: false,
      message: `[STALE_REF] 引用来自标签 ${last}，当前操作标签是 ${tabId}，请先在该标签重新 browser_snapshot 后再用最新 #eN`,
    };
  }
  // 同一标签但令牌缺失/从未快照：交给 resolveTarget 给出标准 STALE_REF
  return { ok: true };
}

/** 一个标签的即时状态（动作前记快照、动作后算增量）。 */
interface TabStatus {
  id: string;
  url: string;
  title: string;
  loading: boolean;
}

interface SettledState {
  tab: TabStatus | null;
  navigated: boolean;
}

/** 读标签状态；宿主没有 getTab / 标签已消失时返回 null（状态行降级，不抛错）。 */
function readTab(host: BrowserBackend, sessionId: string | undefined, tabId: string | null): TabStatus | null {
  if (!tabId) return null;
  const getter = (host as unknown as { getTab?: (sessionId?: string, tabId?: string) => TabState | null }).getTab;
  if (typeof getter !== "function") return null;
  try {
    const tab = getter.call(host, sessionId, tabId);
    if (!tab) return null;
    return { id: tab.id, url: tab.url, title: tab.title, loading: Boolean(tab.loading) };
  } catch {
    return null;
  }
}

/**
 * 动作后状态增量（调研 §8-4）：最多等 1.5s 让加载落定。
 *  · 先做一次 120ms 短探测：点击同步触发的导航可能还没反映到宿主状态；
 *  · 一旦命中 loading=false 立即返回，不做无谓等待；
 *  · 「发生导航」= URL 变化，或本次动作让标签进入加载。
 */
async function settleTab(
  host: BrowserBackend,
  sessionId: string | undefined,
  tabId: string | null,
  before: TabStatus | null,
): Promise<SettledState> {
  let tab = readTab(host, sessionId, tabId);
  if (!tab) return { tab: null, navigated: false };
  let navigated = Boolean(before && before.url !== tab.url);
  if (before && !tab.loading && !navigated) {
    await sleep(STATUS_PROBE_MS);
    const probed = readTab(host, sessionId, tabId);
    if (probed) {
      tab = probed;
      navigated = before.url !== tab.url;
    }
  }
  const startedLoading = Boolean(tab.loading && !before?.loading);
  const deadline = Date.now() + STATUS_SETTLE_MAX_MS;
  while (tab.loading && Date.now() < deadline) {
    await sleep(STATUS_POLL_MS);
    const next = readTab(host, sessionId, tabId);
    if (!next) break;
    tab = next;
  }
  return { tab, navigated: navigated || startedLoading };
}

/**
 * 紧凑状态行：`[状态] ✓ 已点击 [#e3] button "提交" | URL … | 标题 … | 已就绪 | 发生导航`。
 * 只给状态不给完整快照（省 token）；发生导航时补一句「可 browser_snapshot」。
 */
function statusLine(action: string, state: SettledState, note?: string): string {
  const parts = [`[状态] ✓ ${action}`];
  if (state.tab) {
    parts.push(`URL ${state.tab.url || "（空白）"}`);
    parts.push(`标题 ${state.tab.title || "（无标题）"}`);
    parts.push(state.tab.loading ? "仍在加载" : "已就绪");
    parts.push(state.navigated ? "发生导航" : "未发生导航");
    if (note) parts.push(note);
  } else {
    parts.push(note ?? "标签状态不可读");
  }
  const hint = state.tab && state.navigated ? "\n页面已变化，可 browser_snapshot 查看新页面。" : "";
  return `${parts.join(" | ")}${hint}`;
}

/** 标签列表：index / tabId / 标题 / URL / active 标记。 */
function formatTabList(tabs: TabState[]): string {
  if (tabs.length === 0) return "标签：0 个（当前会话没有打开的网页）";
  const active = tabs.find((tab) => tab.active);
  const shown = tabs.slice(0, MAX_TABS_SHOWN);
  const lines = shown.map((tab, index) => {
    const mark = tab.active ? " ✓ 活动" : "";
    const state = tab.loading ? "（加载中）" : "";
    const body = tab.url ? `${tab.title || "（无标题）"} ${tab.url}` : "（空白标签）";
    return `${index + 1}. ${tab.id}${mark} ${body}${state}`;
  });
  const omitted = tabs.length - shown.length;
  const more = omitted > 0 ? `\n…还有 ${omitted} 个未显示` : "";
  return `标签（${tabs.length} 个，活动 ${active?.id ?? "无"}）：\n${lines.join("\n")}${more}`;
}

/** 一行元素：`[#e2] textbox "搜索" (value="")`；状态进括号，链接末尾给 href。 */
function formatElement(el: BrowserElementSnapshot): string {
  const name = el.name.length > 60 ? `${el.name.slice(0, 60)}…` : el.name;
  const namePart = name ? ` "${name}"` : "";
  const flags: string[] = [];
  if (el.value !== undefined) flags.push(`value=${JSON.stringify(el.value.length > 60 ? el.value.slice(0, 60) + "…" : el.value)}`);
  if (el.disabled) flags.push("disabled");
  if (el.checked !== undefined) flags.push(el.checked ? "checked" : "unchecked");
  const suffix = flags.length ? ` (${flags.join(", ")})` : "";
  const href = el.href ? ` → ${el.href.length > 80 ? el.href.slice(0, 80) + "…" : el.href}` : "";
  return `[#${el.ref}] ${el.role}${namePart}${suffix}${href}`;
}

function clip(text: string, max = MAX_TEXT): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[已截断，共 ${text.length} 字符]`;
}

/** 等待指定毫秒（browser_wait 轮询用）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** 读 PNG IHDR 的宽高（截图尺寸展示用）；非 PNG 返回 null。 */
function readPngSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24) return null;
  if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return null;
  if (buffer.subarray(12, 16).toString("ascii") !== "IHDR") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** 截图文件名时间戳（本地时间 YYYYMMDD-HHmmss）。 */
function screenshotStamp(): string {
  const date = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** 极简 HTML → 文本（仅用于 web_fetch 的兜底可读化）。 */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 点击前的敏感判定（纯函数，可单测）：把「定位后拿到的元素文案」纳入分类。
 *
 * 为什么单独抽出来：`#e12` 这类 ref 本身不含任何语义，策略层按参数扫描必然判不出
 * 「立即支付 / 确认转账 / 删除账户」，只有 label 才能判。返回 null = 不敏感。
 */
export function sensitiveClickReason(target: string, label: string): string | null {
  const verdict = classifySensitiveStep({
    toolName: "browser_click",
    params: { target, label, text: label },
  });
  return verdict.sensitive ? (verdict.reason ?? "敏感步骤需要确认") : null;
}

/** 焦点探测结果 → 人读描述（供敏感判定与确认文案）。 */
export function describeFocusProbe(raw: unknown): string | null {
  const probe = raw as { ok?: boolean; tag?: string; type?: string; role?: string; name?: string } | null;
  if (!probe?.ok) return null;
  const tag = probe.tag || "element";
  const type = probe.type ? `[${probe.type}]` : "";
  const role = probe.role && probe.role !== tag ? ` ${probe.role}` : "";
  const head = `${tag}${type}${role}`;
  return probe.name ? `${head} "${probe.name}"` : head;
}

/**
 * 浏览器工具钩子（第二阶段 Slice E）。
 *
 * 为什么用「可选第四参」而不是改 register 流程：不传钩子时行为必须与之前**完全一致**
 * （既有测试与调用点只传前三个参数），钩子只是给壳层一个「真正导航之前」的插入点。
 */
export interface BrowserToolHooks {
  /**
   * 打开网页之前的最后一道人机确认（会话窗口布局询问）。
   *   · proceed=false → 不导航（fail-closed），内容为 "[已取消] note"；
   *   · proceed=true 且有 note → 在成功状态行后追加一行（说明本次布局安排）。
   * 只有 browser_navigate 挂钩子：本片只拦「打开网页」，browser_tabs new 保持原样（面收敛）。
   */
  beforeOpenPage?: (args: { sessionId?: string; url: string }) => Promise<{ proceed: boolean; note?: string }>;
  /**
   * 敏感步骤二次确认：在**解析出元素真实文案之后**由工具内部发起。
   *
   * 为什么必须在工具内部：`browser_click` 的 schema 只有 `target`，模型主路径传的是 `#e12`，
   * 策略层（services/chat.ts）按参数扫描根本看不到「立即支付」这类文案，敏感闸对 ref 点击等于失明。
   * 只有定位成功、拿到 `label` 之后才判得出，所以确认点只能在点击前一步。
   * 约定：返回 false / 抛错 / 超时一律按拒绝处理（fail-closed，不点击）；未提供钩子时同样拒绝。
   */
  confirmSensitive?: (args: {
    sessionId?: string;
    tool: string;
    label: string;
    reason: string;
    /** 产生这次动作的页面地址（用户要能看清自己在批准哪一页上的操作）。 */
    url?: string;
  }) => Promise<boolean>;
  /**
   * Agent 指针覆盖层（主进程里的透明子窗口，压在网页视图之上）。
   * 动作前把「鼠标」移到目标并画高亮/涟漪/键盘提示；坐标是覆盖层坐标（页面 CSS 像素 × 缩放）。
   * 调用方只在本会话网页可见时调用——后台会话的动作不能把光标画到前台（会话隔离）。
   */
  pointer?: {
    moveTo(x: number, y: number): void;
    highlight(rect: { x: number; y: number; width: number; height: number } | null): void;
    click(x: number, y: number): void;
    chip(text: string): void;
  };
  /**
   * 当前模型是否支持图片输入。为 true 时 browser_screenshot 会把 PNG 作为
   * 工具图片回灌到模型上下文（仅当前轮，不写入历史）；text-only 模型仍只拿路径。
   */
  visionEnabled?: () => boolean;
}

/**
 * 注册浏览器工具集。
 * @param resolveSessionRoot 会话工作根解析（截图落盘 <root>/.loopsoar/screenshots/；缺省 process.cwd()）。
 *   作为可选第三参保持向后兼容（既有调用/测试只传前两个参数）。
 * @param hooks 可选钩子（缺省 = 行为与没有钩子时完全一致）。
 */
export function registerBrowserTools(
  registry: ToolRegistry,
  browserHost: () => BrowserBackend | null,
  resolveSessionRoot?: (sessionId?: string) => string,
  hooks?: BrowserToolHooks,
): void {
  const needHost = (): BrowserBackend => {
    const host = browserHost();
    if (!host) throw new Error("浏览器未就绪");
    return host;
  };

  /**
   * 把覆盖层光标移到目标（带缩放换算），并画高亮框。
   * 返回 null = 不画（没有覆盖层 / 该会话的网页不在前台）。
   */
  const pointPointer = (
    host: BrowserBackend,
    sessionId: string | undefined,
    tabId: string | null,
    point: { x: number; y: number; width?: number; height?: number },
  ): { pointer: NonNullable<BrowserToolHooks["pointer"]>; x: number; y: number } | null => {
    const pointer = hooks?.pointer;
    if (!pointer) return null;
    if (typeof host.isSessionVisible === "function" && !host.isSessionVisible(sessionId)) return null;
    const zoom = typeof host.getPageZoom === "function" ? host.getPageZoom(sessionId, tabId ?? undefined) : 1;
    const x = point.x * zoom;
    const y = point.y * zoom;
    pointer.moveTo(x, y);
    if (typeof point.width === "number" && typeof point.height === "number") {
      pointer.highlight({
        x: x - (point.width * zoom) / 2,
        y: y - (point.height * zoom) / 2,
        width: point.width * zoom,
        height: point.height * zoom,
      });
    }
    return { pointer, x, y };
  };
  /** 动作完成后让高亮淡出（覆盖层自身在空闲 1.6s 后隐藏整窗）。 */
  const fadePointerHighlight = (): void => {
    setTimeout(() => hooks?.pointer?.highlight(null), 700);
  };

  registry.register({
    name: "browser_snapshot",
    description:
      "读取当前标签页的地址、标题、可见正文与可交互元素（元素以 #eN 编号，可直接用于 browser_click/browser_type；Agent 浏览网页的首选：先快照再决策）。像用户一样操作：搜索/输入框用 browser_type 点进去逐字输入，提交用 browser_press_key（Enter），不要用脚本直接改值或 el.click()。#eN 绑定到标签：切换标签后需在该标签重新快照",
    permissions: { read: true },
    schema: z.object({ maxChars: z.number().int().min(200).max(30000).optional() }),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const params = (ctx.params ?? {}) as { maxChars?: number };
        const host = needHost();
        const snapshot = await host.snapshot(ctx.sessionId);
        if (!snapshot) return { ok: false, content: "[错误] 当前没有打开的网页标签" };
        // 把令牌记到「产生它的标签」上：动作解析 ref 时必须用同一标签的注册表（跨标签 → STALE_REF）
        const tabId = snapshot.tabId ?? activeTabOf(host, ctx.sessionId);
        if (snapshot.tabToken) {
          snapshotTokens.set(tokenKey(ctx.sessionId, tabId), snapshot.tabToken);
          if (tabId) lastSnapshotTab.set(ctx.sessionId ?? "", tabId);
          trimSnapshotBindings();
        }
        const body = clip(snapshot.text ?? "", params.maxChars ?? MAX_TEXT);
        const elements = snapshot.elements ?? [];
        const total = typeof snapshot.elementTotal === "number" ? snapshot.elementTotal : elements.length;
        const shown = elements.slice(0, MAX_VISIBLE_ELEMENTS);
        const lines = shown.map(formatElement);
        const omitted = total - shown.length;
        const more =
          omitted > 0
            ? `\n…已省略 ${omitted} 个（共 ${total} 个，上限 ${MAX_VISIBLE_ELEMENTS}）。可滚动页面或用更具体条件后重新快照。`
            : "";
        const elementBlock = lines.length
          ? `可交互元素（共 ${total} 个；用 #eN 定位，也可用 CSS 选择器或 text=...）：\n${lines.join("\n")}${more}`
          : "可交互元素：未发现。";
        const gen = snapshot.snapshotGen ?? 0;
        return {
          ok: true,
          content: `[快照 #${gen} | ${snapshot.url} | ${snapshot.title}]\n\n${body}\n\n${elementBlock}`,
        };
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });

  registry.register({
    name: "browser_navigate",
    description: "在当前标签页打开一个 http(s) 网址（等价于用户输入地址回车）；返回地址/标题/加载态状态行",
    permissions: { browser: true },
    schema: z.object({ url: z.string().min(1).max(2000) }),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const params = ctx.params as { url?: string };
        if (!params?.url) return { ok: false, content: "[错误] 缺少 url" };
        const host = needHost();
        // Agent 标签默认不得访问回环（与 web_fetch 的 allowLoopback:false 对齐）。
        // 在工具层先拒一次：模型拿到的是可行动文案，而不是一次「网页加载失败」。
        if (!agentLoopbackAllowed() && isLoopbackTarget(params.url)) {
          return {
            ok: false,
            content: `[BLOCKED_LOOPBACK] Agent 不允许打开本机/回环地址（${params.url}）。本机服务请让用户自己打开；确实需要时由用户显式放开。`,
          };
        }
        // 打开网页前先过钩子（会话窗口布局询问，Slice E）：必须在真正 host.navigate 之前，
        // 否则「用户取消」已经变成了一次真实导航（源站可见、可能触发登录态/埋点）。
        // 放在 readTab 之前也让「动作前状态」是导航前的真实状态（用户思考期间页面可能变化）。
        const gate = hooks?.beforeOpenPage
          ? await hooks.beforeOpenPage({ sessionId: ctx.sessionId, url: params.url })
          : null;
        if (gate && !gate.proceed) {
          return { ok: false, content: `[已取消] ${gate.note ?? "用户取消了本次打开网页"}` };
        }
        const tabId = activeTabOf(host, ctx.sessionId);
        const before = readTab(host, ctx.sessionId, tabId);
        // origin="agent"：该标签归属「Agent 工作区」（UI 折叠标签组 + 运行期接管锁）
        const result = await host.navigate(params.url, undefined, ctx.sessionId, "agent");
        if (!result.ok) return { ok: false, content: `[错误] 导航失败：${result.error ?? "未知"}` };
        const created = (result as { tabId?: string }).tabId ?? tabId;
        const settled = await settleTab(host, ctx.sessionId, created, before);
        const line = statusLine(`已打开 ${result.url ?? params.url}`, settled);
        // 布局安排的说明放在状态行之后：状态行是「页面现在怎么样」，note 是「这次为什么这样摆窗口」。
        return { ok: true, content: gate?.note ? `${line}\n${gate.note}` : line };
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });

  registry.register({
    name: "browser_click",
    description:
      "点击页面元素（真实鼠标事件，像用户一样移动光标并按下去）：优先用快照里的 #eN（如 e5 或 5），也支持 CSS 选择器或 'text=登录'。点前做命中验证（被浮层遮挡返回 BLOCKED_BY_OVERLAY），点后返回地址/标题/加载态状态行",
    permissions: { browser: true },
    schema: z.object({ target: z.string().min(1).max(500) }),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const params = ctx.params as { target?: string };
        if (!params?.target) return { ok: false, content: "[错误] 缺少 target" };
        const host = needHost();
        const target = params.target;
        const tabId = activeTabOf(host, ctx.sessionId);
        // 跨标签保护：ref 只对「产生它的标签」有效
        const binding = bindRefToTab(ctx.sessionId, tabId, target);
        if (!binding.ok) return { ok: false, content: binding.message ?? "[STALE_REF] 引用已过期，请重新 browser_snapshot" };
        const before = readTab(host, ctx.sessionId, tabId);
        const registry = registryFor(ctx.sessionId, tabId);
        const run = (script: string) => host.executeScript(script, ctx.sessionId, tabId ?? undefined);
        // 第一步只定位（不点击）：拿到目标中心坐标，覆盖层才能把「Agent 的鼠标」移过去。
        // 解析、命中验证与错误文案仍由 refs.ts 单源提供（和旧点击路径同一套）。
        let point = await performTargetPoint(registry, target, run);
        // 被登录/引导弹窗挡住时先自己关掉再重试一次：模型常常只会「换个页面继续」，不会处理弹窗。
        let autoDismissed: string | null = null;
        if (!point.ok && point.code === "BLOCKED_BY_OVERLAY") {
          const dismissed = (await host
            .executeScript(buildDismissOverlayScript(), ctx.sessionId, tabId ?? undefined)
            .catch(() => null)) as { ok?: boolean; action?: string } | null;
          if (dismissed?.ok) {
            autoDismissed = dismissed.action ?? "dismiss";
            await new Promise((resolve) => setTimeout(resolve, 260));
            point = await performTargetPoint(registry, target, run);
          }
        }
        if (!point.ok || typeof point.x !== "number" || typeof point.y !== "number") {
          return { ok: false, content: point.message ?? `[错误] 点击失败：${target}` };
        }
        // 敏感步骤：策略层只能看到 target（多为 #e12），必须等定位拿到真实文案后再判一次。
        // 判定放在「移动光标之前」：被拒绝时不留下任何动作痕迹，也不产生涟漪/点击。
        //
        // 去重：`text=立即支付` 这类把敏感词写在 target 里的调用，策略层（services/chat.ts 的
        // 敏感步骤升级）已经弹过一次确认；这里只在「target 看不出语义、label 才判得出」时补一次，
        // 避免同一次点击连弹两个窗（第一次是权限、第二次是敏感）。
        // 优先用页面给的「元素可读文案」：ref/坐标/CSS 选择器本身都没有语义。
        const targetText = point.text ?? point.label ?? "";
        const sensitive = sensitiveClickReason(target, "")
          ? null
          : sensitiveClickReason(target, targetText);
        if (process.env.LOOPSOAR_DEBUG_BROWSER === "1") {
          console.log("[browser-click] sensitive", JSON.stringify({ target, text: point.text ?? null, label: point.label ?? null, sensitive }));
        }
        if (sensitive) {
          const label = (point.text && point.text.trim()) || point.label?.trim() || target;
          let allowed = false;
          if (hooks?.confirmSensitive) {
            try {
              allowed = await hooks.confirmSensitive({
                sessionId: ctx.sessionId,
                tool: "browser_click",
                label,
                reason: sensitive,
                ...(before?.url ? { url: before.url } : {}),
              });
            } catch {
              allowed = false;
            }
          }
          if (!allowed) {
            return {
              ok: false,
              content: `[SENSITIVE_DENIED] 已拦截敏感点击「${label}」：${sensitive}。未执行点击；如确需执行，请在界面上确认`,
            };
          }
        }
        // 第二步：光标移动 + 高亮 + 涟漪（视觉在覆盖层，网页本身不被注入任何节点）。
        const shown = pointPointer(host, ctx.sessionId, tabId, {
          x: point.x,
          y: point.y,
          width: point.width,
          height: point.height,
        });
        if (shown) {
          // 留出移动补间时间（覆盖层最长 260ms）：用户能看清「鼠标滑过去再点」，而不是瞬移。
          await new Promise((resolve) => setTimeout(resolve, 280));
          // 光标滑行期间页面可能因动画/图片/字体变化移动：点击前重新测一次，避免点错。
          const refreshed = await performTargetPoint(registry, target, run, { scrollIntoView: false });
          if (!refreshed.ok || typeof refreshed.x !== "number" || typeof refreshed.y !== "number") {
            return { ok: false, content: refreshed.message ?? "[TARGET_MOVED] 目标位置在光标移动期间发生变化，请重新快照" };
          }
          point = refreshed;
          if (typeof point.x !== "number" || typeof point.y !== "number") {
            return { ok: false, content: "[TARGET_MOVED] 目标位置无效，请重新快照" };
          }
          shown.pointer.click(point.x, point.y);
        }
        // 第三步：真实鼠标事件（sendInputEvent）。假视图/旧后端不支持时回退到脚本点击。
        const clickX = point.x;
        const clickY = point.y;
        if (typeof clickX !== "number" || typeof clickY !== "number") {
          return { ok: false, content: "[TARGET_MOVED] 目标位置无效，请重新快照" };
        }
        const real = typeof host.agentClick === "function"
          ? await host.agentClick(ctx.sessionId, tabId ?? undefined, { x: clickX, y: clickY })
          : false;
        if (process.env.LOOPSOAR_DEBUG_BROWSER === "1") {
          console.log("[browser-click]", JSON.stringify({ ok: point.ok, code: point.code, x: point.x, y: point.y, real }));
        }
        let degraded = false;
        if (!real) {
          const fallback = await performClick(registry, target, run);
          if (!fallback.ok) return { ok: false, content: fallback.message ?? `[错误] 点击失败：${target}` };
          degraded = true;
        }
        fadePointerHighlight();
        const settled = await settleTab(host, ctx.sessionId, tabId, before);
        const note = autoDismissed ? `（已自动关闭遮挡弹窗：${autoDismissed}）` : "";
        const degradedNote = degraded ? "（视图不可用，已降级为脚本点击）" : "";
        return { ok: true, content: statusLine(`已点击 ${point.label ?? target}`, settled) + note + degradedNote };
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });

  registry.register({
    name: "browser_dismiss_popup",
    description:
      "关闭当前页面上的遮挡弹窗（登录/引导/广告/公告层）：按「关闭/×/Esc」启发式处理并返回做了什么。点击被 BLOCKED_BY_OVERLAY 时也可直接调用",
    permissions: { browser: true },
    schema: z.object({}),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const host = needHost();
        const tabs = host.listTabs(ctx.sessionId);
        if (tabs.length === 0) return { ok: false, content: "[NO_TAB] 当前会话没有打开的网页标签" };
        const tabId = activeTabOf(host, ctx.sessionId);
        let result: { ok?: boolean; action?: string; code?: string } | null = null;
        try {
          result = (await host.executeScript(
            buildDismissOverlayScript(),
            ctx.sessionId,
            tabId ?? undefined,
          )) as { ok?: boolean; action?: string; code?: string } | null;
        } catch (err) {
          return { ok: false, content: `[SCRIPT_ERROR] 页面脚本执行失败：${err instanceof Error ? err.message : String(err)}` };
        }
        if (!result?.ok) {
          // 没找到关闭控件：已按 Esc 尝试，但必须如实告诉模型「无可操作控件」而不是假成功。
          return {
            ok: false,
            content: `[NOTHING_FOUND] 没有找到明确的关闭控件；已发送 Esc 尝试关闭。可先 browser_snapshot 查看页面再决定（${result?.action ?? "escape"}）`,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 220));
        return { ok: true, content: `已关闭遮挡弹窗（${result.action ?? "dismiss"}）；如需继续操作请重新 browser_snapshot 获取最新状态` };
      } catch (err) {
        return { ok: false, content: `[错误] 关闭弹窗失败：${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });

  registry.register({
    name: "browser_type",
    description:
      "在输入框输入文本：优先用快照里的 #eN（如 e2），也支持 CSS 选择器；会像用户一样点进输入框、全选后逐字敲键盘（CJK 经输入法上屏），回读校验不通过时回退原生 setter；返回地址/标题/加载态状态行",
    permissions: { browser: true },
    schema: z.object({ target: z.string().min(1).max(500), text: z.string().max(4000) }),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const params = ctx.params as { target?: string; text?: string };
        if (!params?.target) return { ok: false, content: "[错误] 缺少 target" };
        const host = needHost();
        const tabId = activeTabOf(host, ctx.sessionId);
        const binding = bindRefToTab(ctx.sessionId, tabId, params.target);
        if (!binding.ok) return { ok: false, content: binding.message ?? "[STALE_REF] 引用已过期，请重新 browser_snapshot" };
        const before = readTab(host, ctx.sessionId, tabId);
        const registry = registryFor(ctx.sessionId, tabId);
        const run = (script: string) => host.executeScript(script, ctx.sessionId, tabId ?? undefined);
        const text = params.text ?? "";
        // 视觉：光标移到输入框 + 键盘胶囊（真实键盘输入时用户能看到「光标停在输入框上」）。
        let point = await performTargetPoint(registry, params.target, run);
        const shown = point.ok && typeof point.x === "number" && typeof point.y === "number"
          ? pointPointer(host, ctx.sessionId, tabId, { x: point.x, y: point.y, width: point.width, height: point.height })
          : null;
        if (shown) {
          shown.pointer.chip("⌨ 输入中");
          // 等光标滑到位再开始敲键盘（输入本身是即时注入，视觉上要同步）。
          await new Promise((resolve) => setTimeout(resolve, 240));
          const refreshed = await performTargetPoint(registry, params.target, run, { scrollIntoView: false });
          if (refreshed.ok && typeof refreshed.x === "number" && typeof refreshed.y === "number") point = refreshed;
        }
        // 真实键盘优先：点进输入框 → Ctrl+A → 逐字输入 → 回读校验。
        // 不成立（不支持 sendInputEvent / 受控组件拒收 / 非文本元素）时回退原生 setter。
        let result: Awaited<ReturnType<typeof performType>> | null = null;
        let formatNote = "";
        if (point.ok && point.editable === true && typeof point.x === "number" && typeof point.y === "number") {
          const focused = await host.agentClick(ctx.sessionId, tabId ?? undefined, { x: point.x, y: point.y });
          if (focused) {
            const focus = await performFocusCheck(registry, params.target, run);
            if (!focus.ok) return { ok: false, content: focus.message ?? "[FOCUS_MISMATCH] 焦点不在目标输入框" };
          }
          const typed = focused && typeof host.agentType === "function"
            ? await host.agentType(ctx.sessionId, tabId ?? undefined, text, { multiline: point.multiline === true })
            : false;
          if (typed) {
            const expected = point.multiline === true
              ? text.replace(/\r\n?/g, "\n")
              : text.replace(/\r\n?/g, "\n").replace(/\n/g, " ");
            // 输入事件是异步到达渲染进程的：轮询回读，别在按键还没上屏时抢占结论。
            for (let attempt = 0; attempt < 12; attempt += 1) {
              const read = await performTypeReadback(registry, params.target, run);
              if (read.ok && read.value === expected) {
                result = { ok: true, label: point.label ?? params.target };
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 60));
            }
            if (!result) {
              // maxlength 截断、受控组件大写/去空格、contenteditable 丢换行：输入其实已生效，
              // 不能再走 setter 重写一遍（会重复触发 input/change/搜索/自动保存）。
              const finalRead = await performTypeReadback(registry, params.target, run);
              const got = finalRead.ok ? String(finalRead.value ?? "") : "";
              const norm = (value: string) => value.replace(/\s+/g, " ").trim();
              if (got && (norm(got) === norm(expected) || norm(expected).startsWith(norm(got)))) {
                result = { ok: true, label: point.label ?? params.target };
                formatNote = "（页面按自身规则格式化/截断，未重复输入）";
              }
            }
          }
        }
        let degraded = false;
        if (!result) {
          // 原生 setter + InputEvent + 回读比对（React 受控组件不再「返回成功但页面没变」）
          result = await performType(registry, params.target, text, run);
          degraded = true;
        }
        fadePointerHighlight();
        if (!result.ok) return { ok: false, content: result.message ?? `[错误] 输入失败：${params.target}` };
        const settled = await settleTab(host, ctx.sessionId, tabId, before);
        const degradedNote = degraded ? "（真实按键不可用/未生效，已降级为原生 setter）" : "";
        return { ok: true, content: statusLine(`已输入 ${result.label ?? params.target}`, settled) + formatNote + degradedNote };
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });

  registry.register({
    name: "browser_tabs",
    description:
      "管理当前会话的标签页：action=list 列出全部标签（序号/tabId/标题/URL/活动标记）；new 新建标签并自动切过去（可选 url）；select 切换；close 关闭（关最后一页只关闭标签，不退出应用）",
    permissions: { browser: true },
    schema: z.object({
      action: z.enum(["list", "new", "select", "close"]),
      url: z.string().min(1).max(2000).optional(),
      tabId: z.string().min(1).max(80).optional(),
    }),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const params = (ctx.params ?? {}) as { action?: "list" | "new" | "select" | "close"; url?: string; tabId?: string };
        const action = params.action;
        if (!action) return { ok: false, content: "[错误] 缺少 action（list / new / select / close）" };
        const host = needHost();
        const sessionId = ctx.sessionId;

        if (action === "list") {
          const tabs = host.listTabs(sessionId);
          const tabId = activeTabOf(host, sessionId);
          const note = tabs.length === 0 ? "当前会话没有打开的网页标签" : undefined;
          return {
            ok: true,
            content: `${formatTabList(tabs)}\n${statusLine("标签列表", { tab: readTab(host, sessionId, tabId), navigated: false }, note)}`,
          };
        }

        if (action === "new") {
          const countBefore = host.listTabs(sessionId).length;
          const created = await host.newTab(params.url, sessionId, "agent");
          if (!created?.ok) {
            return {
              ok: false,
              content: `[错误] 新建标签失败：${created?.error ?? "未知"}${created?.tabId ? `（已创建空白标签 ${created.tabId}，可 action=close 关闭）` : ""}`,
            };
          }
          // newTab 对已存在的同 URL 标签是「复用并切过去」，文案要如实说明
          const reused = host.listTabs(sessionId).length === countBefore;
          // 新标签没有「动作前状态」：空白标签不算发生导航，带 URL 才算
          const settled = await settleTab(host, sessionId, created.tabId, null);
          const label = reused ? `已切换到已有标签 ${created.tabId}` : `已新建标签 ${created.tabId}`;
          return { ok: true, content: `${formatTabList(host.listTabs(sessionId))}\n${statusLine(label, settled)}` };
        }

        if (!params.tabId) {
          return { ok: false, content: `[错误] ${action} 需要 tabId（可先用 browser_tabs action=list 查看）` };
        }
        const tabId = params.tabId;

        if (action === "select") {
          const switched = host.selectTab(tabId, sessionId);
          if (!switched) {
            return { ok: false, content: `[错误] 标签不存在：${tabId}；可先用 browser_tabs action=list 查看当前标签` };
          }
          const tab = readTab(host, sessionId, tabId);
          return {
            ok: true,
            content: `${formatTabList(host.listTabs(sessionId))}\n${statusLine(`已切换到标签 ${tabId}`, { tab, navigated: false })}`,
          };
        }

        // close：标签关掉不影响其它标签；关最后一页只是没有网页，应用不退出
        const closed = await host.closeTab(tabId, sessionId);
        if (!closed) {
          return { ok: false, content: `[错误] 标签不存在：${tabId}；可先用 browser_tabs action=list 查看当前标签` };
        }
        snapshotTokens.delete(tokenKey(sessionId, tabId));
        if (lastSnapshotTab.get(sessionId ?? "") === tabId) lastSnapshotTab.delete(sessionId ?? "");
        const tabs = host.listTabs(sessionId);
        const nextId = activeTabOf(host, sessionId);
        const note = tabs.length === 0 ? "当前会话已没有打开的标签（只关闭网页，不退出应用）" : undefined;
        return {
          ok: true,
          content: `${formatTabList(tabs)}\n${statusLine(`已关闭标签 ${tabId}`, { tab: readTab(host, sessionId, nextId), navigated: false }, note)}`,
        };
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });

  registry.register({
    name: "browser_back",
    description: "在当前标签（可选 tabId）后退一页，返回 URL、是否成功与状态行",
    permissions: { browser: true },
    schema: z.object({ tabId: z.string().min(1).max(80).optional() }),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const params = (ctx.params ?? {}) as { tabId?: string };
        const host = needHost();
        const tabId = params.tabId ?? activeTabOf(host, ctx.sessionId);
        if (!tabId) return { ok: false, content: "[错误] 当前会话没有打开的网页标签" };
        const before = readTab(host, ctx.sessionId, tabId);
        const result = await host.goBack(tabId, ctx.sessionId);
        if (!result?.ok) {
          return { ok: false, content: `[错误] 后退失败：${result?.error ?? "未知"}。可先用 browser_tabs action=list 确认标签` };
        }
        const settled = await settleTab(host, ctx.sessionId, tabId, before);
        return { ok: true, content: statusLine(`已后退 ${result.url ?? ""}`.trim(), settled) };
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });

  registry.register({
    name: "browser_forward",
    description: "在当前标签（可选 tabId）前进一页，返回 URL、是否成功与状态行",
    permissions: { browser: true },
    schema: z.object({ tabId: z.string().min(1).max(80).optional() }),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const params = (ctx.params ?? {}) as { tabId?: string };
        const host = needHost();
        const tabId = params.tabId ?? activeTabOf(host, ctx.sessionId);
        if (!tabId) return { ok: false, content: "[错误] 当前会话没有打开的网页标签" };
        const before = readTab(host, ctx.sessionId, tabId);
        const result = await host.goForward(tabId, ctx.sessionId);
        if (!result?.ok) {
          return { ok: false, content: `[错误] 前进失败：${result?.error ?? "未知"}。可先用 browser_tabs action=list 确认标签` };
        }
        const settled = await settleTab(host, ctx.sessionId, tabId, before);
        return { ok: true, content: statusLine(`已前进 ${result.url ?? ""}`.trim(), settled) };
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });

  registry.register({
    name: "browser_reload",
    description: "刷新当前标签（可选 tabId），返回 URL、是否成功与状态行",
    permissions: { browser: true },
    schema: z.object({ tabId: z.string().min(1).max(80).optional() }),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const params = (ctx.params ?? {}) as { tabId?: string };
        const host = needHost();
        const tabId = params.tabId ?? activeTabOf(host, ctx.sessionId);
        if (!tabId) return { ok: false, content: "[错误] 当前会话没有打开的网页标签" };
        const before = readTab(host, ctx.sessionId, tabId);
        const result = await host.reload(tabId, ctx.sessionId);
        if (!result?.ok) {
          return { ok: false, content: `[错误] 刷新失败：${result?.error ?? "未知"}。可先用 browser_tabs action=list 确认标签` };
        }
        const settled = await settleTab(host, ctx.sessionId, tabId, before);
        return { ok: true, content: statusLine(`已刷新 ${result.url ?? ""}`.trim(), settled) };
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });

  registry.register({
    name: "browser_press_key",
    description:
      "发送按键：Enter/Tab/Escape/Backspace/Delete/方向键/Home/End/PageUp/PageDown 或单个可见字符；可选 target（#eN 或 CSS）先聚焦该元素，缺省发到当前焦点/body。Enter 的表单提交用 requestSubmit 兜底，结果里说明实际触发的路径",
    permissions: { browser: true },
    schema: z.object({ key: z.string().min(1).max(20), target: z.string().min(1).max(500).optional() }),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const params = (ctx.params ?? {}) as { key?: string; target?: string };
        const key = params.key ?? "";
        if (!isSupportedKey(key)) {
          return {
            ok: false,
            content: `[INVALID_KEY] 不支持的按键：${JSON.stringify(key)}。可用：${NAMED_KEYS.join("/")}，或单个可见字符（如 a、1、/）`,
          };
        }
        const host = needHost();
        const tabId = activeTabOf(host, ctx.sessionId);
        if (params.target) {
          const binding = bindRefToTab(ctx.sessionId, tabId, params.target);
          if (!binding.ok) return { ok: false, content: binding.message ?? "[STALE_REF] 引用已过期，请重新 browser_snapshot" };
        }
        const before = readTab(host, ctx.sessionId, tabId);
        const registry = registryFor(ctx.sessionId, tabId);
        const run = (script: string) => host.executeScript(script, ctx.sessionId, tabId ?? undefined);
        // 有目标时先把光标停到目标上；键盘提示与全局提示同一套胶囊。
        if (params.target) {
          const point = await performTargetPoint(registry, params.target, run);
          if (point.ok && typeof point.x === "number" && typeof point.y === "number") {
            pointPointer(host, ctx.sessionId, tabId, { x: point.x, y: point.y, width: point.width, height: point.height });
            const focus = await performFocus(registry, params.target, run);
            if (!focus.ok) return { ok: false, content: focus.message ?? "[FOCUS_MISMATCH] 目标无法聚焦" };
          }
        }
        // Enter / Space 会提交表单：按键参数里没有元素语义，必须先读出焦点元素的真实文案再判敏感
        // （ref/坐标只是「哪个元素」，不知道它是「确认支付」还是「下一页」）。
        // 只对这两个提交键探测：逐字输入走 browser_type，不为每个字符付一次脚本开销。
        if (key === "Enter" || key === " ") {
          const probe = (await run(buildFocusProbeScript()).catch(() => null)) as unknown;
          const descriptor = describeFocusProbe(probe);
          if (descriptor) {
            const verdict = classifySensitiveStep({
              toolName: "browser_press_key",
              params: { key, label: descriptor },
            });
            if (verdict.sensitive) {
              let allowed = false;
              if (hooks?.confirmSensitive) {
                try {
                  allowed = await hooks.confirmSensitive({
                    sessionId: ctx.sessionId,
                    tool: "browser_press_key",
                    label: descriptor,
                    reason: verdict.reason ?? "敏感步骤需要确认",
                    ...(before?.url ? { url: before.url } : {}),
                  });
                } catch {
                  allowed = false;
                }
              }
              if (!allowed) {
                return {
                  ok: false,
                  content: `[SENSITIVE_DENIED] 已拦截敏感按键 ${key}：焦点在「${descriptor}」上（${verdict.reason ?? "敏感步骤"}）。未发送按键；如确需执行，请在界面上确认`,
                };
              }
            }
          }
        }
        if (typeof host.isSessionVisible === "function" && host.isSessionVisible(ctx.sessionId)) {
          hooks?.pointer?.chip(`⌨ ${key === " " ? "Space" : key}`);
        }
        // 真实键盘事件优先：表单默认行为（提交/跳转/关弹窗）只有可信事件才会发生。
        const real = typeof host.agentKey === "function" ? await host.agentKey(ctx.sessionId, tabId ?? undefined, key) : false;
        const result = real
          ? { ok: true, label: params.target ?? "当前焦点", detail: "真实键盘事件" }
          : await performPressKey(registry, params.target ?? null, key, run);
        if (!result.ok) return { ok: false, content: result.message ?? `[错误] 按键失败：${key}` };
        fadePointerHighlight();
        const settled = await settleTab(host, ctx.sessionId, tabId, before);
        const detail = result.detail ? `（${result.detail}）` : "";
        return { ok: true, content: statusLine(`已按键 ${key} → ${result.label ?? "当前焦点"}${detail}`, settled) };
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });

  registry.register({
    name: "browser_select",
    description:
      "在下拉框（<select>）里选择选项：target 必填（#eN 或 CSS），values 依次按 option 的 value 匹配、退而按可见文本匹配；原生 setter 设值 + input/change，并回读 selectedOptions 校验",
    permissions: { browser: true },
    schema: z.object({
      target: z.string().min(1).max(500),
      values: z.array(z.string().min(1).max(200)).min(1).max(20),
    }),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const params = (ctx.params ?? {}) as { target?: string; values?: string[] };
        if (!params?.target) return { ok: false, content: "[错误] 缺少 target" };
        if (!Array.isArray(params.values) || params.values.length === 0) {
          return { ok: false, content: "[错误] 缺少 values（要选中的 option 值或可见文本组成的数组）" };
        }
        const target = params.target;
        const host = needHost();
        const tabId = activeTabOf(host, ctx.sessionId);
        const binding = bindRefToTab(ctx.sessionId, tabId, target);
        if (!binding.ok) return { ok: false, content: binding.message ?? "[STALE_REF] 引用已过期，请重新 browser_snapshot" };
        const before = readTab(host, ctx.sessionId, tabId);
        const registry = registryFor(ctx.sessionId, tabId);
        const run = (script: string) => host.executeScript(script, ctx.sessionId, tabId ?? undefined);
        // 下拉框同样先让光标停到目标上（视觉一致；选中动作仍走原生 setter + 回读）。
        const point = await performTargetPoint(registry, target, run);
        if (point.ok && typeof point.x === "number" && typeof point.y === "number") {
          pointPointer(host, ctx.sessionId, tabId, { x: point.x, y: point.y, width: point.width, height: point.height });
        }
        const result = await performSelect(registry, target, params.values, run);
        fadePointerHighlight();
        if (!result.ok) return { ok: false, content: result.message ?? `[错误] 选择失败：${target}` };
        const settled = await settleTab(host, ctx.sessionId, tabId, before);
        const detail = result.detail ? `（${result.detail}）` : "";
        return { ok: true, content: statusLine(`已选择 ${result.label ?? target}${detail}`, settled) };
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });

  registry.register({
    name: "browser_drag",
    description:
      "拖拽元素：从 from 拖到 to（#eN / CSS / text=），真实鼠标按下 → 分帧移动 → 抬起；用于滑块、拖拽排序、画布/编辑器等场景",
    permissions: { browser: true },
    schema: z.object({ from: z.string().min(1).max(500), to: z.string().min(1).max(500) }),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const params = (ctx.params ?? {}) as { from?: string; to?: string };
        if (!params?.from || !params?.to) return { ok: false, content: "[错误] 缺少 from / to" };
        const host = needHost();
        const tabId = activeTabOf(host, ctx.sessionId);
        const fromBinding = bindRefToTab(ctx.sessionId, tabId, params.from);
        if (!fromBinding.ok) return { ok: false, content: fromBinding.message ?? "[STALE_REF] 引用已过期，请重新 browser_snapshot" };
        const toBinding = bindRefToTab(ctx.sessionId, tabId, params.to);
        if (!toBinding.ok) return { ok: false, content: toBinding.message ?? "[STALE_REF] 引用已过期，请重新 browser_snapshot" };
        const before = readTab(host, ctx.sessionId, tabId);
        const registry = registryFor(ctx.sessionId, tabId);
        const run = (script: string) => host.executeScript(script, ctx.sessionId, tabId ?? undefined);
        const fromPoint = await performTargetPoint(registry, params.from, run);
        if (!fromPoint.ok || typeof fromPoint.x !== "number" || typeof fromPoint.y !== "number") {
          return { ok: false, content: fromPoint.message ?? `[错误] 拖拽起点定位失败：${params.from}` };
        }
        // 终点不再 scrollIntoView：拖拽过程中页面不能被滚动，否则按下位置与目标错位。
        const toPoint = await performTargetPoint(registry, params.to, run, { scrollIntoView: false });
        if (!toPoint.ok || typeof toPoint.x !== "number" || typeof toPoint.y !== "number") {
          return { ok: false, content: toPoint.message ?? `[错误] 拖拽终点定位失败：${params.to}` };
        }
        const shown = pointPointer(host, ctx.sessionId, tabId, { x: fromPoint.x, y: fromPoint.y, width: fromPoint.width, height: fromPoint.height });
        if (shown) {
          shown.pointer.chip("拖拽");
          await new Promise((resolve) => setTimeout(resolve, 240));
        }
        const real = typeof host.agentDrag === "function"
          ? await host.agentDrag(ctx.sessionId, tabId ?? undefined, { x: fromPoint.x, y: fromPoint.y }, { x: toPoint.x, y: toPoint.y })
          : false;
        if (!real) return { ok: false, content: "[错误] 当前视图不支持真实拖拽（sendInputEvent 不可用）" };
        pointPointer(host, ctx.sessionId, tabId, { x: toPoint.x, y: toPoint.y });
        fadePointerHighlight();
        const settled = await settleTab(host, ctx.sessionId, tabId, before);
        return { ok: true, content: statusLine(`已拖拽 ${fromPoint.label ?? params.from} → ${toPoint.label ?? params.to}`, settled) };
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });

  registry.register({
    name: "browser_hover",
    description:
      "把鼠标悬停到元素上（#eN 或 CSS）：滚进视野并派发 pointerover/pointerenter/mouseover/mouseenter/mousemove，用于展开菜单/悬浮提示",
    permissions: { browser: true },
    schema: z.object({ target: z.string().min(1).max(500) }),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const params = (ctx.params ?? {}) as { target?: string };
        if (!params?.target) return { ok: false, content: "[错误] 缺少 target" };
        const target = params.target;
        const host = needHost();
        const tabId = activeTabOf(host, ctx.sessionId);
        const binding = bindRefToTab(ctx.sessionId, tabId, target);
        if (!binding.ok) return { ok: false, content: binding.message ?? "[STALE_REF] 引用已过期，请重新 browser_snapshot" };
        const before = readTab(host, ctx.sessionId, tabId);
        const registry = registryFor(ctx.sessionId, tabId);
        const run = (script: string) => host.executeScript(script, ctx.sessionId, tabId ?? undefined);
        // 悬停也要看得见：光标移到目标，再派发悬停事件（真实输入不改变 hover 语义）。
        const point = await performTargetPoint(registry, target, run);
        if (point.ok && typeof point.x === "number" && typeof point.y === "number") {
          const shown = pointPointer(host, ctx.sessionId, tabId, { x: point.x, y: point.y, width: point.width, height: point.height });
          if (shown) await new Promise((resolve) => setTimeout(resolve, 200));
        }
        // 真实鼠标移动优先：CSS :hover、pointerover、mouseover 都由可信鼠标事件驱动。
        const realHover =
          point.ok && typeof point.x === "number" && typeof point.y === "number" && typeof host.agentHover === "function"
            ? await host.agentHover(ctx.sessionId, tabId ?? undefined, { x: point.x, y: point.y })
            : false;
        const result = realHover
          ? { ok: true, label: point.label ?? target }
          : await performHover(registry, target, run);
        fadePointerHighlight();
        if (!result.ok) return { ok: false, content: result.message ?? `[错误] 悬停失败：${target}` };
        const settled = await settleTab(host, ctx.sessionId, tabId, before);
        const detail = result.detail ? `（${result.detail}）` : "";
        return { ok: true, content: statusLine(`已悬停 ${result.label ?? target}${detail}`, settled) };
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });

  registry.register({
    name: "browser_scroll",
    description:
      "滚动当前页面：down / up 走真实鼠标滚轮（虚拟光标移到页面中间后按 notch 滚动），top / bottom 直达；长页面分页阅读",
    permissions: { browser: true },
    schema: z.object({ direction: z.enum(["down", "up", "top", "bottom"]), amount: z.number().int().min(100).max(5000).optional() }),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const params = (ctx.params ?? {}) as { direction?: "down" | "up" | "top" | "bottom"; amount?: number };
        const direction = params.direction ?? "down";
        const amount = params.amount ?? 800;
        const host = needHost();
        const tabId = activeTabOf(host, ctx.sessionId);
        const before = readTab(host, ctx.sessionId, tabId);
        // down/up：真实滚轮（可信事件，滚动监听/吸顶/懒加载都会响应）；光标先滑到页面中间。
        let scrolled = false;
        if ((direction === "down" || direction === "up") && typeof host.agentWheel === "function") {
          const center = await host.getViewportCenter(ctx.sessionId, tabId ?? undefined);
          if (center) {
            const shown = pointPointer(host, ctx.sessionId, tabId, { x: center.x, y: center.y });
            if (shown) {
              shown.pointer.chip(direction === "down" ? "滚动 ↓" : "滚动 ↑");
              await new Promise((resolve) => setTimeout(resolve, 200));
            }
          }
          scrolled = await host.agentWheel(ctx.sessionId, tabId ?? undefined, direction === "down" ? amount : -amount);
        }
        if (!scrolled) {
          const script =
            direction === "top"
              ? "window.scrollTo({ top: 0 }); 'ok'"
              : direction === "bottom"
                ? "window.scrollTo({ top: document.body.scrollHeight }); 'ok'"
                : `window.scrollBy({ top: ${direction === "up" ? -amount : amount} }); 'ok'`;
          await host.executeScript(script, ctx.sessionId);
        }
        const settled = await settleTab(host, ctx.sessionId, tabId, before);
        return { ok: true, content: statusLine(`已滚动：${direction}`, settled) };
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });

  registry.register({
    name: "browser_screenshot",
    description:
      "对当前标签页截图（可见区域，PNG）并保存到会话工作根 .loopsoar/screenshots/；可选 selector 先把元素滚动到可视区。视觉模型会直接收到图片附件，text-only 模型只返回路径",
    permissions: { read: true },
    schema: z.object({ selector: z.string().min(1).max(200).optional() }),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const params = (ctx.params ?? {}) as { selector?: string };
        const host = needHost();

        // selector 只负责把目标元素滚进视野（Electron capturePage 截的是当前视口，不是元素级截图）
        // 与 click/type 同一套解析：支持 #eN、CSS 选择器与 text=
        if (params.selector) {
          const tabId = activeTabOf(host, ctx.sessionId);
          const located = await performScrollIntoView(registryFor(ctx.sessionId, tabId), params.selector, (script) =>
            host.executeScript(script, ctx.sessionId, tabId ?? undefined),
          );
          if (!located.ok) return { ok: false, content: located.message ?? "[错误] 元素定位失败" };
        }

        // 光标/高亮现在画在应用级覆盖窗口里，capturePage 只截网页本身，不会被拍进证据图。
        const data = await host.screenshot(ctx.sessionId);
        if (!data) return { ok: false, content: "[错误] 当前没有打开的网页标签" };
        // 兼容 dataURL（data:image/png;base64,xxx）与裸 base64 两种适配器实现
        const base64 = data.includes(",") ? data.slice(data.indexOf(",") + 1) : data;
        const buffer = Buffer.from(base64, "base64");
        if (buffer.length === 0) return { ok: false, content: "[错误] 截图失败（空图像）" };

        const root = resolveSessionRoot?.(ctx.sessionId)?.trim() || process.cwd();
        const dir = path.join(root, ".loopsoar", "screenshots");
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `screenshot-${screenshotStamp()}-${randomUUID().slice(0, 8)}.png`);
        fs.writeFileSync(file, buffer);

        const size = readPngSize(buffer);
        let attachImage = false;
        try {
          attachImage = hooks?.visionEnabled?.() === true && buffer.length <= 1_500_000;
        } catch {
          // 能力探测失败不应让截图工具失败；退回只返回路径。
        }
        return {
          ok: true,
          content: `已截图：${file}\n尺寸：${size ? `${size.width}x${size.height}` : "未知"}（${buffer.length} 字节）${
            attachImage ? "\n图片已附在本轮工具结果中。" : ""
          }`,
          ...(attachImage ? { images: [{ mime: "image/png", base64 }] } : {}),
        };
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });

  registry.register({
    name: "browser_wait",
    description:
      "等待页面就绪：轮询指定选择器出现/文本出现在页面中，或简单等待若干毫秒（默认 3000ms，上限 10s）。适合等异步内容加载",
    permissions: { read: true },
    schema: z.object({
      ms: z.number().int().min(100).max(10_000).optional(),
      selector: z.string().min(1).max(200).optional(),
      text: z.string().min(1).max(200).optional(),
    }),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const params = (ctx.params ?? {}) as { ms?: number; selector?: string; text?: string };
        const timeoutMs = params.ms ?? 3000;
        const selector = params.selector?.trim();
        const text = params.text?.trim();
        const host = needHost();
        const startedAt = Date.now();

        // 只给 ms：纯等待（让页面自行加载）
        if (!selector && !text) {
          await sleep(timeoutMs);
          return { ok: true, content: `[就绪] 已等待 ${timeoutMs}ms` };
        }

        const description = [selector ? `选择器 ${selector}` : "", text ? `文本「${text}」` : ""]
          .filter(Boolean)
          .join(" 或 ");
        const checkScript = `(() => {
          const selector = ${selector ? JSON.stringify(selector) : "null"};
          const text = ${text ? JSON.stringify(text) : "null"};
          if (selector) {
            let el = null;
            try { el = document.querySelector(selector); } catch { return false; }
            if (!el) return false;
          }
          if (text) {
            const body = document.body ? document.body.innerText : "";
            if (body.indexOf(text) === -1) return false;
          }
          return true;
        })()`;

        while (true) {
          let ready = false;
          try {
            ready = Boolean(await host.executeScript(checkScript, ctx.sessionId));
          } catch (err) {
            return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
          }
          const elapsed = Date.now() - startedAt;
          if (ready) return { ok: true, content: `[就绪] ${description} 已出现（等待 ${elapsed}ms）` };
          if (elapsed >= timeoutMs) {
            return { ok: false, content: `[超时] 等待 ${timeoutMs}ms 仍未检测到 ${description}` };
          }
          await sleep(Math.min(200, Math.max(0, timeoutMs - elapsed)));
        }
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });

  registry.register({
    name: "web_fetch",
    description: "直接抓取一个 http(s) URL 的文本内容（不打开标签页；用于查资料/API）",
    // web_fetch 不是「浏览器操控」：直接抓取 URL 文本、不开标签页，语义属于网络访问，
    // 因此留在 network 档（与 browser 档不混用），仍走「每次确认」的默认策略。
    permissions: {
      network: true,
    },
    schema: z.object({ url: z.string().url().max(2000), maxChars: z.number().int().min(200).max(30000).optional() }),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const params = ctx.params as { url?: string; maxChars?: number };
        if (!params?.url) return { ok: false, content: "[错误] 缺少 url" };
        // 出网必须走注入的 platform.net（DNS 钉扎 + 逐跳 SSRF 校验）；
        // 这里不再裸 fetch：裸 fetch 会重新解析 DNS，把 SSRF 防护降级成"校验后被 TOCTOU 绕过"。
        const net = ctx.platform?.net as NetAdapter | undefined;
        if (!net || typeof net.request !== "function") {
          return { ok: false, content: "[错误] 网络适配器未就绪（无法安全抓取）" };
        }
        const maxChars = params.maxChars ?? MAX_TEXT;
        const response = await net.request({
          url: params.url,
          method: "GET",
          timeoutMs: 12_000,
          maxChars,
          allowLoopback: false,
          headers: {
            "user-agent": "LoopsoarBot/0.0 (+local agent browser)",
            accept: "text/html,application/json,text/plain,*/*",
          },
        });
        const contentType = response.headers["content-type"] ?? "";
        const text = /html/i.test(contentType) ? htmlToText(response.text) : response.text;
        const ok = response.status >= 200 && response.status < 300;
        return {
          ok,
          content: ok
            ? `HTTP ${response.status} ${response.finalUrl}\n\n${clip(text, maxChars)}`
            : `[HTTP ${response.status}] ${clip(text, 1000)}`,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, content: `[错误] ${message}` };
      }
    },
  });

  /**
   * 动作类工具执行前先做「任务化准备」：首次动手时把当前用户页克隆进 Agent 工作区
   * （`BrowserHost.ensureAgentTab`），原页保持不动。
   *
   * 只读工具（snapshot/screenshot/wait/tabs 读取）不包装：看页面不是工作，不该克隆。
   * 用 force 重注册同一个工具定义，执行链不变，只是在最前面加一步幂等准备。
   */
  const ACTION_TOOL_NAMES = [
    "browser_navigate",
    "browser_click",
    "browser_type",
    "browser_drag",
    "browser_press_key",
    "browser_scroll",
    "browser_hover",
    "browser_select",
    "browser_dismiss_popup",
    "browser_back",
    "browser_forward",
    "browser_reload",
  ];
  for (const name of ACTION_TOOL_NAMES) {
    const def = registry.get(name);
    if (!def) continue;
    const execute = def.execute;
    registry.register(
      {
        ...def,
        execute: async (ctx) => {
          const host = browserHost();
          if (host && typeof host.ensureAgentTab === "function") {
            // 快照可能落在「用户全局标签」（会话还没有自己的页）；此时 activeTabId(session) 为 null，
            // 但 lastSnapshotTab 记着令牌真正来自哪个标签，迁移必须以它为来源键。
            const fromTab =
              activeTabOf(host, ctx.sessionId) ?? lastSnapshotTab.get(ctx.sessionId ?? "") ?? null;
            const fromKey = tokenKey(ctx.sessionId, fromTab);
            const token = fromTab ? snapshotTokens.get(fromKey) : undefined;
            const adopted = await host
              .ensureAgentTab(ctx.sessionId, { blank: name === "browser_navigate" })
              .catch(() => null);
            // 首次动作会把用户页克隆成任务页；把快照令牌迁到克隆页，避免第一次点击必 STALE_REF。
            if (adopted && fromTab && adopted !== fromTab) {
              if (token) {
                snapshotTokens.set(tokenKey(ctx.sessionId, adopted), token);
                snapshotTokens.delete(fromKey);
                trimSnapshotBindings();
              }
              if (lastSnapshotTab.get(ctx.sessionId ?? "") === fromTab) {
                lastSnapshotTab.set(ctx.sessionId ?? "", adopted);
              }
            }
          }
          return execute(ctx);
        },
      },
      { force: true },
    );
  }
}
