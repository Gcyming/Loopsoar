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
  shouldBlockAgentLoopback,
} from "./browserRequestGuard.js";
import { attachPageContextMenu } from "./browserPageContextMenu.js";
import { officeFileFromUrl } from "./officePreview.js";
import { browserUserAgent } from "./browserUserAgent.js";
import { downloadCompatibleReferer, isDownloadHost } from "./browserNavigationSupport.js";

export interface ElectronBrowserHostOptions {
  initialSessionId?: string;
  onSessionStateChanged?: (sessionId: string, state: PersistedBrowserState) => void;
  /** 「最近关闭」变化：index 侧防抖落盘（退出后仍保留最近 40 条）。 */
  onClosedTabsChanged?: (entries: { url: string; title: string; sessionId: string; closedAt: number; agentBound?: boolean; pinned?: boolean }[]) => void;
  /** DNS 解析注入（测试/E2E 可替换；默认用 node:dns）。 */
  resolveIps?: (host: string) => Promise<string[]>;
  /** 浏览器是否允许回环（默认 true：E2E/本地页面需要；LOOPSOAR_STRICT_NET=1 关闭）。 */
  allowLoopback?: boolean;
  /** 广告/追踪拦截开关（读偏好 adBlockEnabled；缺省 true，即未注入也默认开启）。 */
  isAdBlockEnabled?: () => boolean;
  /** 请求守卫发现网页里的 file:// 导航：返回 true 表示已接管并取消原导航。 */
  onLocalFileRequest?: (webContentsId: number, url: string) => boolean;
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
  /** 网页视图里拖入 Office 文档：壳层在 file:// 导航前接管。 */
  onLocalFileDrop?: (file: string, sessionId: string) => void;
  /** 本地文档预览页登记：请求守卫只放行这些 webContents 的 file:// PDF。 */
  onLocalPreview?: (webContentsId: number, url: string, active: boolean) => void;
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
  /** 网页焦点下的浏览器快捷键（Ctrl+T/W/R/M、Ctrl+Shift+T/K）：转给渲染层执行同一套标签动作。 */
  onBrowserShortcut?: (action: string) => void;
}

/**
 * 防盗链下载站的 Referer 兼容（一次性注册到浏览器分区）。
 *
 * 实测 CLDisk：GET 下载链接不带 Referer → WAF 403；带 `Referer: https://d0.cldisk.com/`
 * → 200 + Content-Disposition。Agent 程序化导航（loadURL）默认不带 Referer，用户粘贴/
 * 新标签打开也可能没有，于是「下载任务全 403」。这里只对已知下载域的主框架请求
 * 把 Referer 归一成目标站 origin（不碰其它站点、不碰子资源）。
 */
const downloadRefererSessions = new WeakSet<object>();
function installDownloadRefererGuard(browserSession: Electron.Session): void {
  if (downloadRefererSessions.has(browserSession)) return;
  downloadRefererSessions.add(browserSession);
  browserSession.webRequest.onBeforeSendHeaders((details, callback) => {
    if (details.resourceType === "mainFrame" && isDownloadHost(details.url)) {
      const referer = downloadCompatibleReferer(details.url);
      if (referer) {
        callback({ requestHeaders: { ...details.requestHeaders, Referer: referer } });
        return;
      }
    }
    callback({ requestHeaders: details.requestHeaders });
  });
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
 * 标签页内**允许**主导航的协议：只有网页地址与空白页。
 *
 * 为什么必须显式拦截：页面上一个 `<a href="bitbrowser://…">` 或脚本改 location 到自定义协议时，
 * Chromium 会把请求交给操作系统；Windows 找不到注册程序就弹出「获取打开此'bitbrowser'链接的应用」
 * 系统对话框（用户 m04220 截图）。这类跳转既不是用户要的页面，也把浏览器变成了协议启动器，
 * 有被网页静默唤起本机应用的风险 —— 一律阻止，且不弹任何应用内提示（与 window.open 的处理一致）。
 */
export function isInTabNavigationAllowed(url: string): boolean {
  if (!url) return true;
  if (url === "about:blank") return true;
  try {
    const parsed = new URL(url);
    // blob: 是页面自建内容（PDF 预览/媒体），没有 OS 交互；其余非网页协议一律挡掉。
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "blob:";
  } catch {
    // 非法串交给 Chromium 自己报错，不在这里吞掉。
    return true;
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
/** 已登记的应用内文档预览页（webContentsId）与 URL：只放行这些 file:// 请求。 */
const localPreviewWebContents = new Set<number>();
const localPreviewUrls = new Set<string>();

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
    // 兜底（用户 m04220）：自定义协议（bitbrowser:// 等）一旦交给系统，Windows 会弹
    // 「没有可打开此链接的应用」。will-navigate 之外再在请求层挡一次，双保险。
    if (!isInTabNavigationAllowed(details.url) && details.resourceType === "mainFrame") {
      done({ cancel: true });
      return;
    }
    // 应用内文档预览：只放行我们自己登记过的 webContents 加载其 PDF/加载页。
    // data: 仅用于同一预览标签的转换占位页；其它网页仍不能借 data: 绕过策略。
    if (String(details.url).startsWith("file://") || String(details.url).startsWith("data:")) {
      const preview =
        localPreviewUrls.has(details.url) &&
        localPreviewWebContents.has(Number((details as { webContentsId?: number }).webContentsId ?? -1));
      if (preview) {
        done({});
        return;
      }
      // Chromium 对网页里拖入的 file:// 可能直接拦在渲染层，完全不给 will-navigate；
      // 在请求守卫这一层再兜底一次，接管成功后取消原始本地导航。
      const webContentsId = Number((details as { webContentsId?: number }).webContentsId ?? -1);
      const handled = options.onLocalFileRequest?.(webContentsId, details.url) === true;
      if (handled) {
        done({ cancel: true });
        return;
      }
    }
    void check(details.url)
      .then((decision) => {
        // Agent 标签不得用浏览器绕过 SSRF 策略访问本机/回环服务（web_fetch 侧写死 allowLoopback:false）。
        // 显式 LOOPSOAR_ALLOW_LOOPBACK=1（E2E/本地开发）才放开；用户自己开的标签照常可以浏览 localhost。
        if (
          decision.action === "allow" &&
          shouldBlockAgentLoopback({
            webContentsId: (details as { webContentsId?: number }).webContentsId,
            url: details.url,
          })
        ) {
          console.warn(`[browser-guard] Agent 标签拒绝回环地址 host=${browserRequestHost(details.url)}`);
          done({ cancel: true });
          return;
        }
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
      // 右键「检查元素」在旧路径里会直接走 webContents.inspectElement，把 Chromium
      // 默认 DevTools 停靠到侧边；那套 DevTools 会盖住底部状态栏，并使「调试」按钮
      // 无法再接管（底部面板认为 devtools 未开，侧边面板却已经存在）。统一先关掉
      // 任何已打开的 DevTools，再把它挂到应用自己的底部面板上。
      if (inspected.isDevToolsOpened()) {
        try {
          inspected.closeDevTools();
        } catch {
          // 已关闭 / 正在关闭
        }
      }
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

  /**
   * 右键「检查元素」：先让应用底部面板接管 DevTools，再定位到点击坐标对应的节点。
   * 必须等前端 WebContents 完成 setDevToolsWebContents/openDevTools 后再调用
   * inspectElement；否则 Electron 会另开默认侧栏 DevTools。
   */
  inspect(inspected: Electron.WebContents, x: number, y: number): boolean {
    if (!this.open(inspected)) return false;
    setTimeout(() => {
      if (inspected.isDestroyed()) return;
      try {
        inspected.inspectElement(Math.max(0, Math.round(x)), Math.max(0, Math.round(y)));
      } catch {
        // DevTools 可能刚被用户关闭
      }
    }, 120);
    return true;
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
      // 浏览器标签视图在布局/切页时会重新 addChildView 抢到最上层，
      // 这里每次同步几何都把自己的视图提到最上，避免调试面板被网页盖住。
      win.contentView.addChildView(view);
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
  const partitionSession = session.fromPartition(SESSION_PARTITION);
  // WAF/下载站兼容：网页分区用标准 Chrome UA（去掉 Electron/Loopsoar 标记），
  // 否则 CLisk 这类防盗链会对「非浏览器客户端」直接 403。
  partitionSession.setUserAgent(browserUserAgent(), "zh-CN,zh;q=0.9,en;q=0.8");
  installDownloadRefererGuard(partitionSession);
  installBrowserRequestGuard(partitionSession, options);

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
  // 遮罩几何跟随 BROWSER_VIEW_RADIUS：常量写死会和实际圆角对不上，出现「缺一角/多一块」。
  const cornerRadius = Math.max(4, Math.round(LAYOUT.BROWSER_VIEW_RADIUS));
  const cornerSize = cornerRadius;
  const maskCss = (x: string, y: string): string => {
    const gradient = `radial-gradient(circle ${cornerRadius}px at ${x} ${y},transparent ${cornerRadius - 0.6}px,#000 ${cornerRadius}px)`;
    return `-webkit-mask:${gradient};mask:${gradient}`;
  };
  const cornerCss = "html,body{margin:0;padding:0;width:100%;height:100%;background:transparent;overflow:hidden}"
    + `:root{--corner:${cornerColor}}`
    + `.c{position:absolute;width:${cornerSize}px;height:${cornerSize}px;background:var(--corner);pointer-events:none}`
    + `.tl{left:0;top:0;${maskCss(`${cornerRadius}px`, `${cornerRadius}px`)}}`
    + `.tr{right:0;top:0;${maskCss("0", `${cornerRadius}px`)}}`
    + `.bl{left:0;bottom:0;${maskCss(`${cornerRadius}px`, "0")}}`
    + `.br{right:0;bottom:0;${maskCss("0", "0")}}`;
  const cornerHtml = "<!doctype html><html><head><meta charset='utf-8'><style>" + cornerCss + "</style></head><body>"
    + "<div class='c tl'></div><div class='c tr'></div><div class='c bl'></div><div class='c br'></div></body></html>";

  const ensureCornerWindow = (): BrowserWindow | null => {
    // 半径为 0 时才关闭遮罩；恢复圆角后由四角遮罩 + setBorderRadius 共同呈现。
    // 颜色由渲染层的 --ls-surface-raised 同步，避免出现用户看到的“黑圈”。
    if (LAYOUT.BROWSER_VIEW_RADIUS <= 0) return null;
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
    if (LAYOUT.BROWSER_VIEW_RADIUS <= 0) {
      // 半径归零后旧遮罩必须收掉（升级/热重载时可能还残留一个可见窗口）。
      if (cornerWindow && !cornerWindow.isDestroyed()) cornerWindow.hide();
      return;
    }
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
    onClosedTabsChanged: options.onClosedTabsChanged,
    onVisited: options.onVisited,
    onTitleChanged: options.onTitleChanged,
    fetchFavicon: fetchFaviconDataUrl,
    onFaviconChanged: options.onFaviconChanged,
    onTaskCreated: options.onTaskCreated,
    onAgentActing: options.onAgentActing,
    onLocalFileDrop: options.onLocalFileDrop,
    onLocalFileRequest: (webContentsId, url) => hostRef?.handleLocalFileRequest(webContentsId, url) ?? false,
    onLocalPreview: (webContentsId, url, active) => {
      if (active) {
        localPreviewWebContents.add(webContentsId);
        localPreviewUrls.add(url);
      } else {
        localPreviewWebContents.delete(webContentsId);
        localPreviewUrls.delete(url);
      }
      options.onLocalPreview?.(webContentsId, url, active);
    },
    onCornerColor: applyCornerColor,
    onViewLayout: (rect) => {
      options.onViewLayout?.(rect);
      syncCornerWindow(rect);
    },
    openDevToolsPanel: options.devToolsPanel ? (webContents) => options.devToolsPanel!.open(webContents as Electron.WebContents) : undefined,
    ...(options.onBrowserShortcut ? { onShortcut: options.onBrowserShortcut } : {}),
    closeDevToolsPanel: options.devToolsPanel ? () => options.devToolsPanel!.close() : undefined,
    isDevToolsPanelOpen: options.devToolsPanel ? () => options.devToolsPanel!.isOpen() : undefined,
    createView: (sessionId?: string) => {
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
      // 页面已方形铺满：视图背景只在「页面尚未绘制/页面自身透明」的一瞬间可见。
      // 用浏览器默认白色，避免旧实现的应用底色在加载瞬间透出成黑块。
      view.setBackgroundColor("#ffffff");
      view.webContents.setWindowOpenHandler(
        createWindowOpenHandler((url) => {
          // 归属必须跟着「发起窗口所在的标签组」，不能一律落到用户全局标签：
          // 后台 Agent 会话里点开的新页若进了用户组，会被当成用户页面且在错误的会话里可见。
          if (sessionId && hostRef) {
            // 新页的任务归属跟「发起页」一致：Agent 克隆页开的页仍折叠进 Agent 工作区；
            // 用户标签/普通页面开的页保持用户语义，不因为落在某个会话组就被标成任务页。
            const fromAgent =
              typeof view.webContents.id === "number" && hostRef.isAgentWebContents(view.webContents.id);
            // window.open/target=_blank 的新页也带上发起页 Referer（防盗链下载站在新标签里
            // 直接打开时同样会 403）。取不到就交给宿主按当前页推断。
            const referer = view.webContents.getURL();
            void hostRef.newTab(url, sessionId, fromAgent ? "agent" : "user", {
              forceNew: true,
              ...(referer ? { referer } : {}),
            });
            return;
          }
          openInNewTab(url);
        }),
      );
      // 自定义协议（bitbrowser://、mailto: 之类）不进系统打开：否则 Windows 会弹「没有可打开此链接的应用」。
      // 只挡页面发起的主导航；应用自己的 loadURL（file:// 预览、about:blank 新标签）不经过 will-navigate。
      const blockForeignProtocol = (event: { preventDefault: () => void }, url: string): void => {
        if (isInTabNavigationAllowed(url)) return;
        event.preventDefault();
      };
      view.webContents.on("will-navigate", blockForeignProtocol);
      view.webContents.on("will-frame-navigate", (event) => blockForeignProtocol(event, event.url));
      // 网页原生右键菜单：DOM 浮层覆盖不到 WebContentsView，必须由主进程 Menu 接管。
      attachPageContextMenu({
        webContents: view.webContents,
        getWindow,
        onNewTab: (url) => {
          if (!hostRef) return;
          // 右键「在右侧新建标签页」要沿用发起页的归属：Agent 页开出的仍是 Agent 页，
          // 否则任务工作区里右键会漏出一个用户标签。
          const fromAgent = hostRef.isAgentWebContents(view.webContents.id);
          const referer = view.webContents.getURL();
          void hostRef.newTab(url, sessionId, fromAgent ? "agent" : "user", {
            forceNew: true,
            ...(referer ? { referer } : {}),
          });
        },
        onAskAgent: (text) => {
          const win = getWindow();
          if (!win || win.isDestroyed()) return;
          win.show();
          win.focus();
          win.webContents.send("loopsoar:ui:compose", { text });
        },
        // 页面内「检查元素」必须走应用底部面板：直接 wc.inspectElement 会让 Chromium
        // 默认 DevTools 停靠在网页侧边，盖住状态栏并让底部「调试」按钮失效。
        onInspectElement: (x, y) => {
          if (options.devToolsPanel) {
            options.devToolsPanel.inspect(view.webContents, x, y);
          } else {
            view.webContents.inspectElement(x, y);
          }
        },
      });
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

/** 异常原因：用户取消 / 网络中断 / 无权限 / 应用关闭 / 上次退出未完成。 */
export type DownloadReason = "cancelled" | "interrupted" | "permission" | "app-closed" | "stale";

export interface DownloadView {
  id: string;
  filename: string;
  savePath: string;
  /** 原始下载地址（右键「复制下载链接」用；敏感查询串只留在主进程/本地 UI）。 */
  url: string;
  state: DownloadState;
  /** 异常原因（UI 文案用；completed 时为空）。 */
  reason?: DownloadReason;
  /** 文件已不在下载目录（仅 completed 时检测；列表渲染横杠）。 */
  missing?: boolean;
  /** 排队中（已暂停，等前面的下载完成，或用户点「开始」插队）。 */
  queued?: boolean;
  received: number;
  total: number;
  startedAt: number;
}

interface DownloadHandle {
  view: DownloadView;
  item: Electron.DownloadItem;
  cancel: () => void;
  open: () => Promise<string>;
  showInFolder: () => void;
  done: boolean;
}

const MAX_DOWNLOAD_HISTORY = 200;

/** 下载管理：会话级 will-download → 内存条目 + 变更推送；文件落盘目录由偏好注入。 */
export class DownloadsBridge {
  private handles = new Map<string, DownloadHandle>();
  private seq = 0;
  /** 等待放行的下载 id（注册顺序 = 下载顺序）。 */
  private queue: string[] = [];
  /** 当前正在下载的队列项；同一时刻只放行一个。 */
  private activeId: string | null = null;
  /** 用户选择「始终打开」的扩展名（小写，带点）。 */
  private autoOpen = new Set<string>();
  /** 已结束的下载记录（跨重启持久化；只存视图，不持有 DownloadItem）。 */
  private history: DownloadView[] = [];
  /** 文件存在性缓存：轮询检测外部删除，变化时推送 UI。 */
  private missing = new Map<string, boolean>();
  /** 进度推送节流：下载 updated 事件很密，避免整页 UI 每 10ms 重渲染。 */
  private lastProgressPush = 0;

  constructor(
    private getDownloadDir: () => string,
    private onChange: () => void,
    private onLocalFile?: (file: string) => boolean,
    private onSource?: (webContents: Electron.WebContents) => void,
  ) {
    this.loadHistory();
    this.loadAutoOpen();
    this.checkMissing();
    const missingTimer = setInterval(() => this.checkMissing(), 5000);
    missingTimer.unref?.();
    app.on("will-quit", () => {
      clearInterval(missingTimer);
      this.markActiveInterrupted("app-closed");
    });
    session.fromPartition(SESSION_PARTITION).on("will-download", (event, item, webContents) => {
      // 下载常由 target=_blank 触发：把发起下载的空白标签交给宿主处理，避免落到新建页。
      // 注意：session.downloadURL（重试）没有发起 webContents，必须判空。
      if (webContents) this.onSource?.(webContents);
      // 拖入的 Office 文档在 Chromium 里有时走“下载”而不是导航：此时不能弹系统 Save As，
      // 交给壳层转 PDF 预览；普通 http(s) 下载完全不受影响。
      const localFile = officeFileFromUrl(item.getURL());
      if (localFile && this.onLocalFile?.(localFile)) {
        event.preventDefault();
        return;
      }
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

  private autoOpenFile(): string {
    return path.join(app.getPath("userData"), "downloads-auto-open.json");
  }

  private loadAutoOpen(): void {
    try {
      const raw = fs.readFileSync(this.autoOpenFile(), "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        this.autoOpen = new Set(parsed.filter((value): value is string => typeof value === "string" && value.startsWith(".")));
      }
    } catch {
      // 文件不存在/损坏：空集合启动，不影响下载。
    }
  }

  private saveAutoOpen(): void {
    try {
      fs.writeFileSync(this.autoOpenFile(), JSON.stringify([...this.autoOpen]));
    } catch {
      // 写失败只影响下次启动的自动打开，不影响当前下载。
    }
  }

  private historyFile(): string {
    return path.join(app.getPath("userData"), "downloads-history.json");
  }

  private loadHistory(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.historyFile(), "utf8")) as unknown;
      if (!Array.isArray(parsed)) return;
      let recovered = false;
      this.history = parsed
        .filter((entry): entry is DownloadView => {
          if (!entry || typeof entry !== "object") return false;
          const view = entry as Partial<DownloadView>;
          return typeof view.id === "string"
            && typeof view.filename === "string"
            && typeof view.savePath === "string"
            && typeof view.url === "string"
            && (view.state === "completed" || view.state === "cancelled" || view.state === "interrupted" || view.state === "progressing")
            && typeof view.received === "number"
            && typeof view.total === "number"
            && typeof view.startedAt === "number";
        })
        .map((view): DownloadView => {
          if (view.state !== "progressing") return view;
          // 启动时仍有 progressing：上次进程被关闭/崩溃，没来得及写 done。
          recovered = true;
          return { ...view, state: "interrupted", reason: "stale", queued: false };
        })
        .slice(0, MAX_DOWNLOAD_HISTORY);
      if (recovered) this.saveHistory();
    } catch {
      // 首次启动或文件损坏：空历史启动，不影响新下载。
    }
  }

  private saveHistory(): void {
    try {
      fs.writeFileSync(this.historyFile(), JSON.stringify(this.history));
    } catch {
      // 写失败只影响下次启动的历史，不影响当前下载。
    }
  }

  /** 记住一条下载（开始即写 progressing，进程崩溃后下次启动能识别为中断）。 */
  private remember(view: DownloadView): void {
    const record: DownloadView = { ...view, queued: false };
    this.history = [record, ...this.history.filter((item) => item.id !== record.id)].slice(0, MAX_DOWNLOAD_HISTORY);
    this.saveHistory();
  }

  private forget(id: string): void {
    this.missing.delete(id);
    const next = this.history.filter((item) => item.id !== id);
    if (next.length === this.history.length) return;
    this.history = next;
    this.saveHistory();
  }

  private allViews(): DownloadView[] {
    const byId = new Map<string, DownloadView>();
    for (const handle of this.handles.values()) byId.set(handle.view.id, handle.view);
    for (const record of this.history) if (!byId.has(record.id)) byId.set(record.id, record);
    return [...byId.values()];
  }

  /** 轮询 completed 文件是否存在；外部删除/移动后推送 UI（列表横杠 + 已删除）。 */
  private checkMissing(): void {
    let changed = false;
    for (const view of this.allViews()) {
      const missing = view.state === "completed" && Boolean(view.savePath) && !fs.existsSync(view.savePath);
      const previous = this.missing.get(view.id);
      if (previous !== undefined && previous !== missing) changed = true;
      this.missing.set(view.id, missing);
    }
    if (changed) this.onChange();
  }

  /** 失败原因：保存目录不可写 → 没权限；否则按网络/其它中断。 */
  private interruptionReason(view: DownloadView): DownloadReason {
    try {
      fs.accessSync(path.dirname(view.savePath), fs.constants.W_OK);
      if (fs.existsSync(view.savePath)) fs.accessSync(view.savePath, fs.constants.W_OK);
      return "interrupted";
    } catch {
      return "permission";
    }
  }

  /** 应用退出时把未完成下载记为中断；正常退出也能留下记录。 */
  private markActiveInterrupted(reason: DownloadReason): void {
    for (const handle of this.handles.values()) {
      if (handle.done) continue;
      // 只写历史副本：will-quit 可能被其它处理器取消，不能污染仍在下载的 view。
      let received = handle.view.received;
      let total = handle.view.total;
      try {
        received = handle.item.getReceivedBytes();
        total = Math.max(total, handle.item.getTotalBytes());
      } catch {
        // DownloadItem 已被销毁：用最后一次进度。
      }
      this.remember({
        ...handle.view,
        state: "interrupted",
        queued: false,
        reason,
        received,
        total,
      });
    }
  }

  private retry(url: string): boolean {
    if (!url) return false;
    try {
      session.fromPartition(SESSION_PARTITION).downloadURL(url);
      return true;
    } catch {
      return false;
    }
  }

  private register(item: Electron.DownloadItem): void {
    this.seq += 1;
    // 带上会话时间前缀：重启后 seq 归零，不能和历史记录里的 dl-1 撞 id。
    const id = `dl-${Date.now().toString(36)}-${this.seq}`;
    const filename = item.getFilename() || `download-${this.seq}`;
    const savePath = path.join(this.dir(), filename.replace(/[\\/:*?"<>|]/g, "_"));
    try {
      item.setSavePath(savePath);
    } catch (err) {
      // 目录不可用时交给 electron 默认路径
      if (process.env.LOOPSOAR_DEBUG_DOWNLOAD === "1") {
        console.log("[download] setSavePath failed", JSON.stringify({ savePath, error: err instanceof Error ? err.message : String(err) }));
      }
    }
    const view: DownloadView = {
      id,
      filename,
      savePath,
      url: item.getURL(),
      state: "progressing",
      received: 0,
      total: Math.max(0, item.getTotalBytes()),
      startedAt: Date.now(),
    };
    if (process.env.LOOPSOAR_DEBUG_DOWNLOAD === "1") {
      console.log("[download] start", JSON.stringify({ url: item.getURL(), mime: item.getMimeType(), total: view.total, savePath }));
    }
    const handle: DownloadHandle = {
      view,
      item,
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
    this.missing.set(id, false);
    this.remember(view);

    item.on("updated", (_e, state) => {
      // 队列项：即使 will-download 阶段的 pause() 没生效，也在第一次进度回调时强制暂停，
      // 避免「已入队但仍在后台下载」。轮到它时 pump() 会先把 queued 置 false 再 resume。
      if (view.queued) {
        try {
          if (!item.isPaused()) {
            item.pause();
            this.logQueue("force-pause", { id, paused: item.isPaused(), received: item.getReceivedBytes() });
          }
        } catch {
          // 已结束
        }
        return;
      }
      view.received = item.getReceivedBytes();
      view.total = Math.max(view.total, item.getTotalBytes());
      if (state === "interrupted") view.state = "interrupted";
      if (process.env.LOOPSOAR_DEBUG_DOWNLOAD === "1") {
        console.log("[download] updated", JSON.stringify({ state, received: view.received, total: view.total }));
      }
      const now = Date.now();
      if (now - this.lastProgressPush >= 120) {
        this.lastProgressPush = now;
        this.onChange();
      }
    });
    item.once("done", (_e, state) => {
      handle.done = true;
      view.queued = false;
      view.state = state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "interrupted";
      view.received = item.getReceivedBytes();
      view.total = Math.max(view.total, item.getTotalBytes());
      // setSavePath 失败/Chromium 重名时，实际落盘路径可能和计算值不同。
      const actualSavePath = item.getSavePath();
      if (actualSavePath) view.savePath = actualSavePath;
      view.reason = state === "cancelled" ? "cancelled" : state === "interrupted" ? this.interruptionReason(view) : undefined;
      this.missing.set(id, view.state === "completed" && Boolean(view.savePath) && !fs.existsSync(view.savePath));
      if (process.env.LOOPSOAR_DEBUG_DOWNLOAD === "1") {
        console.log("[download] done", JSON.stringify({ state, received: view.received, total: view.total, savePath, url: item.getURL() }));
      }
      if (this.activeId === id) this.activeId = null;
      this.dequeue(id);
      if (this.handles.get(id) === handle) this.remember(view);
      this.onChange();
      if (state === "completed") {
        const ext = path.extname(view.filename).toLowerCase();
        if (ext && this.autoOpen.has(ext)) void shell.openPath(view.savePath);
      }
      this.pump();
    });
    // 队列：新下载先暂停，按注册顺序由 pump() 逐个放行；UI 的「开始」可插队。
    view.queued = true;
    this.queue.push(id);
    this.logQueue("enqueue", { id, url: item.getURL(), paused: item.isPaused(), active: this.activeId, queue: this.queue.length });
    const pauseItem = (): void => {
      try {
        item.pause();
      } catch {
        // 少数协议不可暂停：仍入队，pump 时 resume 不生效也不会阻塞其它下载
      }
    };
    pauseItem();
    // will-download 阶段有时还没进入可暂停状态：下一拍再补一次，确保真的排队而不是并发。
    if (!item.isPaused()) {
      setTimeout(pauseItem, 0);
    }
    this.onChange();
    this.pump();
  }

  /** 队列诊断：写入 userData/downloads.log，便于排查「为何没有排队」。失败不影响下载。 */
  private logQueue(event: string, data: Record<string, unknown>): void {
    try {
      const file = path.join(app.getPath("userData"), "downloads.log");
      fs.appendFileSync(file, `${new Date().toISOString()} ${event} ${JSON.stringify(data)}\n`);
    } catch {
      // 日志失败不影响下载
    }
  }

  private dequeue(id: string): void {
    const index = this.queue.indexOf(id);
    if (index >= 0) this.queue.splice(index, 1);
  }

  /** 一次只放行一个下载；完成/取消后自动推进队列。 */
  private pump(): void {
    if (this.activeId) return;
    const id = this.queue.shift();
    if (!id) return;
    const handle = this.handles.get(id);
    if (!handle || handle.done) {
      this.pump();
      return;
    }
    this.activeId = id;
    handle.view.queued = false;
    this.logQueue("pump", { id, queue: this.queue.length, paused: handle.item.isPaused() });
    try {
      handle.item.resume();
    } catch {
      // 恢复失败由 done/updated 兜底
    }
    if (handle.item.isPaused()) {
      setTimeout(() => {
        try {
          handle.item.resume();
        } catch {
          // 已结束
        }
      }, 0);
    }
    this.onChange();
  }

  /** 插队：立即开始指定项；当前活动项暂停并放回队首，稍后优先恢复。 */
  private startNow(id: string): boolean {
    const handle = this.handles.get(id);
    if (!handle || handle.done) return false;
    if (this.activeId === id) {
      try {
        handle.item.resume();
      } catch {
        // 已结束
      }
      return true;
    }
    if (this.activeId) {
      const current = this.handles.get(this.activeId);
      if (current && !current.done) {
        try {
          current.item.pause();
        } catch {
          // 已结束
        }
        current.view.queued = true;
        if (!this.queue.includes(this.activeId)) this.queue.unshift(this.activeId);
      }
      this.activeId = null;
    }
    this.dequeue(id);
    this.activeId = id;
    handle.view.queued = false;
    try {
      handle.item.resume();
    } catch {
      // 已结束
    }
    this.onChange();
    return true;
  }

  list(): DownloadView[] {
    // 进行中/排队中的按队列顺序（先来的在前），已结束的按最新在前：
    // 批量下载时用户先看到「正在下的 + 接下来要下的」，而不是把队首压到列表底部。
    return this.allViews()
      .map((view) => ({ ...view, missing: this.missing.get(view.id) === true }))
      .sort((a, b) => {
        const rank = (v: DownloadView): number => (v.state === "progressing" ? 0 : 1);
        if (rank(a) !== rank(b)) return rank(a) - rank(b);
        return a.state === "progressing" ? a.startedAt - b.startedAt : b.startedAt - a.startedAt;
      });
  }

  action(id: string, action: "cancel" | "open" | "showInFolder" | "remove" | "deleteFile" | "start" | "alwaysOpen" | "retry"): boolean {
    const handle = this.handles.get(id);
    if (!handle) return this.actionHistory(id, action);
    switch (action) {
      case "start":
        return this.startNow(id);
      case "retry":
        return this.retry(handle.view.url);
      case "cancel":
        this.dequeue(id);
        if (this.activeId === id) this.activeId = null;
        handle.cancel();
        this.pump();
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
        this.dequeue(id);
        if (this.activeId === id) this.activeId = null;
        if (!handle.done) handle.cancel();
        this.handles.delete(id);
        this.forget(id);
        this.onChange();
        this.pump();
        return true;
      case "alwaysOpen": {
        const ext = path.extname(handle.view.filename).toLowerCase();
        if (!ext) return false;
        this.autoOpen.add(ext);
        this.saveAutoOpen();
        if (handle.view.state === "completed") void shell.openPath(handle.view.savePath);
        return true;
      }
      case "deleteFile": {
        // Edge 式「删除文件」：先取消进行中的任务，再删磁盘文件并移除记录。
        try {
          handle.cancel();
          if (handle.view.savePath && fs.existsSync(handle.view.savePath)) fs.unlinkSync(handle.view.savePath);
        } catch {
          return false;
        }
        this.dequeue(id);
        if (this.activeId === id) this.activeId = null;
        this.handles.delete(id);
        this.forget(id);
        this.onChange();
        this.pump();
        return true;
      }
    }
  }

  /** 重启后只剩历史记录：打开/定位/移除/删除文件/始终打开仍可用。 */
  private actionHistory(id: string, action: "cancel" | "open" | "showInFolder" | "remove" | "deleteFile" | "start" | "alwaysOpen" | "retry"): boolean {
    const record = this.history.find((item) => item.id === id);
    if (!record) return false;
    switch (action) {
      case "retry":
        return this.retry(record.url);
      case "open":
        if (record.state !== "completed") return false;
        void shell.openPath(record.savePath);
        return true;
      case "showInFolder":
        if (!record.savePath) return false;
        shell.showItemInFolder(record.savePath);
        return true;
      case "remove":
        this.forget(id);
        this.onChange();
        return true;
      case "deleteFile":
        try {
          if (record.savePath && fs.existsSync(record.savePath)) fs.unlinkSync(record.savePath);
        } catch {
          return false;
        }
        this.forget(id);
        this.onChange();
        return true;
      case "alwaysOpen": {
        const ext = path.extname(record.filename).toLowerCase();
        if (!ext) return false;
        this.autoOpen.add(ext);
        this.saveAutoOpen();
        if (record.state === "completed") void shell.openPath(record.savePath);
        return true;
      }
      default:
        return false;
    }
  }
}

const standaloneWindows = new Set<BrowserWindow>();

/** 独立浏览器窗口：共享浏览器分区（登录态），只允许 http/https；原生窗口壳，无应用 UI。 */
export function openStandaloneBrowserWindow(url: string): { ok: boolean; error?: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "URL 不合法" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "仅支持 http/https" };
  }
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    title: parsed.hostname,
    webPreferences: {
      partition: SESSION_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  standaloneWindows.add(win);
  win.on("closed", () => standaloneWindows.delete(win));
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, target) => {
    try {
      const next = new URL(target);
      if (next.protocol !== "http:" && next.protocol !== "https:") event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  win.once("ready-to-show", () => win.show());
  void win.loadURL(parsed.toString()).catch(() => undefined);
  return { ok: true };
}
