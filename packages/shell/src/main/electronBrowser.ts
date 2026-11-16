/**
 * Electron 侧 BrowserHost 装配 + 下载桥。
 * 允许 import electron 的文件之一（另一个是 main/index.ts）：只做「electron API → 依赖注入」的薄适配。
 * 修复 ①：webContents.setWindowOpenHandler 把 target=_blank/window.open 转为应用内新标签，
 *        不再产生 Electron 独立窗口（旧行为看起来像「弹窗」）。
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { lookup } from "node:dns/promises";
import { app, BrowserWindow, session, shell, WebContentsView } from "electron";
import { LAYOUT, type BrowserViewBounds } from "loopsoar-contracts/layout";
import { SESSION_PARTITION } from "../shared/brand.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { BrowserHost, type BrowserVisit, type HostView, type PersistedBrowserState } from "./browserHost.js";
import {
  browserRequestHost,
  createBrowserRequestChecker,
  createBrowserRequestPolicy,
} from "./browserRequestGuard.js";

export interface ElectronBrowserHostOptions {
  initialSessionId?: string;
  onSessionStateChanged?: (sessionId: string, state: PersistedBrowserState) => void;
  /** DNS 解析注入（测试/E2E 可替换；默认用 node:dns）。 */
  resolveIps?: (host: string) => Promise<string[]>;
  /** 浏览器是否允许回环（默认 true：E2E/本地页面需要；LOOPSOAR_STRICT_NET=1 关闭）。 */
  allowLoopback?: boolean;
  /** 广告/追踪拦截开关（读偏好 adBlockEnabled；缺省 true，即未注入也默认开启）。 */
  isAdBlockEnabled?: () => boolean;
  /** 成功访问 → 全局历史（跨标签/跨会话共享；由 index.ts 接到 BrowserHistoryStore）。 */
  onVisited?: (visit: BrowserVisit) => void;
  /** 页面标题迟到 → 刷新全局历史里同 URL 条目的标题（不新增访问）。 */
  onTitleChanged?: (url: string, title: string) => void;
  /** 页面图标迟到 → 刷新全局历史里同 URL 条目的图标（不新增访问）。 */
  onFaviconChanged?: (url: string, favicon: string) => void;
  /** 首次任务化（Agent 拿到自己的克隆页）：壳层把会话标记为「浏览器任务」。 */
  onTaskCreated?: (sessionId: string) => void;
  /** Agent 正在该会话动手（克隆页已可见）：壳层把虚拟光标切成常驻。 */
  onAgentActing?: (sessionId: string) => void;
  /** 切会话时网页收起/展开：UI 据此显示空白页或网页。 */
  /** 网页视图几何（主窗口内容坐标）变化：Agent 覆盖指针据此贴住网页区域（null = 无可见网页）。 */
  onViewLayout?: (rect: BrowserViewBounds | null) => void;
  /** 底部开发者工具面板（由 index 创建；未装配时平台上仍保持旧 detach 行为）。 */
  devToolsPanel?: BrowserDevToolsPanel;
  /**
   * 原生网页视图获得焦点（用户点了网页区域）。网页是 WebContentsView，DOM 收不到这层
   * pointerdown —— 主窗口里的内联浮层（模型菜单/会话列表等）需要靠这个信号收起。
   */
  onViewFocused?: () => void;
}

/** 默认 DNS 解析：只把地址交给守卫，解析失败返回空数组（守卫按 fail-closed 拦截）。 */
async function defaultResolveIps(host: string): Promise<string[]> {
  try {
    const rows = await lookup(host, { all: true });
    return rows.map((row) => row.address);
  } catch {
    return [];
  }
}

/* ───────────────────────── window.open 逃逸防护（可单测） ───────────────────────── */

/**
 * 新标签 URL 白名单：window.open / target=_blank 只允许 http(s)。
 * 为什么必须白名单：网页里的 `window.open("file:///…")`、`javascript:`、`loopsoar://…`
 * 一旦被 Electron 默认处理，就能打开本地文件或应用内页面（浏览器桥逃逸攻击路径之一）。
 */
export function isNewTabUrlAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    // 相对地址 / 空串 / 非法串：没有可信协议，一律不放行
    return false;
  }
}

/**
 * 可测的 window.open 处理器工厂（抽出纯逻辑，不依赖 electron 实例）：
 *   - 无论 URL 是什么都返回 { action: "deny" }，绝不产生 Electron 独立窗口；
 *   - 仅 http(s) 转成应用内新标签（openInNewTab），其余协议静默忽略。
 */
export function createWindowOpenHandler(
  openInNewTab: (url: string) => void,
): (details: { url: string }) => { action: "deny" } {
  return ({ url }) => {
    if (isNewTabUrlAllowed(url)) openInNewTab(url);
    return { action: "deny" };
  };
}

/**
 * 模块级防重复注册：`onBeforeRequest` 是「追加监听」语义，重复注册会让同一个请求被判定多次，
 * 且没有任何 API 能单独移除——所以必须在进程内只装一次。
 */
let browserRequestGuardInstalled = false;

/**
 * 给浏览器 session 装一次出网守卫（两阶段：同步 URL 策略 → 异步 DNS 校验）。
 * 失败路径一律 cancel（fail-closed）；日志只打 host，避免把完整 URL 的敏感查询参数写进日志。
 */
function installBrowserRequestGuard(partitionSession: Electron.Session, options: ElectronBrowserHostOptions): void {
  if (browserRequestGuardInstalled) return;
  browserRequestGuardInstalled = true;

  const policy = createBrowserRequestPolicy({
    allowLoopback: options.allowLoopback,
    // 每次请求读最新偏好（设置里关掉广告拦截即时生效）
    adBlock: () => options.isAdBlockEnabled?.() ?? true,
  });
  const check = createBrowserRequestChecker({
    resolveIps: options.resolveIps ?? defaultResolveIps,
    policy,
  });

  partitionSession.webRequest.onBeforeRequest((details, callback) => {
    // Electron 要求每个请求恰好回调一次：用 finished 守卫防止「resolve 后 catch 又调一次」。
    let finished = false;
    const done = (response: { cancel?: boolean }): void => {
      if (finished) return;
      finished = true;
      try {
        callback(response);
      } catch {
        // 请求可能已随标签销毁而结束，忽略
      }
    };
    void check(details.url)
      .then((decision) => {
        if (decision.action === "allow") {
          done({});
          return;
        }
        // 日志只打 host（不带完整 URL 的查询参数）；广告拦截单独标注，便于排查误杀
        const tag = decision.kind === "adblock" ? " [adblock]" : "";
        console.warn(`[browser-guard]${tag} 拦截请求 host=${browserRequestHost(details.url)} reason=${decision.reason ?? "未说明"}`);
        done({ cancel: true });
      })
      .catch(() => done({ cancel: true }));
  });
}

/** favicon 抓取缓存：同站点图标 6 小时内只抓一次；失败也缓存空结果，避免反复请求。 */
const FAVICON_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FAVICON_MAX_BYTES = 96 * 1024;
const faviconCache = new Map<string, { at: number; dataUrl: string | null }>();
/** 缓存条数上限：旧实现只写不删，长时间浏览后主进程内存单调增长（每条最多 96KB）。 */
const FAVICON_CACHE_MAX = 200;

/** 超出上限时按插入顺序淘汰最旧条目（Map 保序，等价于近似 LRU）。 */
function trimFaviconCache(): void {
  if (faviconCache.size <= FAVICON_CACHE_MAX) return;
  for (const key of faviconCache.keys()) {
    faviconCache.delete(key);
    if (faviconCache.size <= FAVICON_CACHE_MAX) return;
  }
}

/**
 * 把 page-favicon-updated 给的图标 URL 抓成 data URL。
 * 为什么必须转换：渲染层 CSP 是 `img-src self data:`，直接 <img src="https://…"> 会被拦；
 * 同时统一成 data URL 后历史文件离线也可显示。只接受 http(s) 与图片 MIME、限制 96KB。
 */
async function fetchFaviconDataUrl(url: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const cached = faviconCache.get(url);
  if (cached && Date.now() - cached.at < FAVICON_CACHE_TTL_MS) return cached.dataUrl;
  try {
    const response = await session.fromPartition(SESSION_PARTITION).fetch(url, {
      headers: { Accept: "image/avif,image/webp,image/png,image/svg+xml,image/*,*/*;q=0.8" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const mime = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!mime.startsWith("image/")) throw new Error(`非图片类型：${mime || "unknown"}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength === 0 || buffer.byteLength > FAVICON_MAX_BYTES) throw new Error("图标体积超限");
    const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
    faviconCache.set(url, { at: Date.now(), dataUrl });
    trimFaviconCache();
    return dataUrl;
  } catch (err) {
    faviconCache.set(url, { at: Date.now(), dataUrl: null });
    trimFaviconCache();
    return null;
  }
}

/**
 * 底部开发者工具面板：把 Chromium DevTools 前端渲染到主窗口内的 WebContentsView，
 * 停靠在「终端面板」所在的底部区域（而非独立窗口）。Electron 的 setDevToolsWebContents
 * 允许把 devtools 前端画到任意 WebContents，这里用 WebContentsView 作为画布。
 *
 * 生命周期：open( inspected ) → 建 view + setDevToolsWebContents + inspected.openDevTools；
 * inspected 侧关闭 devtools（快捷键/菜单）会触发 devtools-closed → 自动清理并回调壳层。
 */
export class BrowserDevToolsPanel {
  private view: WebContentsView | null = null;
  private inspected: Electron.WebContents | null = null;
  private win: BrowserWindow | null = null;
  private panelHeight = 320;
  private visible = true;
  private readonly onResize = (): void => this.syncBounds();

  constructor(
    private readonly options: {
      getWindow: () => BrowserWindow | null;
      onOpenChange?: (open: boolean) => void;
    },
  ) {}

  isOpen(): boolean {
    return this.view !== null;
  }

  /** 打开/切换被调试的 WebContents；失败返回 false（不抛）。 */
  open(inspected: Electron.WebContents): boolean {
    if (!inspected || inspected.isDestroyed()) return false;
    if (this.view && this.inspected?.id === inspected.id) {
      this.syncBounds();
      return true;
    }
    this.close();
    const win = this.options.getWindow();
    if (!win || win.isDestroyed()) return false;
    try {
      const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } });
      win.contentView.addChildView(view);
      this.view = view;
      this.inspected = inspected;
      this.win = win;
      inspected.setDevToolsWebContents(view.webContents);
      inspected.once("devtools-closed", this.onInspectedClosed);
      win.on("resize", this.onResize);
      inspected.openDevTools({ mode: "detach" });
      this.syncBounds();
      this.options.onOpenChange?.(true);
      return true;
    } catch (err) {
      console.warn("[devtools] 打开底部调试面板失败", err instanceof Error ? err.message : String(err));
      this.destroyView();
      return false;
    }
  }

  private onInspectedClosed = (): void => {
    this.destroyView();
    this.options.onOpenChange?.(false);
  };

  private destroyView(): void {
    const view = this.view;
    this.view = null;
    const win = this.win;
    this.win = null;
    try {
      win?.removeListener("resize", this.onResize);
    } catch {
      // window 已销毁
    }
    if (win && !win.isDestroyed() && view) {
      try {
        win.contentView.removeChildView(view);
      } catch {
        // 已移除
      }
    }
    try {
      view?.webContents.close();
    } catch {
      // 已销毁
    }
  }

  close(): void {
    const inspected = this.inspected;
    this.inspected = null;
    if (inspected && !inspected.isDestroyed()) {
      try {
        inspected.closeDevTools();
      } catch {
        // ignore
      }
    }
    // devtools-closed 可能同步触发 destroyView；这里兜底清一次（幂等）
    this.destroyView();
  }

  /** 面板高度（由渲染层传入，与底部终端同一坐标空间）；同步一次几何。 */
  setPanel(height: number): void {
    const next = Number.isFinite(height) ? Math.round(height) : this.panelHeight;
    this.panelHeight = Math.max(120, Math.min(1200, next));
    this.syncBounds();
  }

  /** 设置面板高度并保持打开（渲染层恢复布局时调用）。 */
  setVisible(visible: boolean): void {
    this.visible = visible;
    try {
      this.view?.setVisible(visible);
    } catch {
      // ignore
    }
  }

  syncBounds(): void {
    const view = this.view;
    const win = this.win;
    if (!view || !win || win.isDestroyed()) return;
    const [width, height] = win.getContentSize();
    // 状态栏在 DOM 里被推到面板上方（成为展开面板的顶栏），所以面板从窗口底部往上占满：
    // y = height - panelHeight（不再让出 STATUS_BAR_HEIGHT）。
    const panelHeight = Math.max(120, Math.min(this.panelHeight, height - 120));
    const y = Math.max(0, height - panelHeight);
    try {
      view.setBounds({ x: 0, y, width, height: panelHeight });
      if (this.visible) view.setVisible(true);
    } catch {
      // 视图已销毁
    }
  }

  dispose(): void {
    this.close();
  }
}

/** 浏览器标签页 preload（商店安装按钮 → Loopsoar 扩展安装通道）。src 与 bundle 两种运行目录都兼容。 */
function browserPreloadPath(): string | undefined {
  const candidates = [path.join(__dirname, "../src/preload/browser.cjs"), path.join(__dirname, "../../src/preload/browser.cjs")];
  return candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
}

/** 历史/快捷入口补图标：抓页面 HTML 里的 <link rel=icon>，否则退回 /favicon.ico、/favicon.png。 */
export async function resolveFaviconForPage(pageUrl: string): Promise<string | null> {
  let origin: string;
  try {
    const parsed = new URL(pageUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    origin = parsed.origin;
  } catch {
    return null;
  }
  const candidates: string[] = [];
  try {
    const response = await session.fromPartition(SESSION_PARTITION).fetch(pageUrl, {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    if (response.ok) {
      const html = (await response.text()).slice(0, 256 * 1024);
      const page = /<link[^>]+rel=["']?(?:shortcut icon|icon|apple-touch-icon)[^>]*>/i.exec(html);
      const href = page ? /href=["']([^"']+)["']/i.exec(page[0])?.[1] : undefined;
      if (href) candidates.push(new URL(href, pageUrl).href);
    }
  } catch {
    // 页面抓不到就退回标准路径
  }
  candidates.push(`${origin}/favicon.ico`, `${origin}/favicon.png`);
  for (const candidate of candidates) {
    const dataUrl = await fetchFaviconDataUrl(candidate);
    if (dataUrl) return dataUrl;
  }
  return null;
}

export function createElectronBrowserHost(
  getWindow: () => BrowserWindow | null,
  openInNewTab: (url: string) => void,
  options: ElectronBrowserHostOptions = {},
): BrowserHost {  // 守卫必须在任何 WebContentsView 创建之前装好（否则首批请求会漏检）；
  // 只在浏览器分区上挂，不影响主窗口（loopsoar://）与下载。
  installBrowserRequestGuard(session.fromPartition(SESSION_PARTITION), options);

  // 原生 WebContentsView 在 Windows 上不会真正裁掉网页内容（setBorderRadius 只影响视图边框），
  // 四角始终是方的。用一个常驻的透明子窗口把四角盖成外壳色，形状用 radial-gradient 的
  // 反圆角 mask 抠出四分之一圆；它只覆盖 14px 的角，平时不挡鼠标/输入。
  let cornerWindow: BrowserWindow | null = null;
  let cornerColor = "#171B22";
  const applyCornerColor = (color: string): void => {
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) return;
    cornerColor = color;
    if (cornerWindow && !cornerWindow.isDestroyed()) {
      void cornerWindow.webContents
        .executeJavaScript(`document.documentElement.style.setProperty('--corner', '${color}')`)
        .catch(() => undefined);
    }
  };
  const cornerCss = "html,body{margin:0;padding:0;width:100%;height:100%;background:transparent;overflow:hidden}"
    + `:root{--corner:${cornerColor}}`
    + ".c{position:absolute;width:14px;height:14px;background:var(--corner);pointer-events:none}"
    + ".tl{left:0;top:0;-webkit-mask:radial-gradient(circle 14px at 14px 14px,transparent 13.4px,#000 14px);mask:radial-gradient(circle 14px at 14px 14px,transparent 13.4px,#000 14px)}"
    + ".tr{right:0;top:0;-webkit-mask:radial-gradient(circle 14px at 0 14px,transparent 13.4px,#000 14px);mask:radial-gradient(circle 14px at 0 14px,transparent 13.4px,#000 14px)}"
    + ".bl{left:0;bottom:0;-webkit-mask:radial-gradient(circle 14px at 14px 0,transparent 13.4px,#000 14px);mask:radial-gradient(circle 14px at 14px 0,transparent 13.4px,#000 14px)}"
    + ".br{right:0;bottom:0;-webkit-mask:radial-gradient(circle 14px at 0 0,transparent 13.4px,#000 14px);mask:radial-gradient(circle 14px at 0 0,transparent 13.4px,#000 14px)}";
  const cornerHtml = "<!doctype html><html><head><meta charset='utf-8'><style>" + cornerCss + "</style></head><body>"
    + "<div class='c tl'></div><div class='c tr'></div><div class='c bl'></div><div class='c br'></div></body></html>";

  const ensureCornerWindow = (): BrowserWindow | null => {
    const parent = getWindow();
    if (!parent || parent.isDestroyed()) return null;
    if (cornerWindow && !cornerWindow.isDestroyed()) return cornerWindow;
    cornerWindow = new BrowserWindow({
      parent,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    cornerWindow.setIgnoreMouseEvents(true);
    void cornerWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(cornerHtml) + "#loopsoar-corner");
    // 子窗口不会自动随父窗口销毁；不手动收掉会让 app.quit 一直等它（E2E/退出卡住）。
    parent.once("closed", () => {
      if (cornerWindow && !cornerWindow.isDestroyed()) cornerWindow.destroy();
      cornerWindow = null;
    });
    return cornerWindow;
  };

  const syncCornerWindow = (rect: BrowserViewBounds | null): void => {
    const win = ensureCornerWindow();
    if (!win) return;
    const parent = getWindow();
    if (!rect || !parent || parent.isDestroyed() || parent.isMinimized()) {
      win.hide();
      return;
    }
    const content = parent.getContentBounds();
    win.setBounds({
      x: content.x + rect.x,
      y: content.y + rect.y,
      width: Math.max(1, rect.width),
      height: Math.max(1, rect.height),
    });
    if (!win.isVisible()) {
      win.showInactive();
    }
  };

  // 先建遮罩窗口（隐藏），保证它排在后续的 Agent 指针/呼吸灯覆盖层之下。
  ensureCornerWindow();
  let hostRef: BrowserHost | null = null;
  const host = new BrowserHost({
    initialSessionId: options.initialSessionId,
    onSessionStateChanged: options.onSessionStateChanged,
    onVisited: options.onVisited,
    onTitleChanged: options.onTitleChanged,
    fetchFavicon: fetchFaviconDataUrl,
    onFaviconChanged: options.onFaviconChanged,
    onTaskCreated: options.onTaskCreated,
    onAgentActing: options.onAgentActing,
    onCornerColor: applyCornerColor,
    onViewLayout: (rect) => {
      options.onViewLayout?.(rect);
      syncCornerWindow(rect);
    },
    openDevToolsPanel: options.devToolsPanel ? (webContents) => options.devToolsPanel!.open(webContents as Electron.WebContents) : undefined,
    closeDevToolsPanel: options.devToolsPanel ? () => options.devToolsPanel!.close() : undefined,
    isDevToolsPanelOpen: options.devToolsPanel ? () => options.devToolsPanel!.isOpen() : undefined,
    createView: () => {
      const browserPreload = browserPreloadPath();
      const view = new WebContentsView({
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          partition: SESSION_PARTITION,
          // Agent 输入注入必须落在「看起来在后台」的页面上：窗口被遮挡时 Chromium 会把页面
          // 标成 hidden 并丢弃输入事件。关掉 backgroundThrottling 同时关闭基于遮挡的页面隐藏，
          // 这样用户切到别的窗口时 Agent 的点击/按键仍然有效（关闭它只影响本应用内的网页视图）。
          backgroundThrottling: false,
          ...(browserPreload ? { preload: browserPreload } : {}),
        },
      });
      // 网页面板圆角：与 DOM 页框（StartPage.browserPane）共用同一契约值，
      // 原生视图切掉的四角露出应用底色，不再出现「网页直角顶到边缘」的硬缝。
      view.setBorderRadius(LAYOUT.BROWSER_VIEW_RADIUS);
      // 圆角切掉的四个角是「视图背景」而不是窗口背景：默认黑色会在呼吸灯外侧留下黑色方角。
      // 颜色跟随主题（UI 通过 browser:setCornerColor 下发），避免 soft 主题色差。
      view.setBackgroundColor(cornerColor);
      view.webContents.setWindowOpenHandler(createWindowOpenHandler(openInNewTab));
      // 点网页区域 = 点到「列表外」：通知主窗口收起按钮展开的浮层（DOM 收不到原生视图的点击）
      if (options.onViewFocused) {
        view.webContents.on("focus", () => options.onViewFocused?.());
      }
      return view as unknown as HostView;
    },
    attachView: (view) => {
      const win = getWindow();
      // 启动恢复发生在新窗口创建之前：此时没有窗口可挂，必须返回 false 让宿主在下一次
      // applyLayout 重试；否则恢复出来的标签页永远不会出现在窗口里（重载/刷新也救不回来）。
      if (!win || win.isDestroyed()) return false;
      try {
        win.contentView.addChildView(view as unknown as WebContentsView);
        return true;
      } catch (err) {
        console.warn("[browser] 挂载网页视图失败", err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    detachView: (view) => {
      const win = getWindow();
      if (!win) return;
      try {
        win.contentView.removeChildView(view as unknown as WebContentsView);
      } catch {
        // 窗口已销毁时忽略
      }
    },
    getWindowSize: () => {
      const win = getWindow();
      if (!win) return { width: 1360, height: 860 };
      const [width, height] = win.getContentSize();
      return { width, height };
    },
    onTabsChanged: (tabs) => {
      const win = getWindow();
      // 带上可见组：启动恢复/切任务时 UI 需要它去重「任务工作区」和「Agent 工作区」两个 chip。
      win?.webContents.send("loopsoar:browser:tabs", { tabs, visibleSession: hostRef?.visibleSessionId() });
    },
    openInNewTab,
  });
  hostRef = host;
  return host;
}

/* ────────────────────────────── 下载桥 ────────────────────────────── */

export type DownloadState = "progressing" | "completed" | "cancelled" | "interrupted";

export interface DownloadView {
  id: string;
  filename: string;
  savePath: string;
  state: DownloadState;
  received: number;
  total: number;
  startedAt: number;
}

interface DownloadHandle {
  view: DownloadView;
  cancel: () => void;
  open: () => Promise<string>;
  showInFolder: () => void;
  done: boolean;
}

/** 下载管理：会话级 will-download → 内存条目 + 变更推送；文件落盘目录由偏好注入。 */
export class DownloadsBridge {
  private handles = new Map<string, DownloadHandle>();
  private seq = 0;

  constructor(
    private getDownloadDir: () => string,
    private onChange: () => void,
  ) {
    session.fromPartition(SESSION_PARTITION).on("will-download", (_event, item) => {
      this.register(item);
    });
  }

  private dir(): string {
    const custom = this.getDownloadDir().trim();
    if (custom) return custom;
    try {
      return app.getPath("downloads");
    } catch {
      return app.getPath("temp");
    }
  }

  private register(item: Electron.DownloadItem): void {
    this.seq += 1;
    const id = `dl-${this.seq}`;
    const filename = item.getFilename() || `download-${this.seq}`;
    const savePath = path.join(this.dir(), filename.replace(/[\\/:*?"<>|]/g, "_"));
    try {
      item.setSavePath(savePath);
    } catch {
      // 目录不可用时交给 electron 默认路径
    }
    const view: DownloadView = {
      id,
      filename,
      savePath,
      state: "progressing",
      received: 0,
      total: Math.max(0, item.getTotalBytes()),
      startedAt: Date.now(),
    };
    const handle: DownloadHandle = {
      view,
      cancel: () => {
        try {
          item.cancel();
        } catch {
          // 已结束
        }
      },
      open: () => shell.openPath(view.savePath),
      showInFolder: () => shell.showItemInFolder(view.savePath),
      done: false,
    };
    this.handles.set(id, handle);

    item.on("updated", (_e, state) => {
      view.received = item.getReceivedBytes();
      view.total = Math.max(view.total, item.getTotalBytes());
      if (state === "interrupted") view.state = "interrupted";
      this.onChange();
    });
    item.once("done", (_e, state) => {
      handle.done = true;
      view.state = state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "interrupted";
      view.received = item.getReceivedBytes();
      view.total = Math.max(view.total, item.getTotalBytes());
      this.onChange();
    });
    this.onChange();
  }

  list(): DownloadView[] {
    return [...this.handles.values()].map((h) => ({ ...h.view })).sort((a, b) => b.startedAt - a.startedAt);
  }

  action(id: string, action: "cancel" | "open" | "showInFolder" | "remove"): boolean {
    const handle = this.handles.get(id);
    if (!handle) return false;
    switch (action) {
      case "cancel":
        handle.cancel();
        return true;
      case "open":
        if (handle.view.state !== "completed") return false;
        void handle.open();
        return true;
      case "showInFolder":
        if (!handle.view.savePath) return false;
        handle.showInFolder();
        return true;
      case "remove":
        this.handles.delete(id);
        this.onChange();
        return true;
    }
  }
}
