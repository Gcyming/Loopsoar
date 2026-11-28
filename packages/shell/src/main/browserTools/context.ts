/**
 * 浏览器工具族的公共上下文（拆分自 browserTools.ts，行为不变）。
 *
 * 为什么抽这一层：17 个工具原先挤在一个 registerBrowserTools 里，任何一次「给某个工具加一行」
 * 都要在 1500 行文件里定位；更要命的是共用状态（快照令牌、最近标签）与共用闭包
 * （needHost / 指针覆盖层）混在一起，读者无法判断某个变量归谁所有。
 *
 * 现在：状态收进 `SnapshotBindings`（唯一所有者、自带上限）、闭包收进 `BrowserToolEnv`
 * （显式传递，不用隐式捕获）、纯函数留在这里（可单测、无副作用）。
 */
import { classifySensitiveStep } from "loopsoar-core/sensitiveSteps";
import type { ToolDefinition, ToolRegistry, ToolResult } from "loopsoar-core/tools/registry";
import { z } from "zod";
import type { RefRegistry } from "../../browserAdapter/refs.js";
import { dropTabRegistry, getTabRegistry, normalizeRef } from "../../browserAdapter/refs.js";
import type { BrowserBackend } from "../browserBackend.js";
import type { TabState } from "../browserHost.js";

export const MAX_TEXT = 8000;
/** 动作后的短探测窗口：捕获点击后立即开始的主框架导航。 */
export const STATUS_PROBE_MS = 120;
/** 加载中轮询间隔与最长等待：命中即返回，不无谓等待。 */
export const STATUS_POLL_MS = 100;
export const STATUS_SETTLE_MAX_MS = 1500;

/**
 * browser_click 的两种寻址方式必须二选一：
 *   · target：ref/CSS/text，走现有元素解析与命中验证；
 *   · x/y：视觉定位后的视口坐标，走 elementFromPoint 探测。
 * space=image 仅用于截图按设备像素渲染（DPR>1）的换算；默认 CSS 像素。
 */
export const BrowserClickSchema = z
  .object({
    target: z.string().min(1).max(500).optional(),
    x: z.number().finite().min(0).max(100000).optional(),
    y: z.number().finite().min(0).max(100000).optional(),
    space: z.enum(["css", "image"]).optional(),
  })
  .superRefine((value, ctx) => {
    const hasTarget = value.target !== undefined;
    const hasPoint = value.x !== undefined || value.y !== undefined;
    if (hasTarget && hasPoint) {
      ctx.addIssue({ code: "custom", message: "target 与 x/y 只能二选一" });
    }
    if (!hasTarget && (value.x === undefined || value.y === undefined)) {
      ctx.addIssue({ code: "custom", message: "需要 target，或同时提供 x 与 y" });
    }
    if (value.space !== undefined && !hasPoint) {
      ctx.addIssue({ code: "custom", message: "space 只与 x/y 坐标点击一起使用" });
    }
  });

/**
 * 浏览器工具错误码（P2-1）：所有 ok:false 必须同时给 `error`，上层才能按码分流重试/降级，
 * 而不是让模型去正则解析中文文案。
 */
export const BROWSER_ERROR_CODES = [
  "NO_TAB",
  "NO_HOST",
  "STALE_REF",
  "NO_TARGET",
  "TARGET_MOVED",
  "FOCUS_MISMATCH",
  "SCRIPT_ERROR",
  "NAV_FAILED",
  "TIMEOUT",
  "NOTHING_FOUND",
  "BLOCKED_LOOPBACK",
  "DENIED",
  "CANCELLED",
  "INVALID_ARGS",
  "CLICK_FAILED",
  "TYPE_FAILED",
  "UNKNOWN",
] as const;
export type BrowserToolError = (typeof BROWSER_ERROR_CODES)[number];

/** 从失败文案推导错误码：[CODE] 前缀优先，其次关键词映射（顺序即优先级）。 */
export function deriveBrowserErrorCode(content: string): BrowserToolError {
  const bracketed = /^\[([A-Z_]+)\]/.exec(content);
  if (bracketed && (BROWSER_ERROR_CODES as readonly string[]).includes(bracketed[1])) {
    return bracketed[1] as BrowserToolError;
  }
  if (content.startsWith("[已取消]")) return "CANCELLED";
  if (/缺少/.test(content)) return "INVALID_ARGS";
  if (/没有打开的网页标签|标签不存在/.test(content)) return "NO_TAB";
  if (/浏览器未就绪/.test(content)) return "NO_HOST";
  if (/导航失败|打开失败/.test(content)) return "NAV_FAILED";
  if (/点击失败/.test(content)) return "CLICK_FAILED";
  if (/输入失败/.test(content)) return "TYPE_FAILED";
  if (/超时/.test(content)) return "TIMEOUT";
  if (/未找到|找不到|没有找到/.test(content)) return "NOTHING_FOUND";
  return "UNKNOWN";
}

/** 统一收口：失败结果缺 error 时补码（已显式给码的不覆盖）。 */
export function withBrowserErrorCode(result: ToolResult): ToolResult {
  if (result.ok || result.error) return result;
  return { ...result, error: deriveBrowserErrorCode(result.content) };
}

/**
 * 会话 → 标签 → 最近一次快照的令牌。
 *
 * 为什么不是会话级单键：BrowserHost.snapshot() 认的是**活动标签**，
 * 用户手动切标签后，会话级令牌会把旧 ref 解析到另一标签的注册表（串页）。
 * 标签级绑定后，动作只认「当前动作目标标签」的注册表，目标标签与产生令牌的标签不一致时
 * 返回可行动的 STALE_REF。
 *
 * 为什么要有上限：UI 关页/删会话不会回调这里，必须自带 LRU 式裁剪防长期浏览后无界增长。
 * 为什么把两张表合成一个类：它们描述同一件事（某会话某标签的快照来历），
 * 分开维护迟早出现「令牌迁走了、lastTab 还指着旧标签」的半更新状态。
 */
export class SnapshotBindings {
  private static readonly MAX = 512;
  private readonly tokens = new Map<string, string>();
  private readonly lastTabs = new Map<string, string>();

  private key(sessionId: string | undefined, tabId: string | null | undefined): string {
    return `${sessionId ?? ""}::${tabId ?? ""}`;
  }

  /** 记录一次快照：令牌绑定到产生它的标签。 */
  bind(sessionId: string | undefined, tabId: string | null | undefined, token: string): void {
    if (!tabId) return;
    this.tokens.set(this.key(sessionId, tabId), token);
    this.lastTabs.set(sessionId ?? "", tabId);
    this.trim();
  }

  token(sessionId: string | undefined, tabId: string | null | undefined): string | undefined {
    return this.tokens.get(this.key(sessionId, tabId));
  }

  lastTab(sessionId: string | undefined): string | undefined {
    return this.lastTabs.get(sessionId ?? "");
  }

  /** 注册表：没有令牌（或令牌已被裁剪）时返回 null，由调用方给 STALE_REF。 */
  registry(sessionId: string | undefined, tabId: string | null | undefined): RefRegistry | null {
    return getTabRegistry(this.token(sessionId, tabId));
  }

  /**
   * 迁移绑定：首次动作把用户页克隆成任务页后调用。
   * 注意 `lastTab` 无条件跟随（即使没有令牌）——「最近快照来自哪个标签」是独立事实，
   * 丢了它，下一次没有令牌的动作就分不清是「跨标签」还是「同标签没快照」。
   */
  migrate(sessionId: string | undefined, fromTab: string | null, toTab: string | null): void {
    if (!fromTab || !toTab || fromTab === toTab) return;
    const token = this.token(sessionId, fromTab);
    if (token) {
      this.tokens.set(this.key(sessionId, toTab), token);
      this.tokens.delete(this.key(sessionId, fromTab));
    }
    if (this.lastTabs.get(sessionId ?? "") === fromTab) this.lastTabs.set(sessionId ?? "", toTab);
    this.trim();
  }

  /** 标签关闭：同时丢弃令牌与「最近标签」指针，避免重开同 id 标签复活旧 ref。 */
  forget(sessionId: string | undefined, tabId: string | null | undefined): void {
    if (!tabId) return;
    this.tokens.delete(this.key(sessionId, tabId));
    if (this.lastTabs.get(sessionId ?? "") === tabId) this.lastTabs.delete(sessionId ?? "");
  }

  /** 裁剪：按插入顺序淘汰最旧的令牌，并同步丢弃浏览器侧注册表（防内存双份滞留）。 */
  trim(): void {
    while (this.tokens.size > SnapshotBindings.MAX) {
      const oldest = this.tokens.entries().next().value as [string, string] | undefined;
      if (!oldest) break;
      this.tokens.delete(oldest[0]);
      dropTabRegistry(oldest[1]);
    }
    while (this.lastTabs.size > SnapshotBindings.MAX) {
      const oldest = this.lastTabs.keys().next().value as string | undefined;
      if (!oldest) break;
      this.lastTabs.delete(oldest);
    }
  }

  /** 测试/诊断用：当前绑定条数。 */
  size(): { tokens: number; sessions: number } {
    return { tokens: this.tokens.size, sessions: this.lastTabs.size };
  }
}

/** 目标标签（缺省活动标签）；宿主未提供 activeTabId（老实现/测试假件）时返回 null。 */
export function activeTabOf(host: BrowserBackend, sessionId?: string): string | null {
  try {
    return typeof host.activeTabId === "function" ? host.activeTabId(sessionId) : null;
  } catch {
    return null;
  }
}

/**
 * ref 与标签的绑定校验：目标标签没有快照令牌、而本会话最近快照来自另一个标签时，
 * 直接给出可行动的 STALE_REF（说明是哪两个标签），而不是让注册表解析到别人的元素。
 * CSS / text= 不需要注册表，不参与该校验。
 */
export function bindRefToTab(
  bindings: SnapshotBindings,
  sessionId: string | undefined,
  tabId: string | null,
  target: string,
): { ok: boolean; message?: string } {
  if (!normalizeRef(target)) return { ok: true };
  if (bindings.registry(sessionId, tabId)) return { ok: true };
  const last = bindings.lastTab(sessionId);
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
export interface TabStatus {
  id: string;
  url: string;
  title: string;
  loading: boolean;
}

export interface SettledState {
  tab: TabStatus | null;
  navigated: boolean;
}

/** 读标签状态；宿主没有 getTab / 标签已消失时返回 null（状态行降级，不抛错）。 */
export function readTab(host: BrowserBackend, sessionId: string | undefined, tabId: string | null): TabStatus | null {
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

/** 等待指定毫秒（browser_wait 轮询用）。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * 动作后状态增量（调研 §8-4）：最多等 1.5s 让加载落定。
 *  · 先做一次 120ms 短探测：点击同步触发的导航可能还没反映到宿主状态；
 *  · 一旦命中 loading=false 立即返回，不做无谓等待；
 *  · 「发生导航」= URL 变化，或本次动作让标签进入加载。
 */
export async function settleTab(
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
export function statusLine(action: string, state: SettledState, note?: string): string {
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

/** 读 PNG IHDR 的宽高（截图尺寸展示用）；非 PNG 返回 null。 */
export function readPngSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24) return null;
  if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return null;
  if (buffer.subarray(12, 16).toString("ascii") !== "IHDR") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** 截图文件名时间戳（本地时间 YYYYMMDD-HHmmss）。 */
export function screenshotStamp(): string {
  const date = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** 极简 HTML → 文本（仅用于 web_fetch 的兜底可读化）。 */
export function htmlToText(html: string): string {
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
   * 当前模型是否支持图片输入（undefined = 能力表未填，按支持处理，交给上游裁决）。
   * 为 true/undefined 时 browser_screenshot 会把 PNG 作为工具图片回灌到模型上下文；
   * 只有明确 false（text-only 或用户在设置里关闭图片输入）才只返回路径。
   */
  visionEnabled?: () => boolean | undefined;
}

/**
 * 工具族共享上下文：显式传递依赖，取代原先 registerBrowserTools 里的隐式闭包。
 *
 * `register` 统一给失败结果补错误码（P2-1）；`needHost` 把「浏览器未就绪」变成一次
 * 可读失败而不是 undefined 解引用；指针覆盖层与钩子原样透传。
 */
export interface BrowserToolEnv {
  readonly hooks?: BrowserToolHooks;
  readonly resolveSessionRoot?: (sessionId?: string) => string;
  readonly bindings: SnapshotBindings;
  register(def: ToolDefinition): void;
  needHost(): BrowserBackend;
  /**
   * 把覆盖层光标移到目标（带缩放换算），并画高亮框。
   * 返回 null = 不画（没有覆盖层 / 该会话的网页不在前台）。
   */
  pointPointer(
    host: BrowserBackend,
    sessionId: string | undefined,
    tabId: string | null,
    point: { x: number; y: number; width?: number; height?: number },
  ): { pointer: NonNullable<BrowserToolHooks["pointer"]>; x: number; y: number } | null;
  /** 动作完成后让高亮淡出（覆盖层自身在空闲 1.6s 后隐藏整窗）。 */
  fadePointerHighlight(): void;
}

export function createBrowserToolEnv(
  registry: ToolRegistry,
  browserHost: () => BrowserBackend | null,
  resolveSessionRoot?: (sessionId?: string) => string,
  hooks?: BrowserToolHooks,
): BrowserToolEnv {
  const bindings = new SnapshotBindings();
  return {
    hooks,
    resolveSessionRoot,
    bindings,
    register(def: ToolDefinition): void {
      const execute = def.execute;
      registry.register({
        ...def,
        execute: async (ctx) => withBrowserErrorCode(await execute(ctx)),
      });
    },
    needHost(): BrowserBackend {
      const host = browserHost();
      if (!host) throw new Error("浏览器未就绪");
      return host;
    },
    pointPointer(host, sessionId, tabId, point) {
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
    },
    fadePointerHighlight(): void {
      setTimeout(() => hooks?.pointer?.highlight(null), 700);
    },
  };
}
