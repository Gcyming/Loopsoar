/**
 * BrowserAdapter 主实现：WebContentsView（Electron 官方推荐路线，ADR-0003 / D0 决策门）。
 * 为什么依赖注入而非直接 import electron：
 *   ① 适配器保持零 electron 依赖 → 可在测试里用假 view 验证语义（不启真窗口）；
 *   ② 换基座（Tauri/WebView2+CDP）时只换后端，不动 Agent 内核。
 * 引用约定（P0-2）：快照返回的 #eN 只是显示别名，句柄是页面内算出的稳定选择器；
 * 注册表在本适配器内（每标签一份），快照重建、主框架导航清空；
 * 动作由 BrowserHost 统一走 refs.ts 的真实输入链路，适配器只负责快照/导航/脚本/视图生命周期。
 */
import type { BrowserAdapter, BrowserLoadFailure, BrowserSnapshot } from "../types.js";
import {
  SNAPSHOT_SCRIPT,
  createTabRegistry,
  dropTabRegistry,
  type RawBrowserElement,
} from "../refs.js";

/** WebContentsView 的最小形状（真实 Electron 对象结构兼容）。 */
export interface WebContentsLike {
  /** WebContents id（真实 Electron 必有；测试假实现可缺省）。 */
  id?: number;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  capturePage(): Promise<{ toPNG(): Buffer }>;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  /** 页面缩放（Electron 0.5～2.0；测试可只实现用到的部分）。 */
  setZoomFactor?(factor: number): void;
  /** 页面事件（真实 Electron WebContents 兼容；测试可只实现用到的部分）。 */
  on(event: string, cb: (...args: unknown[]) => void): void;
  /** 静音（关闭标签时先静音，保证被移除的页面立即停止出声；旧 Electron/测试可不实现）。 */
  setAudioMuted?(muted: boolean): void;
  /** 关闭并销毁 WebContents（Electron 30+ 支持；不实现时退回仅 detach）。 */
  close?(): void;
  /** 开发者工具（WebContentsView 支持 detach 模式；测试假实现可不提供）。 */
  openDevTools?(options?: { mode?: "detach" | "bottom" | "right" | "undocked" }): void;
  closeDevTools?(): void;
  isDevToolsOpened?(): boolean;
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
  /** 页面图标更新（已转成 data: URL：渲染层 CSP 只允许 self/data:）。 */
  onFavicon?: (dataUrl: string) => void;
  /** 把 page-favicon-updated 给出的 URL 抓成 data URL；缺省不抓取（测试不联网）。 */
  fetchFavicon?: (url: string) => Promise<string | null>;
  /** 页面内按 F12 / Ctrl+Shift+I：外壳切开发者工具（网页有独立焦点，主窗口收不到）。 */
  onDevToolsRequest?: () => void;
  /** 页面开始加载（主框架/子资源都会触发；外壳用 loading 状态显示加载页）。 */
  onLoadStart?: () => void;
  /** 页面加载结束（无论成功/失败；外壳据此收掉加载页）。 */
  onLoadEnd?: () => void;
  /** 页面加载失败（did-fail-load；-3 ERR_ABORTED 由后端过滤，不回调）。 */
  onLoadFailure?: (failure: BrowserLoadFailure) => void;
}

// 快照脚本与 ref 解析统一在 refs.ts：本文件不再给 DOM 打标记（
// 「旧标记不清理」「编号每次重排」两个缺陷从根上消失）。这里只保留脚本参数序列化。

export function createWebContentsViewAdapter(opts: WebContentsAdapterOptions): BrowserAdapter {
  const { view } = opts;
  const wc = view.webContents;
  // 本标签的 ref 注册表：快照时重建、主框架导航清空；令牌随快照回传给工具层
  const refs = createTabRegistry();

  async function waitDomReady(): Promise<void> {
    // 每次导航都会调用这里：监听器与兜底定时器必须在 settle 后立刻释放，
    // 否则同一 WebContents 上会累积 N 个监听 + N 个挂起定时器（MaxListenersExceededWarning / 闭包泄漏）。
    // 测试假件只实现了 on()，因此 removeListener 用可选调用，不改变适配器契约。
    const removable = wc as unknown as { removeListener?: (event: string, cb: (...args: unknown[]) => void) => void };
    await new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        removable.removeListener?.("dom-ready", done);
        resolve();
      };
      wc.on("dom-ready", done);
      // 兜底：事件可能早于监听注册，用一次轻量 JS 探测确认后就绪
      wc.executeJavaScript("document.readyState", false)
        .then(() => done())
        .catch(() => done());
      timer = setTimeout(done, 15_000);
    });
  }

  // 关键：用户点网页里的链接不会经过外壳的 navigate()，必须靠 WebContents 事件
  // 把地址回传给外壳；否则会出现"地址栏与网页各说各话"（网址与网页割裂）。
  // 主框架导航（含 SPA 路由）后页面可能整个换掉：旧 ref 一律作废，动作会得到 STALE_REF。
  // 与地址栏同步共用一个处理器：Electron 每个事件只注册一次，测试假件按事件名存回调时也不会互相覆盖。
  const handleNavigation = (isMainFrame: boolean, url: string): void => {
    if (isMainFrame) refs.registry.clear();
    opts.onNavigate?.(url);
  };
  // Electron 签名：(event, url, ...)；取 args[1]，否则地址栏会变成 [object Object]
  wc.on("did-navigate", (...args) => handleNavigation(true, String(args[1] ?? "")));
  wc.on("did-navigate-in-page", (...args) => handleNavigation(args[2] !== false, String(args[1] ?? "")));
  // 加载状态（加载页 / 失败页）：用主框架事件，不用 did-start-loading —— 子资源失败不该变成整页错误。
  if (opts.onLoadStart) {
    wc.on("did-start-navigation", (...args) => {
      const details = args[0] as { isMainFrame?: boolean; isSameDocument?: boolean } | undefined;
      if (details?.isMainFrame === false || details?.isSameDocument) return;
      opts.onLoadStart?.();
    });
  }
  if (opts.onLoadEnd) {
    wc.on("did-stop-loading", () => opts.onLoadEnd?.());
  }
  if (opts.onLoadFailure) {
    wc.on("did-fail-load", (...args) => {
      const code = Number(args[1]);
      const description = String(args[2] ?? "");
      const url = String(args[3] ?? "");
      const isMainFrame = args[4] !== false;
      // -3 = ERR_ABORTED（重定向/用户取消/新导航打断旧导航）：不是真实失败，别闪错误页
      if (code === -3 || !isMainFrame) return;
      opts.onLoadFailure?.({ code, description, url, isMainFrame });
    });
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
  if (opts.onDevToolsRequest) {
    wc.on("before-input-event", (...args) => {
      const event = args[0] as { preventDefault?: () => void } | undefined;
      const input = args[1] as { type?: string; key?: string; control?: boolean; meta?: boolean; shift?: boolean } | undefined;
      if (!input || input.type !== "keyDown") return;
      const key = input.key ?? "";
      const inspect = (input.control || input.meta) && input.shift === true && key.toLowerCase() === "i";
      if (key !== "F12" && !inspect) return;
      event?.preventDefault?.();
      opts.onDevToolsRequest?.();
    });
  }

  if (opts.onTitle) {
    // Electron 签名：(event, title, explicitSet) —— 取 args[1]，否则会把 event 渲染成 [object Object]
    wc.on("page-title-updated", (...args) => opts.onTitle?.(String(args[1] ?? "")));
  }

  if (opts.onFavicon) {
    // Electron 签名：(event, favicons: string[]) —— 取第一个图标；data: 透传，http(s) 交给主进程抓取转 base64。
    wc.on("page-favicon-updated", (...args) => {
      const raw = args[1];
      const urls = Array.isArray(raw) ? raw.map((item) => String(item ?? "")).filter(Boolean) : [];
      const first = urls[0];
      if (!first) return;
      if (first.startsWith("data:image/")) {
        opts.onFavicon?.(first);
        return;
      }
      void opts.fetchFavicon?.(first)
        .then((dataUrl) => {
          if (dataUrl) opts.onFavicon?.(dataUrl);
        })
        .catch(() => undefined);
    });
  }

  return {
    async navigate(url: string) {
      await wc.loadURL(url);
      await waitDomReady();
      // 不再「导航后打标」：引用由 snapshot() 每次现算，导航只负责清空旧注册表（见 handleNavigation）
      return { url: wc.getURL() || url };
    },

    async snapshot(): Promise<BrowserSnapshot> {
      const raw = (await wc.executeJavaScript(SNAPSHOT_SCRIPT, false)) as {
        url?: string;
        title?: string;
        text?: string;
        elements?: RawBrowserElement[];
        elementTotal?: number;
      } | null;
      const elements = refs.registry.reset(Array.isArray(raw?.elements) ? raw.elements : []);
      return {
        url: raw?.url ?? wc.getURL(),
        title: raw?.title ?? "",
        text: raw?.text ?? "",
        elements,
        snapshotGen: refs.registry.gen,
        elementTotal: typeof raw?.elementTotal === "number" ? raw.elementTotal : elements.length,
        tabToken: refs.token,
      };
    },

    async screenshot(): Promise<string> {
      const image = await wc.capturePage();
      return image.toPNG().toString("base64");
    },

    async executeJs(code: string) {
      return wc.executeJavaScript(code, true);
    },

    setZoom(factor: number) {
      wc.setZoomFactor?.(factor);
    },

    async close() {
      // 关闭标签必须真正销毁页面：只 detach 视图时 WebContents 仍活着，
      // 正在播放的音视频会继续出声（用户实机反馈）。先静音兜底，再销毁。
      try {
        wc.setAudioMuted?.(true);
      } catch {
        // 忽略：页面已崩溃/已销毁
      }
      try {
        wc.close?.();
      } catch {
        // 忽略：部分平台/版本关闭失败时仍由外壳 detach
      }
      opts.onClose?.();
      dropTabRegistry(refs.token);
    },
  };
}
