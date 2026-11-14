/**
 * 元素引用（ref）注册表与动作解析：观察-动作闭环（P0-2）的单一产地。
 *
 * 为什么要单独一层：
 *   ① 旧实现用 MARKERS_SCRIPT 往 DOM 上打 data-loops-el（不清理 → 幽灵编号；每次快照重排 → 编号漂移）。
 *      这里改成「页面内算稳定句柄 + 进程内建注册表」，DOM 上一个属性都不写，问题从根上消失；
 *   ② ref（e1..eN）只是显示别名，真正的句柄是页面内按稳定性打分算出的选择器；
 *      注册表按标签令牌（tabToken）索引，每次快照重建、主框架导航清空；
 *   ③ 动作解析顺序 ref → CSS 选择器 → text= 只在本模块实现一次：
 *      适配器的 click/type 与 browserTools 都调用 performClick/performType，不再各写一份 querySelector；
 *   ④ 失败必须可行动（原则 13）：STALE_REF / ELEMENT_NOT_FOUND（带 top3 候选）/ 输入未生效 + 当前值。
 */
import type { BrowserElementSnapshot } from "./types.js";

/** 页面内最多为多少个元素计算句柄（防巨型页面卡死；显示层另有 80 条预算）。 */
export const MAX_SNAPSHOT_ELEMENTS = 200;

/** browser_snapshot 文本里最多显示多少个元素（超出提示重新快照）。 */
export const MAX_VISIBLE_ELEMENTS = 80;

/** 页面脚本返回的原始元素：比对外类型多一个 matchText（精确文本句柄的判别串）。 */
export type RawBrowserElement = Omit<BrowserElementSnapshot, "ref"> & { matchText?: string };

/**
 * 页面内快照脚本：只读 DOM，不写任何属性。
 * 元素范围＝可交互元素（a/button/input/textarea/select/[role=button]/[contenteditable]/
 * 有 onclick 或 tabindex 的可见元素）+ 标题 h1-h6 + 地标（main/nav/header/footer/aside）。
 */
export const SNAPSHOT_SCRIPT = `/* loopsoar:snapshot */
(() => {
  const MAX = ${MAX_SNAPSHOT_ELEMENTS};
  const SELECTOR = 'a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable=""],[contenteditable="true"],[onclick],[tabindex],h1,h2,h3,h4,h5,h6,main,nav,header,footer,aside';
  const norm = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
  const textOf = (el) => norm(el.innerText || el.textContent || '');
  const cssEscape = (value) => {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(String(value));
    return String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\\\' + ch);
  };
  const attrSelector = (tag, attr, value) => {
    const escaped = String(value).replace(/["\\\\]/g, (ch) => '\\\\' + ch);
    return tag + '[' + attr + '="' + escaped + '"]';
  };
  const isVisible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    let rect = null;
    try { rect = el.getBoundingClientRect(); } catch (err) { return false; }
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(el);
    if (!style) return true;
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (style.opacity === '0') return false;
    return true;
  };
  const isUnique = (selector) => {
    try { return document.querySelectorAll(selector).length === 1; } catch (err) { return false; }
  };
  // 稳定性打分：唯一 id > name > aria-label > data-testid > 精确文本（a/button，≤60）> 结构路径
  const selectorFor = (el) => {
    const tag = el.tagName.toLowerCase();
    const id = el.getAttribute('id');
    if (id) {
      const candidate = '#' + cssEscape(id);
      if (isUnique(candidate)) return { selector: candidate, why: 'id' };
    }
    const name = el.getAttribute('name');
    if (name) {
      const candidate = attrSelector(tag, 'name', name);
      if (isUnique(candidate)) return { selector: candidate, why: 'name' };
    }
    const aria = el.getAttribute('aria-label');
    if (aria) {
      const candidate = attrSelector(tag, 'aria-label', aria);
      if (isUnique(candidate)) return { selector: candidate, why: 'aria-label' };
    }
    const testId = el.getAttribute('data-testid');
    if (testId) {
      const candidate = '[data-testid="' + String(testId).replace(/["\\\\]/g, (ch) => '\\\\' + ch) + '"]';
      if (isUnique(candidate)) return { selector: candidate, why: 'data-testid' };
    }
    if (tag === 'a' || tag === 'button') {
      const text = textOf(el);
      if (text && text.length <= 60) {
        const same = Array.prototype.filter.call(document.querySelectorAll(tag), (node) => textOf(node) === text);
        if (same.length === 1) return { selector: tag, why: 'text', matchText: text };
      }
    }
    let path = '';
    let node = el;
    while (node && node.nodeType === 1) {
      const parent = node.parentElement;
      if (!parent) break;
      const index = Array.prototype.indexOf.call(parent.children, node) + 1;
      const part = node.tagName.toLowerCase() + ':nth-child(' + index + ')';
      path = path ? part + ' > ' + path : part;
      if (isUnique(path)) return { selector: path, why: 'path' };
      if (node === document.body) break;
      node = parent;
    }
    return { selector: path || tag, why: 'path' };
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.trim();
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'text';
    if (tag === 'button') return 'button';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
      if (type === 'file') return 'file';
      if (type === 'hidden') return 'hidden';
      return 'textbox';
    }
    if (tag === 'main') return 'main';
    if (tag === 'nav') return 'navigation';
    if (tag === 'header') return 'banner';
    if (tag === 'footer') return 'contentinfo';
    if (tag === 'aside') return 'complementary';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (el.isContentEditable) return 'textbox';
    return 'generic';
  };
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return norm(aria).slice(0, 100);
    const text = textOf(el);
    if (text) return text.slice(0, 100);
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) return norm(placeholder).slice(0, 100);
    const alt = el.getAttribute('alt');
    if (alt) return norm(alt).slice(0, 100);
    const title = el.getAttribute('title');
    if (title) return norm(title).slice(0, 100);
    const name = el.getAttribute('name');
    if (name) return norm(name).slice(0, 100);
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'submit' || type === 'button') return norm(el.value || type);
    return '';
  };

  const all = Array.prototype.slice.call(document.querySelectorAll(SELECTOR));
  const picked = [];
  let matched = 0;
  for (let i = 0; i < all.length; i += 1) {
    const node = all[i];
    if (!isVisible(node)) continue;
    matched += 1;
    if (picked.length < MAX) picked.push(node);
  }
  const elements = picked.map((el) => {
    const tag = el.tagName.toLowerCase();
    const handle = selectorFor(el);
    const type = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : undefined;
    const role = roleOf(el);
    const item = { tag: tag, role: role, name: nameOf(el), selector: handle.selector, selectorWhy: handle.why };
    if (handle.matchText) item.matchText = handle.matchText;
    if (type) item.type = type;
    // 值只在「输入类」元素上回传；密码框不回传（敏感数据默认不进模型上下文）
    if (role === 'textbox' || role === 'combobox') {
      const raw = el.value == null ? '' : String(el.value);
      if (type !== 'password') item.value = raw.slice(0, 200);
    }
    const href = el.getAttribute('href');
    if (tag === 'a' && href) item.href = href.slice(0, 300);
    if (el.disabled === true) item.disabled = true;
    if ((type === 'checkbox' || type === 'radio') && typeof el.checked === 'boolean') item.checked = Boolean(el.checked);
    return item;
  });
  return {
    url: location.href,
    title: document.title,
    text: (document.body ? document.body.innerText : '').slice(0, 20000),
    elements: elements,
    elementTotal: matched,
  };
})()`;

/** 一个 ref 的句柄：选择器 +（可选）精确文本消歧串。 */
export interface RefHandle {
  selector: string;
  /**
   * 精确文本句柄：选择器会命中多个同类元素时用文本消歧（a/button 且文本 ≤60 字符）。
   * 这是本模块内部的判别条件，不进入 BrowserElementSnapshot。
   */
  matchText?: string;
}

interface RefEntry {
  ref: string;
  handle: RefHandle;
  element: BrowserElementSnapshot;
}

/**
 * 一个标签的 ref 注册表：快照时整体重建，导航时整体清空。
 * 只存选择器（不是 DOM 节点），所以 SPA 局部重渲染后同选择器通常仍能命中。
 */
export class RefRegistry {
  private entries = new Map<string, RefEntry>();
  private generation = 0;

  /** 快照代数：同一标签内单调递增（导航不清零）。 */
  get gen(): number {
    return this.generation;
  }

  get size(): number {
    return this.entries.size;
  }

  /** 用最新快照重建注册表（ref 按页面文档顺序重排 e1..eN）；返回面向模型的元素列表。 */
  reset(raw: RawBrowserElement[]): BrowserElementSnapshot[] {
    this.entries.clear();
    this.generation += 1;
    const out: BrowserElementSnapshot[] = [];
    raw.forEach((item, index) => {
      const ref = `e${index + 1}`;
      // matchText 是内部判别条件：对外元素对象里剔除，避免污染快照契约
      const element: BrowserElementSnapshot = {
        ref,
        tag: item.tag,
        role: item.role,
        name: item.name,
        selector: item.selector,
        ...(item.selectorWhy ? { selectorWhy: item.selectorWhy } : {}),
        ...(item.value !== undefined ? { value: item.value } : {}),
        ...(item.type ? { type: item.type } : {}),
        ...(item.href ? { href: item.href } : {}),
        ...(item.disabled ? { disabled: true } : {}),
        ...(item.checked !== undefined ? { checked: item.checked } : {}),
      };
      const handle: RefHandle = item.matchText
        ? { selector: item.selector, matchText: item.matchText }
        : { selector: item.selector };
      this.entries.set(ref, { ref, handle, element });
      out.push(element);
    });
    return out;
  }

  /** 导航（主框架）后清空：旧 ref 一律失效，动作会得到 STALE_REF 而不是「装作成功」。 */
  clear(): void {
    this.entries.clear();
  }

  get(ref: string): RefEntry | undefined {
    const key = normalizeRef(ref);
    return key ? this.entries.get(key) : undefined;
  }

  /** 当前注册表里的元素（按 ref 顺序）。 */
  list(): BrowserElementSnapshot[] {
    return [...this.entries.values()].map((entry) => entry.element);
  }
}

/**
 * 把 target 里的 ref 别名归一化成 "eN"：
 * 支持 "e5" / "E5" / "5" / "#e5" / "[#e5]"；不是 ref 返回 null。
 */
export function normalizeRef(target: string): string | null {
  const raw = target.trim();
  const match = /^(?:\[?#)?e?(\d+)\]?$/i.exec(raw);
  if (!match) return null;
  return `e${Number(match[1])}`;
}

/** 归一化检索串：去掉 text= 前缀与选择器符号，只留可比较的字符。 */
function normalizeQuery(query: string): string {
  return query
    .replace(/^\s*text=/i, "")
    .toLowerCase()
    .replace(/[^0-9a-z\u4e00-\u9fa5]+/g, " ")
    .trim();
}

/**
 * 按 name/role/tag 的相近度取候选（ELEMENT_NOT_FOUND 的可行动信息，最多 3 个）。
 * 为什么按名字找：模型看到的是 [#e3] button "提交"，失败时给同类候选比只回「未找到」有用得多。
 */
export function findCandidates(registry: RefRegistry | null, query: string, limit = 3): BrowserElementSnapshot[] {
  if (!registry || registry.size === 0 || limit <= 0) return [];
  const needle = normalizeQuery(query);
  if (!needle) return [];
  const tokens = needle.split(" ").filter((token) => token.length >= 2);
  const scored: { element: BrowserElementSnapshot; score: number }[] = [];
  for (const element of registry.list()) {
    const name = element.name.toLowerCase();
    const role = element.role.toLowerCase();
    const tag = element.tag.toLowerCase();
    let score = 0;
    if (name && name === needle) score = 100;
    else if (name && (name.includes(needle) || needle.includes(name))) score = 70;
    else if (role === needle || tag === needle) score = 40;
    else if (tokens.some((token) => name.includes(token))) score = 30;
    else if (tokens.some((token) => role.includes(token) || tag.includes(token))) score = 10;
    if (score > 0 && name) scored.push({ element, score });
  }
  scored.sort((a, b) => b.score - a.score || a.element.ref.localeCompare(b.element.ref, "en", { numeric: true }));
  return scored.slice(0, limit).map((item) => item.element);
}

/** 候选元素的一行文本（带 #eN 与 name）。 */
export function formatCandidates(candidates: BrowserElementSnapshot[]): string {
  return candidates.map((el) => `#${el.ref} ${el.role} "${el.name.slice(0, 40)}"`).join("；");
}

/** 解析后的定位描述。 */
export interface ResolvedTarget {
  /** 来源：ref / css / text=（text= 只做可点击元素的文本包含匹配）。 */
  kind: "ref" | "css" | "text";
  /** 页面定位模式：css=querySelector；text=可点击元素文本包含；exactText=选择器内精确文本。 */
  mode: "css" | "text" | "exactText";
  selector: string;
  matchText?: string;
  ref?: string;
}

export interface TargetError {
  ok: false;
  code: "STALE_REF" | "INVALID_TARGET";
  message: string;
}

export type TargetResolution = ({ ok: true } & ResolvedTarget) | TargetError;

/**
 * 把模型传入的 target 解析成页面可执行的定位描述。
 * 顺序（向后兼容）：① ref → 注册表句柄；② CSS 选择器；③ text= 前缀。
 */
export function resolveTarget(registry: RefRegistry | null, target: string): TargetResolution {
  const raw = target.trim();
  if (!raw) return { ok: false, code: "INVALID_TARGET", message: "[错误] target 为空" };
  const ref = normalizeRef(raw);
  if (ref) {
    const entry = registry?.get(ref);
    if (!entry) {
      const hint =
        registry && registry.size > 0 ? "页面已导航或已重新快照" : "注册表为空：可能尚未快照，或页面已导航";
      return {
        ok: false,
        code: "STALE_REF",
        message: `[STALE_REF] 引用 #${ref} 已过期（${hint}），请重新 browser_snapshot 后用最新 #eN`,
      };
    }
    return {
      ok: true,
      kind: "ref",
      mode: entry.handle.matchText ? "exactText" : "css",
      selector: entry.handle.selector,
      ...(entry.handle.matchText ? { matchText: entry.handle.matchText } : {}),
      ref,
    };
  }
  if (/^text=/i.test(raw)) {
    return { ok: true, kind: "text", mode: "text", selector: "", matchText: raw.slice(5).trim() };
  }
  return { ok: true, kind: "css", mode: "css", selector: raw };
}

/** 页面内定位元素的前置代码（click / scrollIntoView 共用；text= 的匹配逻辑只此一处）。 */
function locateJs(resolved: ResolvedTarget): string {
  return `
  const KIND = ${JSON.stringify(resolved.mode)};
  const SELECTOR = ${JSON.stringify(resolved.selector)};
  const MATCH_TEXT = ${JSON.stringify(resolved.matchText ?? "")};
  const norm = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
  let el = null;
  if (KIND === 'text') {
    const want = MATCH_TEXT;
    if (want) {
      const nodes = Array.prototype.slice.call(document.querySelectorAll('a,button,[role="button"],[role="link"],summary,label'));
      el = nodes.find((node) => norm(node.innerText || node.textContent || '').indexOf(want) !== -1) || null;
    }
  } else if (KIND === 'exactText') {
    const nodes = Array.prototype.slice.call(document.querySelectorAll(SELECTOR));
    el = nodes.find((node) => norm(node.innerText || node.textContent || '') === MATCH_TEXT) || null;
  } else {
    try { el = document.querySelector(SELECTOR); } catch (err) { return { ok: false, code: 'INVALID_SELECTOR' }; }
  }
  if (!el) return { ok: false, code: 'ELEMENT_NOT_FOUND' };
`;
}

/**
 * 点击脚本（由适配器/工具层统一执行；脚本只回状态码，错误文案在 Node 侧生成）。
 *
 * 命中验证（调研 §8-6）：scrollIntoView 之后、el.click() 之前，用 elementFromPoint
 * 校验元素中心点是否真的落在目标上。被遮罩/浮层挡住时 el.click() 依然会「成功」，
 * 模型会误以为点到了；这里先返回 BLOCKED_BY_OVERLAY + 遮挡元素摘要（Node 侧成文）。
 */
export function buildClickScript(resolved: ResolvedTarget): string {
  return `(() => {
${locateJs(resolved)}
  el.scrollIntoView({ block: 'center' });
  const describe = (node) => {
    if (!node || node.nodeType !== 1) return null;
    const cls = String(node.getAttribute('class') || '').trim().split(' ').filter(Boolean).slice(0, 3).join('.');
    const raw = String(node.innerText || node.textContent || '');
    let text = '';
    for (let i = 0; i < raw.length; i += 1) text += raw.charCodeAt(i) <= 32 ? ' ' : raw.charAt(i);
    text = text.replace(/ +/g, ' ').trim().slice(0, 40);
    return { tag: node.tagName.toLowerCase(), id: node.getAttribute('id') || undefined, className: cls || undefined, text: text || undefined };
  };
  const rect = el.getBoundingClientRect();
  const cx = Math.min(Math.max(rect.left + rect.width / 2, 0), Math.max(window.innerWidth - 1, 0));
  const cy = Math.min(Math.max(rect.top + rect.height / 2, 0), Math.max(window.innerHeight - 1, 0));
  if (typeof document.elementFromPoint === 'function') {
    const hit = document.elementFromPoint(cx, cy);
    // 接管锁浮层是本应用自己画的、Agent 运行期间常驻：它挡住的点击仍然是 Agent 发起的，
    // 不能判成第三方遮罩 —— 否则锁一打开 Agent 就再也点不动页面。
    const ownLock = Boolean(hit && (hit.id === ${JSON.stringify(USER_LOCK_HOST_ID)} || hit.hasAttribute(${JSON.stringify(USER_LOCK_HOST_ATTR)})));
    if (hit && hit !== el && !el.contains(hit) && !ownLock) return { ok: false, code: 'BLOCKED_BY_OVERLAY', blocker: describe(hit) };
  }
  el.click();
  return { ok: true };
})()`;
}

/**
 * Agent 虚拟光标：在页面里画出「指针移动到目标 + 目标高亮框 + 点击涟漪」。
 * 实现要点：
 *   · 全部挂在 documentElement 的 **closed shadow root** 里（页面样式/CSP 影响不到，页面 DOM 不被污染）；
 *   · pointer-events:none（不改变页面行为）、固定定位（不触发页面重排）；
 *   · 只做视觉，失败也不影响动作本身（调用方 .catch 忽略）。
 */
export function buildCursorScript(resolved: ResolvedTarget, ripple: boolean): string {
  return `(() => {
${locateJs(resolved)}
  const doc = document;
  const KEY = '__loopsoarAgentOverlay';
  let root = window[KEY];
  if (!root || !root.host || !doc.documentElement.contains(root.host)) {
    // 不用 <style> 标签：严格 CSP 站点会拦；全部走元素级 CSSOM + WAAPI（调研 §3 的结论）。
    const host = doc.createElement('div');
    host.setAttribute('data-loopsoar-agent', 'overlay');
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    doc.documentElement.appendChild(host);
    window[KEY] = root;
  }
  const rect = el.getBoundingClientRect();
  const cx = Math.min(Math.max(rect.left + rect.width / 2, 4), Math.max(window.innerWidth - 4, 4));
  const cy = Math.min(Math.max(rect.top + rect.height / 2, 4), Math.max(window.innerHeight - 4, 4));
  let cursor = root.querySelector('.cursor');
  if (!cursor) {
    cursor = doc.createElement('div');
    cursor.className = 'cursor';
    cursor.style.cssText =
      'position:fixed;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;' +
      'background:rgba(217,138,79,.95);box-shadow:0 0 0 3px rgba(217,138,79,.22),0 2px 10px rgba(0,0,0,.45);' +
      'transition:left .16s cubic-bezier(.2,0,.2,1),top .16s cubic-bezier(.2,0,.2,1);';
    root.appendChild(cursor);
  }
  const prev = cursor.__lspos || { x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight / 2) };
  cursor.style.left = prev.x + 'px'; cursor.style.top = prev.y + 'px';
  cursor.__lspos = { x: cx, y: cy };
  requestAnimationFrame(() => requestAnimationFrame(() => { cursor.style.left = cx + 'px'; cursor.style.top = cy + 'px'; }));
  const box = doc.createElement('div');
  box.className = 'box';
  box.style.cssText = 'position:fixed;border:2px solid rgba(217,138,79,.8);border-radius:6px;background:rgba(217,138,79,.10);transition:opacity .3s;';
  box.style.left = Math.max(rect.left - 2, 0) + 'px';
  box.style.top = Math.max(rect.top - 2, 0) + 'px';
  box.style.width = Math.max(rect.width + 4, 6) + 'px';
  box.style.height = Math.max(rect.height + 4, 6) + 'px';
  root.appendChild(box);
  setTimeout(() => { box.style.opacity = '0'; setTimeout(() => box.remove(), 320); }, 520);
  if (ripple) {
    const ring = doc.createElement('div');
    ring.className = 'ring';
    ring.style.cssText =
      'position:fixed;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;' +
      'border:2px solid rgba(217,138,79,.9);';
    ring.style.left = cx + 'px';
    ring.style.top = cy + 'px';
    root.appendChild(ring);
    try {
      ring.animate(
        [
          { width: '12px', height: '12px', margin: '-6px 0 0 -6px', opacity: 1 },
          { width: '56px', height: '56px', margin: '-28px 0 0 -28px', opacity: 0 },
        ],
        { duration: 520, easing: 'ease-out', fill: 'forwards' },
      );
    } catch (err) {}
    setTimeout(() => ring.remove(), 620);
  }
  return { ok: true, x: cx, y: cy };
})()`;
}

/** 让光标动画走完再执行动作（毫秒）：既看得见，又不至于拖慢长任务。 */
export const CURSOR_LEAD_MS = 170;

/**
 * 接管锁浮层的宿主属性：注入到页面 DOM 上时唯一可识别的标记
 * （closed shadow root 内部页面拿不到，宿主节点是唯一可检测/可清理的锚点）。
 */
export const USER_LOCK_HOST_ATTR = "data-loopsoar-lock";

/** 浮层宿主 id（固定值：解锁时即使 window 状态丢了也能按 id 清掉残留节点）。 */
const USER_LOCK_HOST_ID = "loopsoar-user-lock";

/** 浮层拦截的事件类型：覆盖鼠标/滚轮/键盘/输入/拖拽，全部在 capture 阶段抢先处理。 */
const USER_LOCK_EVENTS = [
  "pointerdown",
  "pointerup",
  "pointermove",
  "click",
  "wheel",
  "contextmenu",
  "keydown",
  "keyup",
  "beforeinput",
  "dragstart",
];

/** 浮层文案的 HTML 转义（label 来自 i18n，仍按不可信输入处理：它最终进 innerHTML）。 */
function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 页面内公共前导：解绑旧监听 + 删除旧宿主。
 * 为什么先清旧的：Agent 反复锁定/解锁、或页面把浮层节点搬走时，
 * 只有「先删再建」才能保证重复调用幂等（不会叠加多层遮罩、不会泄漏监听）。
 */
function userLockPreambleJs(): string {
  return `  const KEY = '__loopsoarUserLock';
  const HOST_ID = ${JSON.stringify(USER_LOCK_HOST_ID)};
  const ATTR = ${JSON.stringify(USER_LOCK_HOST_ATTR)};
  const EVENTS = ${JSON.stringify(USER_LOCK_EVENTS)};
  const doc = document;
  const prev = window[KEY];
  if (prev && typeof prev.handler === 'function') {
    for (let i = 0; i < EVENTS.length; i += 1) {
      try { window.removeEventListener(EVENTS[i], prev.handler, true); } catch (err) {}
    }
  }
  try { delete window[KEY]; } catch (err) { window[KEY] = null; }
  // 宿主节点可能因页面重渲染或异常中断残留：按 id 或属性都能找到并清掉。
  const stale = doc.getElementById(HOST_ID) || doc.querySelector('[' + ATTR + ']');
  if (stale && stale.parentNode) stale.parentNode.removeChild(stale);`;
}

/**
 * Agent 接管锁脚本（会话运行期间浮在当前网页上，阻止用户操作该页面）。
 *
 * 关键约束：只拦 **isTrusted === true** 的真实用户事件。
 *   · 合成事件（el.click() / dispatchEvent）的 isTrusted 一定是 false：
 *     它们同样会经过捕获阶段，若无条件拦截，Agent 会把自己的动作一起锁死；
 *   · 监听挂在 window 的 capture 阶段：比页面自己的 document 监听更早，
 *     页面里注册的 handler 收不到事件（stopImmediatePropagation 连同一节点上的后续监听也停掉）。
 *
 * locked=false 时只做清理（解绑 + 删宿主），不建浮层：解锁必须能救回一个「锁坏了」的页面。
 */
export function buildUserLockScript(locked: boolean, label: string): string {
  if (!locked) {
    return `(() => {
${userLockPreambleJs()}
  return { ok: true, locked: false, removed: Boolean(prev || stale) };
})()`;
  }
  // 文案先转义再放进 innerHTML：closed shadow root 里没有其它注入面，转义后即可安全插入。
  const safeLabel = escapeHtmlText(label);
  return `(() => {
${userLockPreambleJs()}
  const host = doc.createElement('div');
  host.id = HOST_ID;
  host.setAttribute(ATTR, 'active');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:auto;';
  const root = typeof host.attachShadow === 'function' ? host.attachShadow({ mode: 'closed' }) : host;
  // 只做「透明输入拦截层」：不再给整页压暗（用户要求：运行期用网页四周的呼吸灯表达，
  // 而不是把页面变暗）。层本身不画任何背景，但保留 pointer-events 以吞掉真实点击。
  const mask = doc.createElement('div');
  mask.style.cssText = 'position:absolute;inset:0;background:transparent;pointer-events:auto;display:flex;align-items:flex-start;justify-content:center;';
  // 提示文案：无边框无底色块，中心（文字处）最实、向四周均匀渐隐（用户指定的渲染样式）。
  const hint = doc.createElement('div');
  hint.style.cssText = 'margin-top:46px;max-width:min(620px,88vw);padding:16px 36px;color:#f7f2e8;font:500 13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;text-align:center;background:radial-gradient(120% 150% at 50% 42%, rgba(12,14,20,.94) 0%, rgba(12,14,20,.78) 38%, rgba(12,14,20,.42) 60%, rgba(12,14,20,0) 82%);border:0;box-shadow:none;pointer-events:none;';
  hint.innerHTML = ${JSON.stringify(safeLabel)};
  mask.appendChild(hint);
  root.appendChild(mask);
  (doc.documentElement || doc.body || doc).appendChild(host);
  const handler = (event) => {
    if (!event || event.isTrusted !== true) return;
    try { event.preventDefault(); } catch (err) {}
    try { event.stopImmediatePropagation(); } catch (err) {}
  };
  for (let i = 0; i < EVENTS.length; i += 1) {
    // capture=true：抢在页面自身的监听之前把真实用户输入拦下。
    window.addEventListener(EVENTS[i], handler, true);
  }
  window[KEY] = { host: host, handler: handler };
  return { ok: true, locked: true };
})()`;
}

/** 把目标元素滚进视野（截图前定位用）。 */
export function buildScrollIntoViewScript(resolved: ResolvedTarget): string {
  return `(() => {
${locateJs(resolved)}
  el.scrollIntoView({ block: 'center' });
  return { ok: true };
})()`;
}

/**
 * 输入脚本：原生 setter + InputEvent + 回读校验。
 * 为什么不用 el.value = x：React 的 value tracker 不更新，受控组件会把输入回滚，
 * 表现为「工具返回成功但页面没变」（原则 7）。
 */
export function buildTypeScript(resolved: ResolvedTarget, text: string): string {
  // 定位与 click 共用同一段 locateJs：ref 句柄可能是「精确文本」型（matchText），
  // 若这里直接用 querySelector(selector)，文本型句柄会打到同标签的第一个元素上。
  return `(() => {
${locateJs(resolved)}
  const TEXT = ${JSON.stringify(text)};
  el.scrollIntoView({ block: 'center' });
  try { el.focus(); } catch (err) {}
  if ('value' in el) {
    // 原生 setter：走原型链上的 value 描述符，才能推进 React 的 value tracker
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && typeof desc.set === 'function') desc.set.call(el, TEXT);
    else el.value = TEXT;
  } else {
    el.textContent = TEXT;
  }
  try {
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: TEXT }));
  } catch (err) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  el.dispatchEvent(new Event('change', { bubbles: true }));
  const actual = ('value' in el) ? String(el.value == null ? '' : el.value) : String(el.textContent == null ? '' : el.textContent);
  // 回读校验：返回「成功」但页面没变，是受控组件拒绝输入的典型表现
  if (actual !== TEXT) return { ok: false, code: 'TYPE_NOT_EFFECTIVE', actual: actual.slice(0, 200) };
  return { ok: true };
})()`;
}

/** 按键白名单：13 个命名键（浏览器交互常用）+ 单个可见字符。 */
export const NAMED_KEYS = [
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
] as const;

/** 命名键 → KeyboardEvent.code（单字符另算）。 */
const NAMED_KEY_CODES: Record<string, string> = {
  Enter: "Enter",
  Tab: "Tab",
  Escape: "Escape",
  Backspace: "Backspace",
  Delete: "Delete",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  " ": "Space",
};

/**
 * 按键是否在白名单内。
 * 为什么要有白名单：模型很容易传 "Control" / "F5" / "Shift+A" 这类组合，
 * 合成事件既到不了原生默认行为，又会让模型误以为已生效 —— 直接拒绝更可行动。
 */
export function isSupportedKey(key: string): boolean {
  if ((NAMED_KEYS as readonly string[]).includes(key)) return true;
  if (key.length !== 1) return false;
  const code = key.charCodeAt(0);
  return code >= 32 && code !== 127;
}

/** 按键对应的 KeyboardEvent.code（单字符 → KeyX / DigitN；其余空串）。 */
export function keyCodeOf(key: string): string {
  if (NAMED_KEY_CODES[key]) return NAMED_KEY_CODES[key];
  if (/^[a-zA-Z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return "";
}

/** 旧式 keyCode（部分页面仍读 event.keyCode；命名键给真实值，单字符给字符码）。 */
export function keyCodeNumber(key: string): number {
  const named: Record<string, number> = {
    Enter: 13,
    Tab: 9,
    Escape: 27,
    Backspace: 8,
    Delete: 46,
    ArrowUp: 38,
    ArrowDown: 40,
    ArrowLeft: 37,
    ArrowRight: 39,
    Home: 36,
    End: 35,
    PageUp: 33,
    PageDown: 34,
    " ": 32,
  };
  if (typeof named[key] === "number") return named[key];
  return key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0;
}

/**
 * 按键脚本：先（可选）聚焦目标，再派发 keydown/keypress/keyup。
 *
 * 为什么还要 requestSubmit 兜底：合成的 KeyboardEvent 不触发浏览器原生默认行为
 * （Enter 的隐式表单提交就是典型），只发事件会出现「按了没反应」。
 * 因此在 keydown 未被 preventDefault、目标是 input/button 且有 form 时，
 * 显式调用 form.requestSubmit()，并把实际路径回传给工具层文案。
 */
export function buildPressKeyScript(resolved: ResolvedTarget | null, key: string): string {
  const locate = resolved ? locateJs(resolved) : "  const el = null;";
  return `(() => {
${locate}
  const KEY = ${JSON.stringify(key)};
  const CODE = ${JSON.stringify(keyCodeOf(key))};
  const KEY_CODE = ${keyCodeNumber(key)};
  if (el) el.scrollIntoView({ block: 'center' });
  const active = el || (document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body);
  if (!active) return { ok: false, code: 'ELEMENT_NOT_FOUND' };
  try { active.focus(); } catch (err) {}
  const init = { key: KEY, code: CODE, bubbles: true, cancelable: true, composed: true, keyCode: KEY_CODE, which: KEY_CODE };
  const fire = (type) => {
    try { return active.dispatchEvent(new KeyboardEvent(type, init)); }
    catch (err) { return active.dispatchEvent(new Event(type, { bubbles: true, cancelable: true })); }
  };
  const down = fire('keydown');
  let path = 'keydown+keyup';
  if (KEY === 'Enter' || KEY.length === 1) {
    fire('keypress');
    path = 'keydown+keypress+keyup';
  }
  fire('keyup');
  // 合成事件到不了原生默认行为：Enter 的表单隐式提交在这里兜底
  const tag = active.tagName ? active.tagName.toLowerCase() : '';
  const form = active.form;
  if (KEY === 'Enter' && down !== false && form && typeof form.requestSubmit === 'function' && (tag === 'input' || tag === 'button')) {
    try { form.requestSubmit(); path = path + '+requestSubmit 兜底'; } catch (err) {}
  }
  return { ok: true, path: path };
})()`;
}

/**
 * 下拉选择脚本：values 依次按 option.value 匹配，退而按可见文本匹配；
 * 原生 setter 设值（受控组件才收得到）+ input/change 事件 + selectedOptions 回读校验。
 */
export function buildSelectScript(resolved: ResolvedTarget, values: string[]): string {
  return `(() => {
${locateJs(resolved)}
  const VALUES = ${JSON.stringify(values)};
  if (!(el instanceof HTMLSelectElement)) return { ok: false, code: 'NOT_A_SELECT', tag: el.tagName ? el.tagName.toLowerCase() : '' };
  const flat = (value) => {
    const raw = String(value == null ? '' : value);
    let out = '';
    for (let i = 0; i < raw.length; i += 1) out += raw.charCodeAt(i) <= 32 ? ' ' : raw.charAt(i);
    return out.replace(/ +/g, ' ').trim();
  };
  const options = Array.prototype.slice.call(el.options);
  const chosen = [];
  const missing = [];
  for (let i = 0; i < VALUES.length; i += 1) {
    const wanted = VALUES[i];
    const byValue = options.filter((opt) => opt.value === wanted)[0];
    const hit = byValue || options.filter((opt) => flat(opt.textContent).toLowerCase() === flat(wanted).toLowerCase())[0];
    if (hit) chosen.push(hit);
    else missing.push(wanted);
  }
  if (missing.length > 0) {
    return { ok: false, code: 'OPTION_NOT_FOUND', missing: missing, options: options.slice(0, 10).map((opt) => opt.value || flat(opt.textContent)) };
  }
  if (el.multiple) {
    for (let i = 0; i < options.length; i += 1) options[i].selected = chosen.indexOf(options[i]) !== -1;
  } else {
    // 原生 setter：与输入同一处理，React 的 value tracker 才会推进
    const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    if (desc && typeof desc.set === 'function') desc.set.call(el, chosen[0].value);
    else el.value = chosen[0].value;
  }
  try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (err) {}
  el.dispatchEvent(new Event('change', { bubbles: true }));
  const selectedOptions = Array.prototype.slice.call(el.options).filter((opt) => opt.selected);
  const actual = selectedOptions.map((opt) => opt.value);
  const expected = el.multiple ? chosen.map((opt) => opt.value) : [chosen[0].value];
  let ok = true;
  for (let i = 0; i < expected.length; i += 1) if (actual.indexOf(expected[i]) === -1) ok = false;
  if (!el.multiple && actual.length !== 1) ok = false;
  if (!ok) return { ok: false, code: 'SELECT_NOT_EFFECTIVE', actual: actual.join(', ') };
  return { ok: true, selected: selectedOptions.map((opt) => flat(opt.textContent || opt.value).slice(0, 60)) };
})()`;
}

/**
 * 悬停脚本：滚进视野 + 派发 pointerover/pointerenter/mouseover/mouseenter/mousemove。
 * 冒泡按规范：over 冒泡、enter 不冒泡（下拉菜单/悬浮卡片依赖这一区别）。
 */
export function buildHoverScript(resolved: ResolvedTarget): string {
  return `(() => {
${locateJs(resolved)}
  el.scrollIntoView({ block: 'center' });
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y, view: window };
  const fired = [];
  const pointer = (type, bubbles) => {
    try { el.dispatchEvent(new PointerEvent(type, Object.assign({}, base, { bubbles: bubbles, pointerType: 'mouse', isPrimary: true }))); }
    catch (err) { el.dispatchEvent(new MouseEvent(type, Object.assign({}, base, { bubbles: bubbles }))); }
    fired.push(type);
  };
  const mouse = (type, bubbles) => {
    el.dispatchEvent(new MouseEvent(type, Object.assign({}, base, { bubbles: bubbles })));
    fired.push(type);
  };
  pointer('pointerover', true);
  pointer('pointerenter', false);
  mouse('mouseover', true);
  mouse('mouseenter', false);
  mouse('mousemove', true);
  return { ok: true, events: fired };
})()`;
}

/** 动作失败码（原则 13：失败必须可行动）。 */
export type BrowserActionCode =
  | "STALE_REF"
  | "INVALID_TARGET"
  | "ELEMENT_NOT_FOUND"
  | "INVALID_SELECTOR"
  | "TYPE_NOT_EFFECTIVE"
  /** 点击命中验证失败：目标中心点被别的元素盖住（浮层/遮罩/吸顶条）。 */
  | "BLOCKED_BY_OVERLAY"
  /** 按键不在白名单。 */
  | "INVALID_KEY"
  /** browser_select 的目标不是 <select>。 */
  | "NOT_A_SELECT"
  /** 下拉框里没有匹配的 option。 */
  | "OPTION_NOT_FOUND"
  /** 选择被页面回滚（selectedOptions 回读不一致）。 */
  | "SELECT_NOT_EFFECTIVE"
  | "SCRIPT_ERROR";

/** 一次动作的结果（工具层转成文案；适配器失败时抛 BrowserActionError）。 */
export interface BrowserActionResult {
  ok: boolean;
  code?: BrowserActionCode;
  /** 面向模型的完整错误文案（已带 [码] 前缀）。 */
  message?: string;
  /** 成功时回显的目标描述（ref 命中时形如 [#e1] link "登录"）。 */
  label?: string;
  ref?: string;
  selector?: string;
  /** 动作细节（按键实际路径 / 下拉选中项 / 悬停派发的事件）——工具层拼进文案。 */
  detail?: string;
  /** BLOCKED_BY_OVERLAY 时的遮挡元素摘要（≤60 字）。 */
  blocker?: string;
  /** ELEMENT_NOT_FOUND 时的候选（≤3，按 name/role 相近度）。 */
  candidates?: BrowserElementSnapshot[];
  /** 输入/选择未生效时页面回读到的值。 */
  actualValue?: string;
}

/** 页面脚本执行器（适配器传 wc.executeJavaScript，工具层传 host.executeScript）。 */
export type ScriptRunner = (script: string) => Promise<unknown>;

interface PageActionResult {
  ok?: boolean;
  code?: string;
  actual?: string;
  /** 旧适配器/假件可能只回一句人话原因；有就优先用（兼容既有返回形状）。 */
  reason?: string;
  /** 遮挡元素（BLOCKED_BY_OVERLAY）。 */
  blocker?: { tag?: string; id?: string; className?: string; text?: string } | null;
  /** 目标实际标签（NOT_A_SELECT）。 */
  tag?: string;
  /** 没匹配到的 option 值（OPTION_NOT_FOUND）。 */
  missing?: string[];
  /** 当前下拉框可选 option（OPTION_NOT_FOUND，最多 10 个）。 */
  options?: string[];
  /** 按键实际触发的路径（keydown+keypress+keyup[+requestSubmit 兜底]）。 */
  path?: string;
  /** 悬停派发的事件名。 */
  events?: string[];
  /** 下拉框回读到的选中项。 */
  selected?: string[];
}

/** 遮挡元素摘要：`div.modal-mask "登录弹窗"`（≤60 字）。 */
function blockerSummary(blocker: PageActionResult["blocker"]): string {
  if (!blocker || !blocker.tag) return "";
  const id = blocker.id ? `#${blocker.id}` : "";
  const cls = blocker.className ? `.${blocker.className}` : "";
  const text = blocker.text ? ` "${blocker.text.slice(0, 40)}"` : "";
  const full = `${blocker.tag}${id}${cls}${text}`;
  return full.length > 60 ? `${full.slice(0, 59)}…` : full;
}

function labelOf(registry: RefRegistry | null, resolved: ResolvedTarget | null, target: string): string {
  if (!resolved || !resolved.ref) return target;
  const entry = registry?.get(resolved.ref);
  if (!entry) return `#${resolved.ref}`;
  const name = entry.element.name ? ` "${entry.element.name.slice(0, 40)}"` : "";
  return `[#${resolved.ref}] ${entry.element.role}${name}`;
}

function failureOf(
  registry: RefRegistry | null,
  resolved: ResolvedTarget | null,
  target: string,
  page: PageActionResult | null,
): BrowserActionResult {
  const code = page?.code;
  if (code === "BLOCKED_BY_OVERLAY") {
    const blocker = blockerSummary(page?.blocker);
    return {
      ok: false,
      code: "BLOCKED_BY_OVERLAY",
      message: `[BLOCKED_BY_OVERLAY] ${labelOf(registry, resolved, target)} 的中心点被${blocker ? `「${blocker}」` : "其他元素"}遮挡，el.click() 可能点不到它。建议：先关闭浮层或等待动画结束，或把目标滚动到可见区域后重新 browser_snapshot，或改用更具体的 CSS 选择器。`,
      ...(blocker ? { blocker } : {}),
    };
  }
  if (code === "NOT_A_SELECT") {
    return {
      ok: false,
      code: "NOT_A_SELECT",
      message: `[NOT_A_SELECT] ${labelOf(registry, resolved, target)} 不是 <select>（实际 <${page?.tag || "unknown"}>）。browser_select 只能用于下拉框；文本输入请用 browser_type。`,
    };
  }
  if (code === "OPTION_NOT_FOUND") {
    const missing = (page?.missing ?? []).join("、");
    const options = (page?.options ?? []).slice(0, 10).join("；");
    return {
      ok: false,
      code: "OPTION_NOT_FOUND",
      message: `[OPTION_NOT_FOUND] 下拉框里没有匹配的选项：${missing}。可用选项：${options || "（空）"}。values 先按 option.value 精确匹配，退而按可见文本匹配。`,
    };
  }
  if (code === "SELECT_NOT_EFFECTIVE") {
    const actual = page?.actual ?? "";
    return {
      ok: false,
      code: "SELECT_NOT_EFFECTIVE",
      message: `[SELECT_NOT_EFFECTIVE] 选择未生效：selectedOptions 回读为 "${actual}"。页面可能把选中项回滚了，建议先 browser_click 展开下拉框再选，或改用更具体的 CSS 选择器定位 select。`,
      actualValue: actual,
    };
  }
  if (code === "TYPE_NOT_EFFECTIVE") {
    const actual = page?.actual ?? "";
    return {
      ok: false,
      code: "TYPE_NOT_EFFECTIVE",
      message: `[错误] 输入未生效：目标当前值为 "${actual}"。可能被受控组件回滚，建议先 browser_click 聚焦后重试，或换用更具体的 CSS 选择器。`,
      actualValue: actual,
    };
  }
  if (code === "INVALID_SELECTOR") {
    return {
      ok: false,
      code: "INVALID_SELECTOR",
      message: `[ELEMENT_NOT_FOUND] 选择器无效：${target}。请用 #eN、合法 CSS 选择器或 text=...`,
    };
  }
  // 候选按「本来的意图」找：ref 过期时用该 ref 的名字，而不是 "e3" 这种别名字符串
  const query = resolved?.ref ? (registry?.get(resolved.ref)?.element.name ?? "") || target : target;
  const candidates = findCandidates(registry, query);
  const hint = candidates.length
    ? `候选：${formatCandidates(candidates)}。建议改用上面的 #eN，或重新 browser_snapshot。`
    : "当前快照里没有相近元素，建议重新 browser_snapshot 确认页面是否已变化。";
  // 页面脚本只回状态码；旧实现/假件可能回一句 reason，有就沿用（对模型更具体）
  const detail = page?.reason ? page.reason : `未找到元素：${target}`;
  return {
    ok: false,
    code: "ELEMENT_NOT_FOUND",
    message: `[ELEMENT_NOT_FOUND] ${detail}。${hint}`,
    ...(candidates.length ? { candidates } : {}),
  };
}

/** 点击：解析 target → 生成脚本 → 执行 → 失败翻译成可行动错误。工具层与适配器共用。 */
export async function performClick(
  registry: RefRegistry | null,
  target: string,
  run: ScriptRunner,
): Promise<BrowserActionResult> {
  const resolved = resolveTarget(registry, target);
  if (!resolved.ok) return { ok: false, code: resolved.code, message: resolved.message };
  let page: PageActionResult | null = null;
  try {
    // 先画光标/高亮/涟漪（纯视觉，失败不影响点击），再执行真正的点击
    await run(buildCursorScript(resolved, true)).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, CURSOR_LEAD_MS));
    page = (await run(buildClickScript(resolved))) as PageActionResult | null;
  } catch (err) {
    return {
      ok: false,
      code: "SCRIPT_ERROR",
      message: `[错误] 点击脚本执行失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (page?.ok) {
    return {
      ok: true,
      label: labelOf(registry, resolved, target),
      ...(resolved.ref ? { ref: resolved.ref } : {}),
      selector: resolved.selector,
    };
  }
  return failureOf(registry, resolved, target, page);
}

/** 输入：解析 target → 原生 setter 脚本 → 回读校验 → 可行动错误。 */
export async function performType(
  registry: RefRegistry | null,
  target: string,
  text: string,
  run: ScriptRunner,
): Promise<BrowserActionResult> {
  const resolved = resolveTarget(registry, target);
  if (!resolved.ok) return { ok: false, code: resolved.code, message: resolved.message };
  if (resolved.kind === "text") {
    return {
      ok: false,
      code: "ELEMENT_NOT_FOUND",
      message: `[ELEMENT_NOT_FOUND] text= 只能用于点击；输入请用 #eN 或 CSS 选择器（当前：${target}）`,
    };
  }
  let page: PageActionResult | null = null;
  try {
    await run(buildCursorScript(resolved, false)).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, CURSOR_LEAD_MS));
    page = (await run(buildTypeScript(resolved, text))) as PageActionResult | null;
  } catch (err) {
    return {
      ok: false,
      code: "SCRIPT_ERROR",
      message: `[错误] 输入脚本执行失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (page?.ok) {
    return {
      ok: true,
      label: labelOf(registry, resolved, target),
      ...(resolved.ref ? { ref: resolved.ref } : {}),
      selector: resolved.selector,
    };
  }
  return failureOf(registry, resolved, target, page);
}

/**
 * 通用动作执行：解析 target（null = 当前焦点/body）→ 生成脚本 → 执行。
 * 为什么单独抽出来：press_key / select / hover 的失败翻译必须与 click/type 完全一致，
 * 否则同一个 STALE_REF 会出现两种文案。
 */
async function executeAction(options: {
  registry: RefRegistry | null;
  target: string | null;
  run: ScriptRunner;
  build: (resolved: ResolvedTarget | null) => string;
  allowText?: boolean;
  scriptName: string;
}): Promise<{ resolved: ResolvedTarget | null; page: PageActionResult | null; failure?: BrowserActionResult }> {
  let resolved: ResolvedTarget | null = null;
  if (options.target !== null) {
    const parsed = resolveTarget(options.registry, options.target);
    if (!parsed.ok) {
      return { resolved: null, page: null, failure: { ok: false, code: parsed.code, message: parsed.message } };
    }
    if (parsed.kind === "text" && !options.allowText) {
      return {
        resolved: null,
        page: null,
        failure: {
          ok: false,
          code: "ELEMENT_NOT_FOUND",
          message: `[ELEMENT_NOT_FOUND] text= 只能用于点击；${options.scriptName}请用 #eN 或 CSS 选择器（当前：${options.target}）`,
        },
      };
    }
    resolved = parsed;
  }
  let page: PageActionResult | null = null;
  try {
    page = (await options.run(options.build(resolved))) as PageActionResult | null;
  } catch (err) {
    return {
      resolved,
      page: null,
      failure: {
        ok: false,
        code: "SCRIPT_ERROR",
        message: `[错误] ${options.scriptName}脚本执行失败：${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
  return { resolved, page };
}

/** 成功结果装配（ref/selector/detail 只在有值时出现，避免契约里出现 undefined 键）。 */
function successOf(
  registry: RefRegistry | null,
  resolved: ResolvedTarget | null,
  target: string,
  detail?: string,
): BrowserActionResult {
  return {
    ok: true,
    label: labelOf(registry, resolved, target),
    ...(resolved?.ref ? { ref: resolved.ref } : {}),
    ...(resolved?.selector ? { selector: resolved.selector } : {}),
    ...(detail ? { detail } : {}),
  };
}

/**
 * 按键：聚焦目标（可选）→ keydown/keypress/keyup；Enter 的表单提交用 requestSubmit 兜底。
 * detail 回传实际路径，工具层据此告诉模型「这次到底走了哪条路」。
 */
export async function performPressKey(
  registry: RefRegistry | null,
  target: string | null,
  key: string,
  run: ScriptRunner,
): Promise<BrowserActionResult> {
  const executed = await executeAction({
    registry,
    target,
    run,
    build: (resolved) => buildPressKeyScript(resolved, key),
    scriptName: "按键",
  });
  if (executed.failure) return executed.failure;
  const { resolved, page } = executed;
  if (page?.ok) {
    const result = successOf(registry, resolved, target ?? key, page.path ? `路径：${page.path}` : undefined);
    return target ? result : { ...result, label: "当前焦点/body" };
  }
  return failureOf(registry, resolved, target ?? key, page);
}

/** 下拉选择：原生 setter + input/change + selectedOptions 回读校验。 */
export async function performSelect(
  registry: RefRegistry | null,
  target: string,
  values: string[],
  run: ScriptRunner,
): Promise<BrowserActionResult> {
  const executed = await executeAction({
    registry,
    target,
    run,
    build: (resolved) => buildSelectScript(resolved as ResolvedTarget, values),
    scriptName: "下拉选择",
  });
  if (executed.failure) return executed.failure;
  const { resolved, page } = executed;
  if (page?.ok) {
    const selected = (page.selected ?? []).join("、");
    return successOf(registry, resolved, target, selected ? `已选中：${selected}` : undefined);
  }
  return failureOf(registry, resolved, target, page);
}

/** 悬停：滚进视野 + 派发 pointerover/pointerenter/mouseover/mouseenter/mousemove。 */
export async function performHover(
  registry: RefRegistry | null,
  target: string,
  run: ScriptRunner,
): Promise<BrowserActionResult> {
  const executed = await executeAction({
    registry,
    target,
    run,
    build: (resolved) => buildHoverScript(resolved as ResolvedTarget),
    scriptName: "悬停",
  });
  if (executed.failure) return executed.failure;
  const { resolved, page } = executed;
  if (page?.ok) {
    const events = page.events ?? [];
    return successOf(
      registry,
      resolved,
      target,
      events.length ? `派发 ${events.length} 个事件：${events.join("/")}` : undefined,
    );
  }
  return failureOf(registry, resolved, target, page);
}

/** 把目标元素滚进视野（browser_screenshot 的 selector 参数用）。 */
export async function performScrollIntoView(
  registry: RefRegistry | null,
  target: string,
  run: ScriptRunner,
): Promise<BrowserActionResult> {
  const resolved = resolveTarget(registry, target);
  if (!resolved.ok) return { ok: false, code: resolved.code, message: resolved.message };
  let page: PageActionResult | null = null;
  try {
    page = (await run(buildScrollIntoViewScript(resolved))) as PageActionResult | null;
  } catch (err) {
    return {
      ok: false,
      code: "SCRIPT_ERROR",
      message: `[错误] 滚动脚本执行失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (page?.ok) return { ok: true, label: labelOf(registry, resolved, target), selector: resolved.selector };
  return failureOf(registry, resolved, target, page);
}

/** 适配器动作失败（与工具层的返回值同源；调用方可按 code 分类处理）。 */
export class BrowserActionError extends Error {
  readonly code: BrowserActionCode | undefined;
  readonly result: BrowserActionResult;

  constructor(result: BrowserActionResult) {
    super(result.message ?? "浏览器动作失败");
    this.name = "BrowserActionError";
    this.code = result.code;
    this.result = result;
  }
}

let tabSeq = 0;
const registries = new Map<string, RefRegistry>();

/**
 * 新建一个标签注册表（每个标签适配器一个）。
 * 令牌随快照返回，工具层据此定位「这个会话最近快照的是哪个标签」。
 */
export function createTabRegistry(): { token: string; registry: RefRegistry } {
  tabSeq += 1;
  const token = `tab-${tabSeq}`;
  const registry = new RefRegistry();
  registries.set(token, registry);
  return { token, registry };
}

/** 按令牌取注册表（未知/缺省令牌返回 null → 动作按 ref 解析时得到 STALE_REF）。 */
export function getTabRegistry(token: string | null | undefined): RefRegistry | null {
  if (!token) return null;
  return registries.get(token) ?? null;
}

/** 关闭标签时丢弃注册表（避免长会话里残留）。 */
export function dropTabRegistry(token: string): void {
  registries.delete(token);
}
