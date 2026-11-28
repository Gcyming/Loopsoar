/**
 * 页面内快照脚本（SNAPSHOT_SCRIPT）与元素原始类型。
 *
 * 从 refs.ts 拆出：这段是**页面内执行的字符串模板**，不依赖 ref 解析/动作生成逻辑，
 * 却是该文件里最长的块。放在独立模块后，refs.ts 只保留「句柄 → 定位 → 动作脚本」这条主线，
 * 也让快照脚本可以单独被 CDP 后端与视图后端引用（两边必须用同一份，否则 #eN 语义漂移）。
 */
import type { BrowserElementSnapshot } from "./types.js";

/** 页面内最多为多少个元素计算句柄（防巨型页面卡死；显示层另有 80 条预算）。 */
export const MAX_SNAPSHOT_ELEMENTS = 200;

/** browser_snapshot 文本里最多显示多少个元素（超出提示重新快照）。 */
export const MAX_VISIBLE_ELEMENTS = 80;

/**
 * 页面脚本返回的原始元素：比对外类型多两个内部字段——
 * matchText（精确文本句柄的判别串）与 parentIndex（最近的可快照祖先在 picked 数组里的下标）。
 * parentIndex 让 --root 子树下钻成为真实能力：父子关系由页面内同一次遍历算出，
 * 不是事后猜选择器前缀。
 */
export type RawBrowserElement = Omit<BrowserElementSnapshot, "ref" | "parent"> & {
  matchText?: string;
  parentIndex?: number;
};

/**
 * 页面内快照脚本：只读 DOM，不写任何属性。
 * 元素范围＝可交互元素（a/button/input/textarea/select/[role=button]/[contenteditable]/
 * 有 onclick 或 tabindex 的可见元素）+ 标题 h1-h6 + 地标（main/nav/header/footer/aside）。
 */
export const SNAPSHOT_SCRIPT = `/* loopsoar:snapshot */
(() => {
  const MAX = ${MAX_SNAPSHOT_ELEMENTS};
  const SELECTOR = 'a,button,input,textarea,select,iframe,[role="button"],[role="link"],[contenteditable=""],[contenteditable="true"],[onclick],[tabindex],h1,h2,h3,h4,h5,h6,main,nav,header,footer,aside';
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
  // 同源 iframe 是否为可编辑区（UEditor 等富文本编辑器把 contenteditable body 放在 iframe 里）。
  const frameEditable = (el) => {
    if (!el || el.tagName.toLowerCase() !== 'iframe') return false;
    try {
      const doc = el.contentDocument;
      if (!doc) return false;
      if (doc.designMode === 'on') return true;
      const body = doc.body;
      if (body && body.isContentEditable) return true;
      return Boolean(doc.querySelector('[contenteditable=""],[contenteditable="true"]'));
    } catch (err) {
      // 跨域 iframe 读不到 contentDocument：按普通 frame 处理。
      return false;
    }
  };
  // 完全被别的元素盖住（例如 UEditor 的隐藏 textarea 被工具栏/iframe 盖住）时不进快照：
  // 否则模型会拿到一个「看得见名字、却永远点不到」的元素，反复重试。
  const isOccluded = (el) => {
    let rect;
    try { rect = el.getBoundingClientRect(); } catch (err) { return false; }
    const vw = Math.max(window.innerWidth, 0), vh = Math.max(window.innerHeight, 0);
    const left = Math.max(0, rect.left), top = Math.max(0, rect.top);
    const right = Math.min(vw, rect.right), bottom = Math.min(vh, rect.bottom);
    const width = right - left, height = bottom - top;
    if (width < 2 || height < 2) return true;
    const points = [[0.5, 0.5], [0.5, 0.2], [0.5, 0.8], [0.2, 0.5], [0.8, 0.5]];
    let sawOther = false;
    for (let i = 0; i < points.length; i += 1) {
      const x = Math.min(Math.max(left + width * points[i][0], 0), Math.max(vw - 1, 0));
      const y = Math.min(Math.max(top + height * points[i][1], 0), Math.max(vh - 1, 0));
      const probe = document.elementFromPoint(x, y);
      if (!probe) continue;
      if (probe === el || el.contains(probe)) return false;
      sawOther = true;
    }
    return sawOther;
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
    if (tag === 'iframe') return frameEditable(el) ? 'textbox' : 'frame';
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
    if (el.tagName.toLowerCase() === 'iframe') return frameEditable(el) ? '内嵌编辑区' : '内嵌页面';
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
    if (isOccluded(node)) continue;
    matched += 1;
    if (picked.length < MAX) picked.push(node);
  }
  // 父子关系：只在「本次实际入选」的元素之间建立，避免为了树结构把祖先强行塞进快照。
  // 祖先不在 picked 里就继续向上找，直到根；parentIndex=-1 表示顶层。
  const pickedIndex = new Map();
  for (let i = 0; i < picked.length; i += 1) pickedIndex.set(picked[i], i);
  const parentIndexOf = (el) => {
    let node = el.parentElement;
    while (node && node.nodeType === 1) {
      if (pickedIndex.has(node)) return pickedIndex.get(node);
      node = node.parentElement;
    }
    return -1;
  };
  const elements = picked.map((el) => {
    const tag = el.tagName.toLowerCase();
    const handle = selectorFor(el);
    const type = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : undefined;
    const role = roleOf(el);
    const item = { tag: tag, role: role, name: nameOf(el), selector: handle.selector, selectorWhy: handle.why };
    const parentIndex = parentIndexOf(el);
    if (parentIndex >= 0) item.parentIndex = parentIndex;
    if (handle.matchText) item.matchText = handle.matchText;
    if (type) item.type = type;
    // 值只在「输入类」元素上回传；密码框不回传（敏感数据默认不进模型上下文）
    if ((role === 'textbox' || role === 'combobox') && tag !== 'iframe') {
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
