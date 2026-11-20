/** 浏览器工具的输出格式化：标签列表、元素行、快照渲染、正文裁剪；与行为逻辑分开，
 *  避免 browserTools.ts 继续膨胀，也让「快照完整性 / 子树下钻」只有一处实现。 */
import type { TabState } from "./browserHost.js";
import type { BrowserElementSnapshot } from "../browserAdapter/types.js";
import { normalizeRef } from "../browserAdapter/refs.js";

/** 标签列表最多展示多少条（超出只报剩余数量，防多标签会话刷屏）。 */
export const MAX_TABS_SHOWN = 12;
/** browser_snapshot 文本里最多显示多少个元素（超出提示重新快照）。 */
export const MAX_VISIBLE_ELEMENTS = 80;
/** skeleton 视图的元素上限（比 full 更小：它是地图，不是清单）。 */
export const MAX_SKELETON_ELEMENTS = 40;

export function formatTabList(tabs: TabState[]): string {
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

export function formatElement(el: BrowserElementSnapshot): string {
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

export function clip(text: string, max = 8000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[已截断，共 ${text.length} 字符]`;
}

const SKELETON_ROLES = new Set([
  "main",
  "navigation",
  "banner",
  "contentinfo",
  "complementary",
  "heading",
  "search",
  "button",
]);

/**
 * 坐标点击「点空」文案：命中元素但没有文案/不可交互时给出可行动诊断。
 * 返回 null 表示可以继续点击（命中可交互元素或有文案）。
 */
export function pointMissMessage(probe: unknown): string | null {
  const p = (probe ?? {}) as {
    x?: number;
    y?: number;
    tag?: string;
    text?: string;
    clickable?: boolean;
    viewport?: { width: number; height: number };
    box?: { left: number; top: number; width: number; height: number };
  };
  if (p.text || p.clickable === true) return null;
  const hit = p.box
    ? `命中 ${p.tag ?? "元素"} @${p.box.left},${p.box.top} ${p.box.width}x${p.box.height}`
    : `命中 ${p.tag ?? "页面空白"}`;
  const viewport = p.viewport ? `，视口 ${p.viewport.width}x${p.viewport.height}` : "";
  return `[NO_TARGET] 坐标 (${p.x},${p.y}) 没有可点击元素（${hit}${viewport}；无文案/非交互）`;
}

export interface SnapshotRenderInput {
  url: string;
  title: string;
  text: string;
  elements: BrowserElementSnapshot[];
  elementTotal?: number;
  snapshotGen?: number;
  /** 快照所属标签是不是 Agent 任务页（user-tab 要显式提示）。 */
  agentBound: boolean;
  view: "full" | "skeleton";
  maxChars?: number;
  /** 子树根（#eN / eN）：只渲染该元素及其后代。 */
  root?: string;
  /** 相对根的深度上限（1=只看直接子级）；缺省不限。 */
  depth?: number;
}

export interface SnapshotRenderResult {
  ok: boolean;
  content: string;
}

interface SubtreeItem {
  el: BrowserElementSnapshot;
  /** 相对根的深度；根为 0。 */
  depth: number;
}

/**
 * 计算以 rootRef 为根的子树（含根）。父子关系来自快照脚本的 parent 链，
 * 不靠选择器前缀猜——所以 SPA/重复选择器也不会串树。
 */
export function selectSubtree(
  elements: BrowserElementSnapshot[],
  rootRef: string,
  maxDepth?: number,
): { found: boolean; items: SubtreeItem[]; truncatedByDepth: boolean } {
  const byRef = new Map(elements.map((el) => [el.ref, el]));
  if (!byRef.has(rootRef)) return { found: false, items: [], truncatedByDepth: false };
  const limit = typeof maxDepth === "number" ? maxDepth : Number.POSITIVE_INFINITY;
  const items: SubtreeItem[] = [];
  let truncatedByDepth = false;
  for (const el of elements) {
    if (el.ref === rootRef) {
      items.push({ el, depth: 0 });
      continue;
    }
    // 从元素向上走 parent 链，直到撞上根（命中）或走完（不相关）。
    let distance = 0;
    let cursor: BrowserElementSnapshot | undefined = el;
    let hitRoot = false;
    while (cursor?.parent) {
      distance += 1;
      if (cursor.parent === rootRef) {
        hitRoot = true;
        break;
      }
      cursor = byRef.get(cursor.parent);
      if (!cursor) break;
    }
    if (!hitRoot) continue;
    if (distance <= limit) items.push({ el, depth: distance });
    else truncatedByDepth = true;
  }
  return { found: true, items, truncatedByDepth };
}

/** 渲染快照（头行 + 正文 + 元素块）。工具层只负责取数与记录 token。 */
export function renderSnapshot(input: SnapshotRenderInput): SnapshotRenderResult {
  const view = input.view;
  const maxChars = input.maxChars ?? 8000;
  const body = clip(input.text ?? "", maxChars);
  const all = input.elements ?? [];
  const total = typeof input.elementTotal === "number" ? input.elementTotal : all.length;

  let pool: SubtreeItem[] = all.map((el) => ({ el, depth: 0 }));
  let rootNote = "";
  let truncatedByDepth = false;
  if (input.root) {
    const rootRef = normalizeRef(input.root);
    if (!rootRef) {
      return {
        ok: false,
        content: `[INVALID_ARGS] root 只接受快照里的 #eN（如 #e12）；收到 ${JSON.stringify(input.root)}`,
      };
    }
    const subtree = selectSubtree(all, rootRef, input.depth);
    if (!subtree.found) {
      return {
        ok: false,
        content: `[STALE_REF] root=#${rootRef} 不在当前快照里；重新 browser_snapshot 后再下钻。`,
      };
    }
    pool = subtree.items;
    truncatedByDepth = subtree.truncatedByDepth;
    rootNote = ` | root=#${rootRef}${typeof input.depth === "number" ? ` depth=${input.depth}` : ""}`;
  }

  const withSkeleton = view === "skeleton" ? pool.filter((item) => SKELETON_ROLES.has(item.el.role)) : pool;
  const limit = view === "skeleton" ? MAX_SKELETON_ELEMENTS : MAX_VISIBLE_ELEMENTS;
  const shown = withSkeleton.slice(0, limit);
  const omitted = withSkeleton.length - shown.length;
  const hiddenByView = pool.length - withSkeleton.length;
  const lines = shown.map(({ el, depth }) =>
    depth > 0 ? `${"  ".repeat(depth)}${formatElement(el)}` : formatElement(el),
  );

  const moreParts: string[] = [];
  if (omitted > 0) moreParts.push(`本视图还有 ${omitted} 个未显示（上限 ${limit}）`);
  if (hiddenByView > 0) moreParts.push(`skeleton 视图隐藏了 ${hiddenByView} 个非地标/非按钮元素`);
  if (truncatedByDepth) moreParts.push(`depth=${input.depth} 截断了更深的后代（去掉 depth 或调大它）`);
  const more = moreParts.length ? `\n…${moreParts.join("；")}。可切 view=full、调大 depth 或滚动后重新快照。` : "";

  const scope = input.root ? `子树 ${withSkeleton.length} 个（页面共 ${total} 个）` : `共 ${total} 个`;
  const elementBlock = lines.length
    ? `可交互元素（${scope}${view === "skeleton" ? "，skeleton 视图" : ""}；用 #eN 定位，也可用 CSS 选择器或 text=...）：\n${lines.join("\n")}${more}`
    : input.root
      ? "可交互元素：该子树下没有可交互元素。"
      : "可交互元素：未发现。";

  const gen = input.snapshotGen ?? 0;
  // complete=false：适配器截断 / 视图截断 / depth 截断，任一成立都不算整棵树已读完。
  // root 视图看的是子树完整性（页面总数已在 scope 里说明），不被全局截断连带判假。
  const complete = (input.root ? true : total <= all.length) && omitted === 0 && !truncatedByDepth;
  const sourceNote = input.agentBound
    ? ""
    : "\n来源：用户全局标签（user-tab）——不是 Agent 任务页，操作前先确认目标。";
  return {
    ok: true,
    content: `[快照 #${gen} | complete=${complete} | view=${view}${rootNote} | ${input.url} | ${input.title} | source=${input.agentBound ? "agent-tab" : "user-tab"}]\n\n${body}\n\n${elementBlock}${sourceNote}`,
  };
}
