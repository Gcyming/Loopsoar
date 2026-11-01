/**
 * BrowserAdapter 主实现：WebContentsView（Electron 官方推荐路线，ADR-0003 / D0 决策门）。
 * 为什么依赖注入而非直接 import electron：
 *   ① 适配器保持零 electron 依赖 → 可在测试里用假 view 验证语义（不启真窗口）；
 *   ② 换基座（Tauri/WebView2+CDP）时只换后端，不动 Agent 内核。
 * 选择器约定：click/type 的 target 支持「元素编号」（数字）或标准 CSS 选择器。
 * 元素编号由 markInteractive() 在每次导航后注入（可交互元素序号化，元素优先于坐标）。
 */
import type { BrowserAdapter, BrowserSnapshot } from "../types.js";

/** WebContentsView 的最小形状（真实 Electron 对象结构兼容）。 */
export interface WebContentsLike {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  capturePage(): Promise<{ toPNG(): Buffer }>;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  /** 页面缩放（Electron 0.5～2.0；测试可只实现用到的部分）。 */
  setZoomFactor?(factor: number): void;
  /** 页面事件（真实 Electron WebContents 兼容；测试可只实现用到的部分）。 */
  on(event: string, cb: (...args: unknown[]) => void): void;
}

export interface WebContentsViewLike {
  webContents: WebContentsLike;
}

export interface WebContentsAdapterOptions {
  view: WebContentsViewLike;
  /** 销毁视图（由外壳传入：从窗口移除 + 释放）。 */
  onClose?: () => void;
  /** 页面主动导航（用户点链接 / 页面重定向 / SPA 路由）→ 让外壳同步地址栏与标签状态。 */
  onNavigate?: (url: string) => void;
  /** 页面标题变化 → 标签标题同步。 */
  onTitle?: (title: string) => void;
}

/** DOM 侧注入脚本：给可交互元素打编号（data-loops-el），返回数量。 */
const MARKERS_SCRIPT = `(() => {
  let i = 0;
  const nodes = document.querySelectorAll('a,button,input,select,textarea,[role="button"],[onclick]');
  nodes.forEach((el) => { el.setAttribute('data-loops-el', String(i++)); });
  return nodes.length;
})()`;

const SNAPSHOT_SCRIPT = `(() => {
  const els = Array.from(document.querySelectorAll('[data-loops-el]')).slice(0, 200).map((el) => ({
    id: el.getAttribute('data-loops-el'),
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type') || undefined,
    text: (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 120),
    href: el.getAttribute('href') || undefined,
  }));
  return {
    url: location.href,
    title: document.title,
    text: (document.body ? document.body.innerText : '').slice(0, 20000),
    elements: els,
  };
})()`;

function selectorFor(target: string): string {
  const trimmed = target.trim();
  if (/^\d+$/.test(trimmed)) return `[data-loops-el="${trimmed}"]`;
  return trimmed; // 交给 querySelector 处理；非法选择器会抛错由调用方感知
}

function jsString(value: string): string {
  return JSON.stringify(value);
}

export function createWebContentsViewAdapter(opts: WebContentsAdapterOptions): BrowserAdapter {
  const { view } = opts;
  const wc = view.webContents;

  async function markInteractive(): Promise<number> {
    try {
      const n = await wc.executeJavaScript(MARKERS_SCRIPT, false);
      return typeof n === "number" ? n : 0;
    } catch {
      return 0; // 页面尚未就绪：由调用方（navigate）决定是否重试
    }
  }

  async function waitDomReady(): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      wc.on("dom-ready", done);
      // 兜底：事件可能早于监听注册，用一次轻量 JS 探测确认后就绪
      wc.executeJavaScript("document.readyState", false)
        .then(() => done())
        .catch(() => done());
      setTimeout(done, 15_000);
    });
  }

  // 关键：用户点网页里的链接不会经过外壳的 navigate()，必须靠 WebContents 事件
  // 把地址回传给外壳；否则会出现"地址栏与网页各说各话"（网址与网页割裂）。
  if (opts.onNavigate) {
    // Electron 签名：(event, url, ...)；取 args[1]，否则地址栏会变成 [object Object]
    wc.on("did-navigate", (...args) => opts.onNavigate?.(String(args[1] ?? "")));
    wc.on("did-navigate-in-page", (...args) => opts.onNavigate?.(String(args[1] ?? "")));
  }
  // 页面缩放快捷键（Ctrl + =/-/0）：WebContentsView 有独立焦点，主窗口快捷键捕获不到，
  // 必须在每个标签自己的 webContents 上监听。
  let zoomFactor = 1;
  wc.on("before-input-event", (...args) => {
    const event = args[0] as { preventDefault?: () => void } | undefined;
    const input = args[1] as { type?: string; key?: string; control?: boolean; meta?: boolean; shift?: boolean } | undefined;
    if (!input || input.type !== "keyDown" || !(input.control || input.meta)) return;
    const key = input.key ?? "";
    let next = zoomFactor;
    if (key === "0") next = 1;
    else if (key === "+" || key === "=") next = Math.round((zoomFactor + 0.1) * 10) / 10;
    else if (key === "-" || key === "_") next = Math.round((zoomFactor - 0.1) * 10) / 10;
    else return;
    event?.preventDefault?.();
    zoomFactor = Math.max(0.5, Math.min(2, next));
    wc.setZoomFactor?.(zoomFactor);
  });

  if (opts.onTitle) {
    // Electron 签名：(event, title, explicitSet) —— 取 args[1]，否则会把 event 渲染成 [object Object]
    wc.on("page-title-updated", (...args) => opts.onTitle?.(String(args[1] ?? "")));
  }

  return {
    async navigate(url: string) {
      await wc.loadURL(url);
      await waitDomReady();
      await markInteractive();
      return { url: wc.getURL() || url };
    },

    async snapshot(): Promise<BrowserSnapshot> {
      await markInteractive();
      const raw = (await wc.executeJavaScript(SNAPSHOT_SCRIPT, false)) as {
        url: string;
        title: string;
        text: string;
        elements: unknown[];
      };
      return {
        url: raw.url,
        title: raw.title,
        text: raw.text,
        elements: raw.elements,
      } as BrowserSnapshot & { elements: unknown[] };
    },

    async click(target: string) {
      const sel = selectorFor(target);
      const code = `(() => {
        const el = document.querySelector(${jsString(sel)});
        if (!el) throw new Error('元素不存在: ' + ${jsString(sel)});
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      })()`;
      await wc.executeJavaScript(code, true);
    },

    async type(target: string, text: string) {
      const sel = selectorFor(target);
      const code = `(() => {
        const el = document.querySelector(${jsString(sel)});
        if (!el) throw new Error('元素不存在: ' + ${jsString(sel)});
        el.focus();
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(el, ${jsString(text)});
        else el.value = ${jsString(text)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`;
      await wc.executeJavaScript(code, true);
    },

    async scroll(dir: "down" | "up" | "top" | "bottom") {
      const code = `(() => {
        if (${jsString(dir)} === 'top') window.scrollTo({ top: 0, behavior: 'instant' });
        else if (${jsString(dir)} === 'bottom') window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' });
        else window.scrollBy({ top: (${jsString(dir)} === 'down' ? 1 : -1) * window.innerHeight * 0.8, behavior: 'instant' });
        return true;
      })()`;
      await wc.executeJavaScript(code, true);
    },

    async screenshot(): Promise<string> {
      const image = await wc.capturePage();
      return image.toPNG().toString("base64");
    },

    async wait(ms: number) {
      await new Promise((r) => setTimeout(r, Math.max(0, ms)));
    },

    async executeJs(code: string) {
      return wc.executeJavaScript(code, true);
    },

    setZoom(factor: number) {
      wc.setZoomFactor?.(factor);
    },

    async close() {
      opts.onClose?.();
    },
  };
}
