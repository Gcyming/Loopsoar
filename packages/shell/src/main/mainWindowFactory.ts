/**
 * 主窗口生命周期（P2-3 从 main/index.ts 拆出）。
 *
 * 只负责创建窗口、几何同步与关闭清理；入口负责提供依赖和持有 mainWindow 引用。
 */
import { BrowserWindow } from "electron";
import { createDebouncedRunner, type BrowserHost } from "./browserHost.js";
import type { AgentWindowManager } from "./agentWindow.js";
import type { E2eHooks } from "./e2eHooks.js";

export interface MainWindowDeps {
  appName: string;
  protocol: string;
  events: unknown;
  bindings(): unknown;
  iconPath(): string | undefined;
  preloadPath(): string;
  bootTrace: { mark(name: string): void };
  deferredBootTasks(): void;
  getBrowserHost(): BrowserHost | null;
  getAgentWindow(): AgentWindowManager | null;
  disposeDevTools(): void;
  syncPointerArea(): void;
  cancelPointerAreaSync(): void;
  onClosed(): void;
  e2eHooks: E2eHooks;
}

export function createMainWindowWindow(deps: MainWindowDeps): BrowserWindow {
  const appIcon = deps.iconPath();
  if (appIcon) console.log(`[Loopsoar] appIcon=${appIcon}`);
  else console.warn("[Loopsoar] appIcon not found — Electron 默认图标兜底");
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    title: deps.appName,
    icon: appIcon,
    backgroundColor: "#111318",
    show: false,
    // 自定义标题栏：隐藏原生标题栏（保留系统缩放/贴边），菜单栏在 ready 时整体移除
    titleBarStyle: "hidden",
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      preload: deps.preloadPath(),
      additionalArguments: [
        `--loopsoar-bindings=${JSON.stringify(deps.bindings())}`,
        `--loopsoar-events=${JSON.stringify(deps.events)}`,
      ],
    },
  });
  win.once("ready-to-show", () => {
    win?.show();
    deps.bootTrace.mark("window-ready-to-show");
    // 首帧已出：此时才启动会 spawn 子进程/同步落盘的非关键任务，避免与渲染抢资源。
    deps.deferredBootTasks();
  });
  // 首帧渲染完成（UI 已可交互）：启动计时的最后一条锚点
  win.webContents.once("did-finish-load", () => deps.bootTrace.mark("window-did-finish-load"));
  // 诊断钩子：preload 失败/渲染报错/加载失败必须在主进程日志可见，否则只能盲猜
  win.webContents.on("preload-error", (_e, preloadPath, error) => {
    console.error("PRELOAD_ERROR", preloadPath, error);
  });
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) console.log(`RENDERER[${level}] ${message}`);
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error("DID_FAIL_LOAD", code, desc, url);
  });
  // 窗口几何变化 → 原生浏览器视图重新对齐（几何来源：contracts/layout）。
  // 为什么要 50ms 防抖 + 监听全部事件：拖拽缩放会连发 resize；maximize/unmaximize 在部分平台
  // 先发「中间尺寸」的 resize 再定格；全屏切换甚至可能不伴随 resize —— 只挂 resize 会让
  // WebContentsView 停在旧 bounds，表现就是「窗口变大了但网页没跟着自适应」。
  const scheduleBoundsSync = createDebouncedRunner(() => deps.getBrowserHost()?.syncBounds(), 50);
  // Agent 独立窗口贴在主窗口右缘：主窗口移动/缩放时必须跟着走，否则会「留在原地」变成位置反逻辑。
  // 16ms 防抖 ≈ 一帧：跟手，但不用每个 move 事件都 setBounds。
  const scheduleAgentWindowFollow = createDebouncedRunner(() => deps.getAgentWindow()?.reposition(), 16);
  const syncWindowGeometry = (): void => {
    scheduleBoundsSync.schedule();
    scheduleAgentWindowFollow.schedule();
    // 窗口移动时视图矩形（内容坐标）不变，但屏幕原点变了：覆盖层必须跟着挪。
    deps.syncPointerArea();
  };
  win.on("move", syncWindowGeometry);
  win.on("resize", syncWindowGeometry);
  win.on("maximize", syncWindowGeometry);
  win.on("unmaximize", syncWindowGeometry);
  win.on("restore", syncWindowGeometry);
  win.on("enter-full-screen", syncWindowGeometry);
  win.on("leave-full-screen", syncWindowGeometry);
  win.on("closed", () => {
    scheduleBoundsSync.cancel();
    scheduleAgentWindowFollow.cancel();
    deps.cancelPointerAreaSync();
    // 独立 Agent 窗口若常驻，主窗口关掉后 window-all-closed 不会触发，进程会残留成“只有小窗”
    // 主窗口销毁场景不需要滑出动画（目标屏幕/工作区可能已不可用），立即关闭。
    deps.getAgentWindow()?.close({ animate: false });
    deps.disposeDevTools();
    deps.onClosed();
  });

  const devUrl = process.env.LOOPSOAR_DEV_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    // E2E 直达：LOOPSOAR_E2E_OPEN=settings 时带 query 打开并自动展开设置面板
    const e2eOpen = process.env.LOOPSOAR_E2E_OPEN;
    const chatText = process.env.LOOPSOAR_E2E_CHAT_TEXT;
    const query = `${e2eOpen ? `?e2e=${e2eOpen}` : "?"}${chatText ? `&chatText=${encodeURIComponent(chatText)}` : ""}`;
    void win.loadURL(`${deps.protocol}://app/index.html${query}`);
  }
  deps.e2eHooks.scheduleE2EScreenshot(win);
  deps.e2eHooks.scheduleE2ERailHover(win);
  deps.e2eHooks.scheduleE2ESidebarRailHover(win);
  deps.e2eHooks.scheduleE2ELiveTool(win);
  deps.e2eHooks.scheduleE2EPlanDemo(win);
  deps.e2eHooks.scheduleE2ESteerDemo(win);
  deps.e2eHooks.scheduleE2ESearchDemo(win);
  deps.e2eHooks.scheduleE2EDemoChat(win);
  deps.e2eHooks.scheduleE2EConfirmShot(win);
  return win;
}
