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
import { USER_LOCK_HOST_ATTR, USER_LOCK_HOST_ID, TARGET_POINT_SCROLL_JS } from "./userLock.js";

// 兼容旧导入（测试与 browserHost 仍从 refs 取锁脚本）。
export { USER_LOCK_HOST_ATTR, buildUserLockScript, buildAgentDrivingScript } from "./userLock.js";

// 快照脚本与元素原始类型已外置到 snapshotScript.ts（导入方继续从 refs 取，保持不变）。
import type { RawBrowserElement } from "./snapshotScript.js";
export { MAX_SNAPSHOT_ELEMENTS, MAX_VISIBLE_ELEMENTS, SNAPSHOT_SCRIPT } from "./snapshotScript.js";
export type { RawBrowserElement } from "./snapshotScript.js";

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
  /** 标签内 ref 单调递增：重快照后旧 ref 不复用，避免旧 #e5 静默落到新元素。 */
  private nextRef = 1;

  /** 快照代数：同一标签内单调递增（导航不清零）。 */
  get gen(): number {
    return this.generation;
  }

  get size(): number {
    return this.entries.size;
  }

  /** 用最新快照重建注册表（标签内 ref 单调递增，旧 ref 不再复用）；返回面向模型的元素列表。 */
  reset(raw: RawBrowserElement[]): BrowserElementSnapshot[] {
    this.entries.clear();
    this.generation += 1;
    // 先一次性分配 ref，再回填 parent：父元素在文档顺序里必然先于子元素，
    // 但用独立数组表达可以让「parentIndex → ref」不依赖遍历顺序的隐式假设。
    const refs = raw.map(() => `e${this.nextRef++}`);
    const out: BrowserElementSnapshot[] = [];
    raw.forEach((item, index) => {
      const ref = refs[index]!;
      const parentRef =
        typeof item.parentIndex === "number" && item.parentIndex >= 0 && item.parentIndex < index
          ? refs[item.parentIndex]
          : undefined;
      // matchText / parentIndex 是内部判别条件：对外元素对象里剔除，避免污染快照契约
      const element: BrowserElementSnapshot = {
        ref,
        tag: item.tag,
        role: item.role,
        name: item.name,
        selector: item.selector,
        ...(item.selectorWhy ? { selectorWhy: item.selectorWhy } : {}),
        ...(parentRef ? { parent: parentRef } : {}),
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
  // 同一个选择器常同时命中「隐藏的源 textarea」和「真正可见的编辑器」。
  // 直接 querySelector 会拿到 DOM 里第一个（往往是隐藏的），点击坐标落在 0,0 或被吸顶栏挡住。
  const isUsable = (node) => {
    if (!node || node.nodeType !== 1) return false;
    let rect;
    try { rect = node.getBoundingClientRect(); } catch (err) { return false; }
    if (!rect || rect.width < 2 || rect.height < 2) return false;
    const style = window.getComputedStyle(node);
    if (style && (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0')) return false;
    return true;
  };
  let el = null;
  if (KIND === 'text') {
    if (MATCH_TEXT) {
      // 优先「文本恰好等于目标」，其次「包含目标的元素里文本最短」：避免 text=下载 先命中整个导航容器。
      const nodes = Array.prototype.slice.call(document.querySelectorAll('a,button,[role="button"],[role="link"],summary,label'))
        .filter(isUsable)
        .sort((a, b) => { const ta = norm(a.innerText || a.textContent || ''), tb = norm(b.innerText || b.textContent || ''); return (ta === MATCH_TEXT ? 0 : 1) - (tb === MATCH_TEXT ? 0 : 1) || ta.length - tb.length; });
      el = nodes.find((node) => norm(node.innerText || node.textContent || '').indexOf(MATCH_TEXT) !== -1) || null;
    }
  } else if (KIND === 'exactText') {
    const nodes = Array.prototype.slice.call(document.querySelectorAll(SELECTOR)).filter(isUsable);
    el = nodes.find((node) => norm(node.innerText || node.textContent || '') === MATCH_TEXT) || null;
  } else {
    try {
      const nodes = document.querySelectorAll(SELECTOR);
      for (let i = 0; i < nodes.length; i += 1) {
        if (isUsable(nodes[i])) { el = nodes[i]; break; }
      }
      if (!el && nodes.length > 0) return { ok: false, code: 'ELEMENT_NOT_VISIBLE', matched: nodes.length };
    } catch (err) { return { ok: false, code: 'INVALID_SELECTOR' }; }
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

/**
 * 自动关闭遮挡弹窗（登录/引导/广告层）：点击命中被挡时先尝试自己处理，再重试原点击。
 *
 * 为什么启发式：不同站点的关闭控件五花八门（aria-label=关闭 / title=Close / 纯 × 字符 / .close）。
 * 这里按「可见 + 文案或属性像关闭 + 位于上半屏/右侧」排序选一个点掉；实在找不到就按 Esc。
 * 只是尽力而为——失败时仍返回 BLOCKED_BY_OVERLAY，让模型自己决定下一步。
 */
export function buildDismissOverlayScript(): string {
  return `(() => {
  const norm = (el) => String((el && (el.innerText || el.textContent)) || '').replace(/\\s+/g, '').slice(0, 24);
  const isCloseText = (el) => /^(×|✕|✖|关闭|close|取消|cancel|知道了|我知道了|稍后再说|以后再说)$/i.test(norm(el));
  const isCloseAttr = (el) => {
    const attrs = String(el.getAttribute && el.getAttribute('aria-label') || '') + ' ' +
      String(el.getAttribute && el.getAttribute('title') || '') + ' ' + String(el.className || '');
    return /关闭|close|cancel|dismiss/i.test(attrs);
  };
  const candidates = [];
  const nodes = document.querySelectorAll('button,[role="button"],a,span,div,i,svg');
  for (let i = 0; i < nodes.length; i += 1) {
    const el = nodes[i];
    if (!el || el.nodeType !== 1) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) continue;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || style.pointerEvents === 'none') continue;
    if (!isCloseText(el) && !isCloseAttr(el)) continue;
    // 越靠上、越靠右越像弹窗的关闭按钮
    const score = (rect.top < window.innerHeight * 0.45 ? 2 : 0) + (rect.left > window.innerWidth * 0.45 ? 1 : 0);
    candidates.push({ el: el, score: score, top: rect.top });
  }
  candidates.sort((a, b) => (b.score - a.score) || (a.top - b.top));
  const chosen = candidates[0];
  if (chosen) {
    const label = (norm(chosen.el) || chosen.el.getAttribute('aria-label') || 'close').slice(0, 24);
    try { chosen.el.click(); } catch (err) {}
    return { ok: true, action: 'click:' + label };
  }
  try {
    const ev = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
  } catch (err) {}
  return { ok: false, code: 'NOTHING_FOUND', action: 'escape' };
})()`;
}

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
  const vw = Math.max(window.innerWidth, 1), vh = Math.max(window.innerHeight, 1);
  const left = Math.max(0, rect.left), top = Math.max(0, rect.top);
  const right = Math.min(vw, rect.right), bottom = Math.min(vh, rect.bottom);
  const boxWidth = Math.max(right - left, 1), boxHeight = Math.max(bottom - top, 1);
  // 与 target-point 同一策略：中心被吸顶栏挡住时，改试元素内其他点，避免假报 BLOCKED。
  const fractions = [[0.5, 0.5], [0.5, 0.22], [0.5, 0.78], [0.22, 0.5], [0.78, 0.5], [0.5, 0.1], [0.5, 0.9]];
  let firstHit = null;
  let hitOk = false;
  if (typeof document.elementFromPoint === 'function') {
    for (let i = 0; i < fractions.length; i += 1) {
      const x = Math.min(Math.max(left + boxWidth * fractions[i][0], 0), Math.max(vw - 1, 0));
      const y = Math.min(Math.max(top + boxHeight * fractions[i][1], 0), Math.max(vh - 1, 0));
      const hit = document.elementFromPoint(x, y);
      if (!firstHit) firstHit = hit;
      // 接管锁浮层是本应用自己画的、Agent 运行期间常驻：它挡住的点击仍然是 Agent 发起的，
      // 不能判成第三方遮罩 —— 否则锁一打开 Agent 就再也点不动页面。
      const ownLock = Boolean(hit && (hit.id === ${JSON.stringify(USER_LOCK_HOST_ID)} || (hit.hasAttribute && hit.hasAttribute(${JSON.stringify(USER_LOCK_HOST_ATTR)}))));
      if (hit && (hit === el || el.contains(hit) || ownLock)) { hitOk = true; break; }
    }
    if (!hitOk) return { ok: false, code: 'BLOCKED_BY_OVERLAY', blocker: describe(firstHit), tried: fractions.length };
  }
  el.click();
  return { ok: true };
})()`;
}

/**
 * 目标落点脚本（不点击）：滚到视野中心 → 元素中心（视口 CSS 像素）→ 命中验证。
 *
 * 为什么要单独有：Agent 的点击已经改成「应用级覆盖窗口画光标 + webContents.sendInputEvent
 * 派发真实鼠标事件」——真实事件只认坐标，所以必须先把目标换算成一个点；
 * 命中验证仍在这里做，BLOCKED_BY_OVERLAY 的语义和文案与旧路径完全一致。
 */
export function buildTargetPointScript(
  resolved: ResolvedTarget,
  options: { scrollIntoView?: boolean } = {},
): string {
  return `/* loopsoar:target-point */
(async () => {
${locateJs(resolved)}
${options.scrollIntoView === false ? "" : TARGET_POINT_SCROLL_JS}

  const describe = (node) => {
    if (!node || node.nodeType !== 1) return null;
    const cls = String(node.getAttribute('class') || '').trim().split(' ').filter(Boolean).slice(0, 3).join('.');
    const raw = String(node.innerText || node.textContent || '');
    let text = '';
    for (let i = 0; i < raw.length; i += 1) text += raw.charCodeAt(i) <= 32 ? ' ' : raw.charAt(i);
    text = text.replace(/ +/g, ' ').trim().slice(0, 40);
    return { tag: node.tagName.toLowerCase(), id: node.getAttribute('id') || undefined, className: cls || undefined, text: text || undefined };
  };
  const tag = el.tagName.toLowerCase();
  const rect = el.getBoundingClientRect();
  const vw = Math.max(window.innerWidth, 1), vh = Math.max(window.innerHeight, 1);
  const left = Math.max(0, rect.left), top = Math.max(0, rect.top);
  const right = Math.min(vw, rect.right), bottom = Math.min(vh, rect.bottom);
  const boxWidth = Math.max(right - left, 1), boxHeight = Math.max(bottom - top, 1);
  // 中心点可能被吸顶工具栏/固定底栏盖住（高亮块能看见，中心却点不到）。
  // 依次试中心、上下左右与接近边缘的点，选第一个真正命中的位置；全部被挡才报 BLOCKED。
  const ownLock = (node) => Boolean(node && (node.id === ${JSON.stringify(USER_LOCK_HOST_ID)} || (node.hasAttribute && node.hasAttribute(${JSON.stringify(USER_LOCK_HOST_ATTR)}))));
  const fractions = [[0.5, 0.5], [0.5, 0.22], [0.5, 0.78], [0.22, 0.5], [0.78, 0.5], [0.5, 0.1], [0.5, 0.9]];
  let cx = Math.min(Math.max(left + boxWidth / 2, 0), Math.max(vw - 1, 0));
  let cy = Math.min(Math.max(top + boxHeight / 2, 0), Math.max(vh - 1, 0));
  let firstHit = null;
  let clicked = false;
  if (typeof document.elementFromPoint === 'function') {
    for (let i = 0; i < fractions.length; i += 1) {
      const x = Math.min(Math.max(left + boxWidth * fractions[i][0], 0), Math.max(vw - 1, 0));
      const y = Math.min(Math.max(top + boxHeight * fractions[i][1], 0), Math.max(vh - 1, 0));
      const hit = document.elementFromPoint(x, y);
      if (!firstHit) firstHit = hit;
      if (hit && (hit === el || el.contains(hit) || ownLock(hit))) {
        cx = x;
        cy = y;
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      return { ok: false, code: 'BLOCKED_BY_OVERLAY', blocker: describe(firstHit), tried: fractions.length };
    }
  }
  // 输入类元素的可编辑信息：真实键盘输入需要知道「能不能打字」「是不是多行」。
  const inputType = tag === 'input' ? String(el.getAttribute('type') || 'text').toLowerCase() : '';
  // 同源 iframe 里的富文本编辑区（UEditor 等）：iframe 本身接收真实点击后，键盘事件会进内层文档。
  let frameEditable = false;
  if (tag === 'iframe') {
    try {
      const doc = el.contentDocument;
      const body = doc && doc.body;
      frameEditable = Boolean(body && (body.isContentEditable || doc.designMode === 'on' || doc.querySelector('[contenteditable=""],[contenteditable="true"]')));
    } catch (err) {
      frameEditable = false;
    }
  }
  const editable = frameEditable || tag === 'textarea' || (tag === 'input' && ['text', 'search', 'url', 'tel', 'email', 'password', 'number'].indexOf(inputType) >= 0) || Boolean(el.isContentEditable);
  const multiline = frameEditable || tag === 'textarea' || Boolean(el.isContentEditable);
  // 可读文案：敏感步骤判定要用它（#e12 / #pay 这类选择器本身没有语义，
  // 只有元素文案才判得出「立即支付」）。aria-label > title > 文本 > value > placeholder > name。
  const labelRaw = el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.textContent || el.value || el.getAttribute('placeholder') || el.getAttribute('name') || '';
  const text = String(labelRaw).replace(/\s+/g, ' ').trim().slice(0, 80);
  return { ok: true, x: cx, y: cy, width: Math.max(rect.width, 2), height: Math.max(rect.height, 2), tag, type: inputType, editable, multiline, text };
})()`;
}

/**
 * 读取当前焦点元素的语义（press_key 的敏感判定用）。
 *
 * 为什么需要：Enter/Space 会提交表单，但工具参数里只有按键、没有元素文案——
 * 只有读出 activeElement 的 tag/type/role/name，才判得出「焦点落在一个『确认支付』按钮上」。
 * 与 target-point 脚本同样的约定：只返回 JSON-safe 结构，页面零注入。
 */
export function buildFocusProbeScript(): string {
  return `/* loopsoar:focus-probe */
(() => {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return { ok: false };
  const norm = (v) => String(v === undefined || v === null ? "" : v).replace(/\\s+/g, " ").trim();
  const tag = (el.tagName || "").toLowerCase();
  const type = tag === "input" ? String(el.getAttribute("type") || "text").toLowerCase() : "";
  const role = norm(el.getAttribute("role"));
  const name = norm(
    el.getAttribute("aria-label") ||
    el.getAttribute("title") ||
    (el.innerText || el.textContent) ||
    el.value ||
    el.getAttribute("placeholder") ||
    el.getAttribute("name") ||
    ""
  );
  return { ok: true, tag: tag, type: type, role: role, name: name.slice(0, 200) };
})()`;
}

/** 点击后的焦点校验：目标（或其子节点）必须是 activeElement，否则停止输入，避免写进验证码/登录框。 */
export function buildFocusCheckScript(resolved: ResolvedTarget): string {
  return `/* loopsoar:focus-check */
(() => {
${locateJs(resolved)}
  const active = document.activeElement;
  if (!active) return { ok: false };
  if (active === el || el.contains(active)) return { ok: true, tag: active.tagName ? active.tagName.toLowerCase() : '' };
  // 富文本 iframe：真实点击后主文档 activeElement 是 iframe，真正焦点在内层 body/contenteditable。
  if (el.tagName.toLowerCase() === 'iframe') {
    try {
      const doc = el.contentDocument;
      const inner = doc && doc.activeElement;
      if (inner && (inner === doc.body || inner.isContentEditable || /^(input|textarea)$/i.test(inner.tagName || ''))) {
        return { ok: true, tag: (inner.tagName || '').toLowerCase(), frame: true };
      }
    } catch (err) {}
  }
  return { ok: false };
})()`;
}

/** 直接把目标 focus() 到页面焦点（press_key 的 target 用；不点击，避免误触按钮）。 */
export async function performFocus(
  registry: RefRegistry | null,
  target: string,
  run: ScriptRunner,
): Promise<{ ok: boolean; message?: string }> {
  const resolved = resolveTarget(registry, target);
  if (!resolved.ok) return { ok: false, message: resolved.message };
  try {
    const page = (await run(`(() => {
${locateJs(resolved)}
  if (typeof el.focus === 'function') el.focus();
  const active = document.activeElement;
  if (active && (active === el || el.contains(active))) return { ok: true };
  // iframe 编辑区：focus() 后主文档 activeElement 可能是 iframe，内层才是真正的编辑体。
  if (el.tagName.toLowerCase() === 'iframe') {
    try {
      const doc = el.contentDocument;
      const inner = doc && (doc.activeElement || doc.body);
      if (inner) return { ok: true, frame: true };
    } catch (err) {}
  }
  return { ok: false };
})()`)) as { ok?: boolean } | null;
    return page?.ok === true
      ? { ok: true }
      : { ok: false, message: "[FOCUS_MISMATCH] 目标无法获得焦点（可能是不可聚焦元素或被弹层遮住）" };
  } catch (err) {
    return { ok: false, message: `[FOCUS_MISMATCH] 聚焦失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

/** 点击后校验焦点是否落在目标元素（含其子树）。 */
export async function performFocusCheck(
  registry: RefRegistry | null,
  target: string,
  run: ScriptRunner,
): Promise<{ ok: boolean; message?: string }> {
  const resolved = resolveTarget(registry, target);
  if (!resolved.ok) return { ok: false, message: resolved.message };
  try {
    const page = (await run(buildFocusCheckScript(resolved))) as { ok?: boolean } | null;
    if (page?.ok === true) return { ok: true };
    return {
      ok: false,
      message: "[FOCUS_MISMATCH] 点击后焦点不在目标元素，已停止输入（页面可能弹出登录/验证码/自动聚焦层）",
    };
  } catch (err) {
    return { ok: false, message: `[FOCUS_MISMATCH] 焦点校验失败：${err instanceof Error ? err.message : String(err)}` };
  }
}


/* 锁与输入放行已拆到 userLock.ts；这里保留 re-export 兼容旧导入。 */

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
  if (el.tagName.toLowerCase() === 'iframe') {
    // 富文本编辑器（UEditor 等）：内容在 iframe 的 contenteditable body 里，
    // 没有 value 可写；退回直接写 body 文本并派发 input（真实键盘路径仍优先）。
    let doc = null;
    try { doc = el.contentDocument; } catch (err) {}
    const body = doc && doc.body;
    if (!body) return { ok: false, code: 'TYPE_NOT_EFFECTIVE', actual: '' };
    try { body.focus(); } catch (err) {}
    body.textContent = TEXT;
    try { body.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: TEXT })); }
    catch (err) { body.dispatchEvent(new Event('input', { bubbles: true })); }
    body.dispatchEvent(new Event('change', { bubbles: true }));
    const actualFrame = String(body.innerText || body.textContent || '');
    const normFrame = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    if (normFrame(actualFrame) !== normFrame(TEXT) && normFrame(actualFrame).indexOf(normFrame(TEXT)) === -1) {
      return { ok: false, code: 'TYPE_NOT_EFFECTIVE', actual: actualFrame.slice(0, 200) };
    }
    return { ok: true };
  }
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

/**
 * 输入回读脚本：只读当前值，用来校验「真实键盘输入是否真的落进页面」。
 * 与 buildTypeScript 的回读口径一致（有 value 取 value，否则取 textContent）。
 */
export function buildTypeReadbackScript(resolved: ResolvedTarget): string {
  return "/* loopsoar:type-readback */\n(() => {\n" + locateJs(resolved) +
    "\n  if (el.tagName.toLowerCase() === 'iframe') {\n" +
    "    try {\n" +
    "      const doc = el.contentDocument;\n" +
    "      const body = doc && doc.body;\n" +
    "      return { ok: true, value: String((body && (body.innerText || body.textContent)) || '') };\n" +
    "    } catch (err) { return { ok: false }; }\n" +
    "  }\n" +
    "  const actual = ('value' in el) ? String(el.value == null ? '' : el.value) : String(el.textContent == null ? '' : el.textContent);\n" +
    "  return { ok: true, value: actual };\n})()";
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
  /** 选择器命中的元素全部不可见（隐藏的源输入框/折叠面板）。 */
  | "ELEMENT_NOT_VISIBLE"
  | "INVALID_SELECTOR"
  | "TYPE_NOT_EFFECTIVE"
  /** 点击命中验证失败：目标可点击区域被别的元素盖住（浮层/遮罩/吸顶条）。 */
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
  /** 命中验证尝试过的落点数（BLOCKED_BY_OVERLAY 诊断用）。 */
  tried?: number;
  /** 选择器命中但全部不可见时的命中数量。 */
  matched?: number;
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
      message: `[BLOCKED_BY_OVERLAY] ${labelOf(registry, resolved, target)} 的可点击区域被${blocker ? `「${blocker}」` : "其他元素"}遮挡${typeof page?.tried === "number" ? `（已尝试 ${page.tried} 个落点）` : ""}。建议：先关闭浮层或等待动画结束；若目标是吸顶栏下的输入框，可先 browser_scroll 把它滚到视口中部再试；或重新 browser_snapshot 换一个可见元素。`,
      ...(blocker ? { blocker } : {}),
    };
  }
  if (code === "ELEMENT_NOT_VISIBLE") {
    const matched = typeof page?.matched === "number" ? `（命中 ${page.matched} 个）` : "";
    return {
      ok: false,
      code: "ELEMENT_NOT_VISIBLE",
      message: `[ELEMENT_NOT_VISIBLE] 选择器 ${target} 命中的元素全部不可见${matched}：可能是隐藏的源输入框（如 UEditor 的同步 textarea）或折叠面板。请先 browser_snapshot，改用可见的 #eN；富文本编辑区通常用 iframe 或 contenteditable 元素。`,
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

/** 目标落点：成功时带视口 CSS 坐标与尺寸（覆盖窗口据此画光标/高亮）。 */
export interface TargetPointResult extends BrowserActionResult {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** 元素标签/输入类型；editable = 可以接收真实键盘输入（input 文本类/textarea/contenteditable）。 */
  tag?: string;
  type?: string;
  editable?: boolean;
  /** 是否多行（textarea/contenteditable）：真实输入时换行用 Enter，否则折成空格。 */
  multiline?: boolean;
  /** 元素可读文案（aria-label/文本/value/placeholder）：敏感步骤判定用，不进状态行。 */
  text?: string;
  tried?: number;
}

type PagePointResult = PageActionResult & {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  tag?: string;
  type?: string;
  editable?: boolean;
  multiline?: boolean;
  text?: string;
};

/**
 * 只定位、不点击：拿到目标中心的视口坐标（真实鼠标事件需要它）。
 * 失败翻译与 performClick 走同一个 failureOf，错误文案不会出现两套。
 */
export async function performTargetPoint(
  registry: RefRegistry | null,
  target: string,
  run: ScriptRunner,
  options: { scrollIntoView?: boolean } = {},
): Promise<TargetPointResult> {
  const resolved = resolveTarget(registry, target);
  if (!resolved.ok) return { ok: false, code: resolved.code, message: resolved.message };
  let page: PagePointResult | null = null;
  try {
    page = (await run(buildTargetPointScript(resolved, options))) as PagePointResult | null;
  } catch (err) {
    return {
      ok: false,
      code: "SCRIPT_ERROR",
      message: `[错误] 定位脚本执行失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (page?.ok && typeof page.x === "number" && typeof page.y === "number") {
    return {
      ok: true,
      label: labelOf(registry, resolved, target),
      x: page.x,
      y: page.y,
      width: page.width,
      height: page.height,
      ...(page.tag ? { tag: page.tag } : {}),
      ...(page.type ? { type: page.type } : {}),
      ...(typeof page.editable === "boolean" ? { editable: page.editable } : {}),
      ...(typeof page.multiline === "boolean" ? { multiline: page.multiline } : {}),
      ...(page.text ? { text: page.text } : {}),
      ...(resolved.ref ? { ref: resolved.ref } : {}),
      selector: resolved.selector,
    };
  }
  return failureOf(registry, resolved, target, page) as TargetPointResult;
}

/** 输入后回读（真实键盘路径用）：解析 target → 读取当前值；text= 与解析失败直接返回不可读。 */
export async function performTypeReadback(
  registry: RefRegistry | null,
  target: string,
  run: ScriptRunner,
): Promise<{ ok: boolean; value?: string }> {
  const resolved = resolveTarget(registry, target);
  if (!resolved.ok || resolved.kind === "text") return { ok: false };
  try {
    const page = (await run(buildTypeReadbackScript(resolved))) as { ok?: boolean; value?: string } | null;
    return { ok: page?.ok === true, ...(typeof page?.value === "string" ? { value: page.value } : {}) };
  } catch {
    return { ok: false };
  }
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
