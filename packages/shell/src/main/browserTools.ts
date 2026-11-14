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
import type { ToolRegistry, ToolResult } from "loopsoar-core/tools/registry";
import type { BrowserHost, TabState } from "./browserHost.js";
import type { BrowserElementSnapshot } from "../browserAdapter/types.js";
import {
  MAX_VISIBLE_ELEMENTS,
  NAMED_KEYS,
  getTabRegistry,
  isSupportedKey,
  normalizeRef,
  performClick,
  performHover,
  performPressKey,
  performScrollIntoView,
  performSelect,
  performType,
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

function tokenKey(sessionId: string | undefined, tabId: string | null | undefined): string {
  return `${sessionId ?? ""}::${tabId ?? ""}`;
}

/** 目标标签（缺省活动标签）；宿主未提供 activeTabId（老实现/测试假件）时返回 null。 */
function activeTabOf(host: BrowserHost, sessionId?: string): string | null {
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
function readTab(host: BrowserHost, sessionId: string | undefined, tabId: string | null): TabStatus | null {
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
  host: BrowserHost,
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
}

/**
 * 注册浏览器工具集。
 * @param resolveSessionRoot 会话工作根解析（截图落盘 <root>/.loopsoar/screenshots/；缺省 process.cwd()）。
 *   作为可选第三参保持向后兼容（既有调用/测试只传前两个参数）。
 * @param hooks 可选钩子（缺省 = 行为与没有钩子时完全一致）。
 */
export function registerBrowserTools(
  registry: ToolRegistry,
  browserHost: () => BrowserHost | null,
  resolveSessionRoot?: (sessionId?: string) => string,
  hooks?: BrowserToolHooks,
): void {
  const needHost = (): BrowserHost => {
    const host = browserHost();
    if (!host) throw new Error("浏览器未就绪");
    return host;
  };

  registry.register({
    name: "browser_snapshot",
    description:
      "读取当前标签页的地址、标题、可见正文与可交互元素（元素以 #eN 编号，可直接用于 browser_click/browser_type；Agent 浏览网页的首选：先快照再决策）。#eN 绑定到标签：切换标签后需在该标签重新快照",
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
        const result = await host.navigate(params.url, undefined, ctx.sessionId);
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
      "点击页面元素：优先用快照里的 #eN（如 e5 或 5），也支持 CSS 选择器或 'text=登录'。点前做命中验证（被浮层遮挡返回 BLOCKED_BY_OVERLAY），点后返回地址/标题/加载态状态行",
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
        // ref → 注册表句柄；CSS / text= 直接透传。解析、命中验证与错误文案都在 refs.ts。
        const result = await performClick(registryFor(ctx.sessionId, tabId), target, (script) =>
          host.executeScript(script, ctx.sessionId, tabId ?? undefined),
        );
        if (!result.ok) return { ok: false, content: result.message ?? `[错误] 点击失败：${target}` };
        const settled = await settleTab(host, ctx.sessionId, tabId, before);
        return { ok: true, content: statusLine(`已点击 ${result.label ?? target}`, settled) };
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });

  registry.register({
    name: "browser_type",
    description:
      "在输入框输入文本：优先用快照里的 #eN（如 e2），也支持 CSS 选择器（原生 setter 写入并回读校验）；返回地址/标题/加载态状态行",
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
        // 原生 setter + InputEvent + 回读比对（React 受控组件不再「返回成功但页面没变」）
        const result = await performType(registryFor(ctx.sessionId, tabId), params.target, params.text ?? "", (script) =>
          host.executeScript(script, ctx.sessionId, tabId ?? undefined),
        );
        if (!result.ok) return { ok: false, content: result.message ?? `[错误] 输入失败：${params.target}` };
        const settled = await settleTab(host, ctx.sessionId, tabId, before);
        return { ok: true, content: statusLine(`已输入 ${result.label ?? params.target}`, settled) };
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
          const created = await host.newTab(params.url, sessionId);
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
        const result = await performPressKey(registryFor(ctx.sessionId, tabId), params.target ?? null, key, (script) =>
          host.executeScript(script, ctx.sessionId, tabId ?? undefined),
        );
        if (!result.ok) return { ok: false, content: result.message ?? `[错误] 按键失败：${key}` };
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
        const result = await performSelect(registryFor(ctx.sessionId, tabId), target, params.values, (script) =>
          host.executeScript(script, ctx.sessionId, tabId ?? undefined),
        );
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
        const result = await performHover(registryFor(ctx.sessionId, tabId), target, (script) =>
          host.executeScript(script, ctx.sessionId, tabId ?? undefined),
        );
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
    description: "滚动当前页面：down / up / top / bottom（长页面分页阅读）",
    permissions: { browser: true },
    schema: z.object({ direction: z.enum(["down", "up", "top", "bottom"]), amount: z.number().int().min(100).max(5000).optional() }),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const params = (ctx.params ?? {}) as { direction?: "down" | "up" | "top" | "bottom"; amount?: number };
        const direction = params.direction ?? "down";
        const amount = params.amount ?? 800;
        const script =
          direction === "top"
            ? "window.scrollTo({ top: 0 }); 'ok'"
            : direction === "bottom"
              ? "window.scrollTo({ top: document.body.scrollHeight }); 'ok'"
              : `window.scrollBy({ top: ${direction === "up" ? -amount : amount} }); 'ok'`;
        await needHost().executeScript(script, ctx.sessionId);
        return { ok: true, content: `已滚动：${direction}` };
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });

  registry.register({
    name: "browser_screenshot",
    description:
      "对当前标签页截图（可见区域，PNG）并保存到会话工作根 .loopsoar/screenshots/；可选 selector 先把元素滚动到可视区。返回文件路径与像素尺寸",
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
        return {
          ok: true,
          content: `已截图：${file}\n尺寸：${size ? `${size.width}x${size.height}` : "未知"}（${buffer.length} 字节）`,
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
}
