/**
 * Loopsoar 主进程入口。
 * 允许 import electron 的文件只有两个：本文件与 main/electronBrowser.ts（薄适配层）。
 * 职责：协议注册 → 数据目录 → 域装配（受信 IPC）→ 窗口创建 → 浏览器宿主挂载。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, safeStorage, screen, session, shell } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BROWSER_AGENT_TOOLS, CHANNEL_BINDINGS, EVENTS } from "loopsoar-contracts/schemas";
import { renderHeaderTemplates } from "loopsoar-contracts/headerTemplate";
import { createNodePlatform } from "loopsoar-core/platform";
import { ToolRegistry } from "loopsoar-core/tools/registry";
import { registerBuiltinMinimal } from "loopsoar-core/tools/builtin";
import { SandboxManager } from "loopsoar-core/sandbox";
import { ChatService, resolveToolSurface } from "loopsoar-services/chat";
import { createAnthropicClient, createOpenAiClient, inferApiFormat, type LlmClient } from "loopsoar-core/llm";
import { AgentRegistry, BUILTIN_AGENT } from "loopsoar-core/agent";
import { resolveApiKeyFromEnv } from "loopsoar-core/provider";
import { loadPreferences, loadPermissions } from "./domains/settings.js";
import { resolveDataDir } from "./dataDir.js";
import { APP_ID, APP_NAME, PROTOCOL } from "../shared/brand.js";
import { type AuditEntry, type TrustedIpcDeps } from "./trustedIpc.js";
import {
  createBootTrace,
  ensureLoopsoarDirs,
  makePlaceholderProtocolHandler,
  makeUiProtocolHandler,
} from "./boot.js";
import { resolveUiDistDir, uiDistCandidates } from "./uiProtocol.js";
import { BrowserDevToolsPanel, createElectronBrowserHost, DownloadsBridge, resolveFaviconForPage } from "./electronBrowser.js";
import { BrowserExtensionHost, type ExtensionApiLike } from "./browserExtensions.js";
import { SESSION_PARTITION } from "../shared/brand.js";
import { withProviderDefaults } from "./providerDefaults.js";
import { createDebouncedRunner, USER_TABS_SESSION, type BrowserHost } from "./browserHost.js";
import { sanitizeBrowserState } from "./browserSessionState.js";
import { BrowserStateStore } from "./browserStateStore.js";
import { BrowserHistoryStore } from "./browserHistoryStore.js";
import type { PersistedBrowserState } from "./browserSessionState.js";
import { registerRuntimeDomain } from "./domains/runtime.js";
import { registerWorkspaceDomain } from "./domains/workspace.js";
import { registerAgentsDomain } from "./domains/agents.js";
import { flushActivePartials, registerChatDomain } from "./domains/chat.js";
import { registerToastDomain } from "./domains/toast.js";
import { createToastWindow } from "./toastWindow.js";
import { createAgentPointerWindow, type AgentPointerController } from "./agentPointerWindow.js";
import { registerCompactDomain } from "./domains/compact.js";
import { registerBrowserDomain } from "./domains/browserAdapter.js";
import { registerWindowDomain } from "./domains/window.js";
import {
  loadProviderConfig,
  registerSettingsDomain,
  currentRulesPrompt,
  readRuleEntries,
  savePreferencesPatch,
} from "./domains/settings.js";
import { checkRuleGuards, compileRuleGuards } from "loopsoar-core/rules/guard";
import { checkCommandGuards, compileCommandGuards } from "loopsoar-core/rules/commandGuard";
import { registerMemoryTools } from "./memoryTools.js";
import { buildSessionEpisode } from "./memoryEpisode.js";
import { registerSearchTools } from "./searchTools.js";
import { readImageDataUrl } from "./imageRead.js";
import { createLoopRuntime } from "./loopRuntime.js";
import { registerLoopDomain } from "./domains/loop.js";
import { AskBus } from "./askBus.js";
import { setAgentTabPredicate } from "./browserRequestGuard.js";
import { registerAskDomain } from "./domains/ask.js";
import { registerAskTools } from "./askTools.js";
import { BookmarksStore } from "./bookmarksStore.js";
import { registerBookmarksDomain } from "./domains/bookmarks.js";
import { registerPageSaveDomain } from "./domains/pageSave.js";
import { registerMemoryDomain } from "./domains/memory.js";
import { registerRuleLearningDomain } from "./domains/ruleLearning.js";
import { RuleCandidateStore } from "./ruleCandidates.js";
import { RuleStatsStore } from "./ruleStats.js";
import { RuleHistoryStore } from "./ruleHistory.js";
import { ToolEvidence } from "./toolEvidence.js";
import { reviewMemory } from "./memoryReview.js";
import { reviewSessionRules } from "./ruleReview.js";
import { MemoryService } from "./memoryService.js";
import { SessionStore } from "./sessionStore.js";
import { WorkspaceStore } from "./workspaceStore.js";
import { resolveSessionRoot as resolveRoot } from "./workspaceRoot.js";
import { removeWorktree } from "./gitWorktree.js";
import { ProviderStore } from "./providerStore.js";
import { SecretStore } from "./secretStore.js";
import { ExtensionHost } from "./extensions.js";
import { SkillHost } from "./skills.js";
import { McpHost } from "./mcpHost.js";
import { registerBrowserTools } from "./browserTools.js";
import { registerTerminalTools } from "./terminalTools.js";
import { registerPlanTools } from "./planTools.js";
import { registerFileTools } from "./fileTools.js";
import { registerDocumentTools } from "./documentTools.js";
import { registerSkillTools } from "./skillTools.js";
import { createChatSubagentRunner, registerSubagentTools } from "./subagentTools.js";
import { registerExtensionsDomain } from "./domains/extensions.js";
import { createChromePopoverManager } from "./chromePopover.js";
import { registerChromePopoverDomain } from "./domains/chromePopover.js";
import { createAgentWindowManager, type AgentWindowManager } from "./agentWindow.js";
import { resolveAppIconPath } from "./appIcon.js";
import { registerAgentWindowDomain } from "./domains/agentWindow.js";
import { ExtensionRuntime, resolveWorkerPath } from "./extensionRuntime.js";
import { registerSkillsDomain } from "./domains/skills.js";
import { registerMcpDomain } from "./domains/mcp.js";
import { registerFsDomain } from "./domains/fs.js";
import { registerTerminalDomain } from "./domains/terminal.js";
import { TerminalSessionManager } from "./terminalSession.js";
import { AuditFileLogger } from "./auditFile.js";
import { createShutdownHandler } from "./shutdown.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 启动链路计时：LOOPSOAR_BOOT_TRACE=1 时打印各阶段耗时（默认关闭，无开销）。 */
const bootTrace = createBootTrace();

// 自定义协议必须声明为 standard + secure，相对路径资源与 fetch 才能按网页语义工作。
// 必须在 app ready 之前调用（Electron 要求），因此放在模块顶层。
protocol.registerSchemesAsPrivileged([
  {
    scheme: PROTOCOL,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

// 项目隔离：userData 显式落到品牌目录（%APPDATA%\loopsoar），与其他 Electron 应用数据区完全分开。
// LOOPSOAR_DATA_DIR 可覆盖（受限/只读环境下用可写目录，如 CI 或沙箱会话）。
// 覆盖值必须归一为绝对路径：Electron 的 app.setPath 只接受绝对路径，
// 脚本里传相对目录（如 LOOPSOAR_DATA_DIR=.loopsoar-data）会在启动时报 “Path must be absolute”。
app.setName(APP_NAME);
// Windows 任务栏/通知身份必须与品牌 appId 一致：缺省会落到 electron.exe 的默认身份，
// 任务栏显示 Electron 默认图标，还可能被合并进别的 Electron 开发应用分组（用户报障：图标错位）。
if (process.platform === "win32") app.setAppUserModelId(APP_ID);
app.setPath("userData", resolveDataDir(process.env.LOOPSOAR_DATA_DIR, app.getPath("appData")));
// 模块顶层工作到此结束（import 图求值 + 协议声明 + userData 落位）；@Xms 即「进程启动→JS 入口就绪」。
bootTrace.mark("module-eval");

/** 审计：内存环形缓冲（诊断快照，最多 200 条）+ JSONL 落盘（发布门：审计可追溯）。 */
const AUDIT_RING_MAX = 200;
const auditLog: AuditEntry[] = [];
/** 数据目录就绪后初始化；启动早期的审计只进内存环。 */
let auditFile: AuditFileLogger | null = null;
const deps: TrustedIpcDeps = {
  ipc: ipcMain,
  audit: (entry) => {
    auditLog.push(entry);
    if (auditLog.length > AUDIT_RING_MAX) auditLog.shift();
    auditFile?.append(entry);
  },
};

/** preload 白名单数据：经 additionalArguments 注入 CJS 预加载脚本。 */
function buildBindings(): { channel: string; domain: string; method: string }[] {
  return Object.entries(CHANNEL_BINDINGS).map(([channel, b]) => ({
    channel,
    domain: b.domain,
    method: b.method,
  }));
}

function pushToRenderer(event: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    void w.webContents.send(`loopsoar:${event}`, payload);
  }
}

let mainWindow: BrowserWindow | null = null;
let browserHost: BrowserHost | null = null;
/** 浏览器扩展宿主（浏览器 preload 的「商店安装」IPC 需要模块级访问）。 */
let browserExtensionsHost: BrowserExtensionHost | null = null;
/** 底部开发者工具面板（main() 内创建；主窗口 closed 时释放）。 */
let devToolsPanel: BrowserDevToolsPanel | null = null;
// 首帧后启动的非关键任务（main() 内装配；createMainWindow 的 ready-to-show 回调里触发）
let deferredBootTasks: (() => void) | null = null;
// Agent 会话栏独立窗口管理器（main() 内创建；createMainWindow 的 closed 回调需在模块作用域访问）
let agentWindow: AgentWindowManager | null = null;
/** Agent 虚拟指针覆盖窗口（应用级；主窗口 closed 时销毁）。 */
let agentPointer: AgentPointerController | null = null;
/** 当前把虚拟光标置为常驻的会话（并发会话时只由开启它的那一轮释放）。 */
let pointerHeldSession: string | null = null;
/** 正在跑 Agent 轮次、且开启浏览器控制的会话：页面加载完成时据此把光标补成常驻。 */
const agentTurnSessions = new Set<string>();

/** Agent 在这个会话动手：只要该会话的网页正显示，就把覆盖层光标切成常驻。 */
function holdPointerForAgent(sessionId: string): void {
  if (!agentPointer || !browserHost?.isSessionVisible(sessionId)) return;
  agentPointer.hold(true);
  pointerHeldSession = sessionId;
}
/** 网页视图矩形（主窗口内容坐标）；null = 当前没有可见网页。几何由 BrowserHost.applyLayout 单源推送。 */
let lastViewRect: { x: number; y: number; width: number; height: number } | null = null;

/**
 * 把覆盖指针贴到网页视图上：屏幕坐标 = 主窗口内容区原点 + 视图矩形。
 * 单源：矩形与原生 WebContentsView 是同一份 bounds，这里只做平移，绝不另算一套几何。
 */
function syncPointerArea(): void {
  if (!agentPointer) return;
  if (!lastViewRect || !mainWindow || mainWindow.isDestroyed()) {
    agentPointer.setArea(null);
    return;
  }
  const content = mainWindow.getContentBounds();
  agentPointer.setArea({
    x: content.x + lastViewRect.x,
    y: content.y + lastViewRect.y,
    width: lastViewRect.width,
    height: lastViewRect.height,
  });
}
const schedulePointerAreaSync = createDebouncedRunner(syncPointerArea, 16);

/**
 * 退出清理：MCP/扩展子进程、终端会话、标签落盘、审计 flush 必须收尾。
 * 用 preventDefault 先拦住默认退出，清理完成后再 app.exit（幂等，避免退出循环）。
 */
let shutdownHandler: (() => Promise<void>) | null = null;
let quitting = false;
app.on("before-quit", (event) => {
  if (!shutdownHandler || quitting) return;
  quitting = true;
  event.preventDefault();
  void shutdownHandler()
    .catch(() => undefined)
    .finally(() => {
      app.exit(0);
    });
});

/** 应用图标路径：dist/src/打包三种目录深度都探测，Windows 优先多档 .ico（详见 appIcon.ts）。 */
function iconPath(): string | undefined {
  return resolveAppIconPath({
    dirname: __dirname,
    resourcesPath: process.resourcesPath,
    cwd: process.cwd(),
    platform: process.platform,
  });
}

/** preload 路径按运行形态探测（bundle/dist 运行与 src 运行目录深度不同）。 */
function preloadPath(): string {
  const candidates = [
    path.join(__dirname, "../src/preload/index.cjs"), // bundle/dist 运行
    path.join(__dirname, "../../src/preload/index.cjs"), // src/main 运行
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) console.error("PRELOAD_NOT_FOUND candidates=", candidates);
  return found ?? candidates[0];
}

/** E2E/验收截图钩子：设置 LOOPSOAR_E2E_SHOT=<path> 时，加载完成后（可选先导航）截图并退出。 */
function scheduleE2EScreenshot(win: BrowserWindow): void {
  const shotPath = process.env.LOOPSOAR_E2E_SHOT;
  if (!shotPath) return;
  win.webContents.once("did-finish-load", () => {
    setTimeout(() => {
      void (async () => {
        try {
          await new Promise((r) => setTimeout(r, Number(process.env.LOOPSOAR_E2E_HOLD_MS ?? 800))); // 等 React 首帧与 IPC 数据渲染
          const navUrl = process.env.LOOPSOAR_E2E_NAV_URL;
          if (navUrl) {
            const outcome = await browserHost?.navigate(navUrl);
            console.log("E2E_NAV", JSON.stringify(outcome));
            await new Promise((r) => setTimeout(r, Number(process.env.LOOPSOAR_E2E_NAV_WAIT_MS ?? 2500))); // 等真实页面渲染完成
            if (process.env.LOOPSOAR_E2E_BROWSER_EVAL) {
              try {
                const result = await browserHost?.executeInActiveTab(process.env.LOOPSOAR_E2E_BROWSER_EVAL);
                console.log("E2E_BROWSER_EVAL", JSON.stringify(result ?? null));
              } catch (err) {
                console.log("E2E_BROWSER_EVAL", JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
              }
            }
            if (process.env.LOOPSOAR_E2E_STORE_INSTALL) {
              try {
                const extension = await browserExtensionsHost?.installFromStore(process.env.LOOPSOAR_E2E_STORE_INSTALL);
                console.log("E2E_STORE_INSTALL", JSON.stringify({ ok: true, id: extension?.id, name: extension?.name, version: extension?.version }));
              } catch (err) {
                console.log("E2E_STORE_INSTALL", JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
              }
            }
          }
          // 验收辅助：按可见文案点击一次（如设置页「编辑」），用于截图前展开表单
          // E2E：动画轨迹采样（LOOPSOAR_E2E_AGENT_TRACE=1）——点击前开始每 16ms 记录
          // 非主窗口 bounds 与原生视图 sidebarWidth，验证「滑入 / 侧栏让位」是逐帧插值而非瞬跳。
          const traceStart = Date.now();
          const traceTimer =
            process.env.LOOPSOAR_E2E_AGENT_TRACE === "1"
              ? setInterval(() => {
                  const others = BrowserWindow.getAllWindows()
                    .filter((w) => w !== win)
                    .map((w) => w.getBounds());
                  console.log(
                    "AGENT_TRACE",
                    JSON.stringify({
                      t: Date.now() - traceStart,
                      wins: others,
                      browser: browserHost ? browserHost.debugBounds() : null,
                    }),
                  );
                }, 16)
              : null;

          const clickText = process.env.LOOPSOAR_E2E_CLICK_TEXT;
          if (clickText) {
            const clickDelay = Number(process.env.LOOPSOAR_E2E_CLICK_DELAY_MS ?? 0);
            if (Number.isFinite(clickDelay) && clickDelay > 0) {
              await new Promise((r) => setTimeout(r, clickDelay));
            }
            // 支持 "编辑|OpenCode Go" 依次点击多个可见文案，用于截图前展开并填充表单
            // 两次点击之间的间隔可配（终端配置档探测等异步内容需要更长等待）
            const clickGapMs = Number(process.env.LOOPSOAR_E2E_CLICK_GAP_MS ?? 500);
            for (const wanted of clickText.split("|").map((item) => item.trim()).filter(Boolean)) {
              const clicked = await win.webContents
                .executeJavaScript(
                  `(() => {
                    const wanted = ${JSON.stringify(wanted)};
                    const nodes = Array.from(document.querySelectorAll('button, [role="button"]'));
                    const target = nodes.find(
                      (node) => (node.textContent || '').trim() === wanted || node.getAttribute('title') === wanted,
                    );
                    if (!target) return false;
                    target.click();
                    return true;
                  })()`,
                  true,
                )
                .catch(() => false);
              console.log("E2E_CLICK", wanted, clicked);
              await new Promise((r) => setTimeout(r, Number.isFinite(clickGapMs) ? clickGapMs : 500));
            }
            await new Promise((r) => setTimeout(r, 500));
            const postClick = Number(process.env.LOOPSOAR_E2E_POST_CLICK_MS ?? 0);
            if (Number.isFinite(postClick) && postClick > 0) {
              await new Promise((r) => setTimeout(r, postClick));
            }
          }
          // 动画轨迹：点击后再采 800ms，然后停止
          if (traceTimer) {
            await new Promise((r) => setTimeout(r, 800));
            clearInterval(traceTimer);
            console.log("AGENT_TRACE_DONE");
          }

          // E2E：主窗口标题栏按钮 hover 反馈（LOOPSOAR_E2E_HOVER_WIN_BUTTON=0|1|2）——
          // 用真实 mouseMove 触发 CSS :hover，截图验证「最小化/最大化/关闭」有可见反馈。
          if (process.env.LOOPSOAR_E2E_HOVER_WIN_BUTTON) {
            const index = Number(process.env.LOOPSOAR_E2E_HOVER_WIN_BUTTON);
            const rect = await win.webContents
              .executeJavaScript(
                `(() => {
                  const buttons = Array.from(document.querySelectorAll('.win-btn'));
                  const el = buttons[${JSON.stringify(Number.isFinite(index) ? index : 2)}];
                  if (!el) return null;
                  const r = el.getBoundingClientRect();
                  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), count: buttons.length, bg: getComputedStyle(el).backgroundColor };
                })()`,
                true,
              )
              .catch(() => null);
            if (rect) {
              win.webContents.sendInputEvent({ type: "mouseMove", x: rect.x, y: rect.y });
              await new Promise((r) => setTimeout(r, 350));
              const hovered = await win.webContents
                .executeJavaScript(
                  `(() => { const el = document.querySelectorAll('.win-btn')[${JSON.stringify(Number.isFinite(index) ? index : 2)}]; return el ? { hover: el.matches(':hover'), bg: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color } : null; })()`,
                  true,
                )
                .catch(() => null);
              console.log("E2E_HOVER_WIN_BUTTON", JSON.stringify({ rect, hovered }));
              const hoverShot = shotPath.replace(/\.png$/, "-hover.png");
              fs.mkdirSync(path.dirname(hoverShot), { recursive: true });
              fs.writeFileSync(hoverShot, (await win.capturePage()).toPNG());
              console.log("E2E_HOVER_SHOT", hoverShot);
            }
          }

          // E2E：窗口自适应验证（LOOPSOAR_E2E_RESIZE=1100x760）——
          // 依次量 contentSize / 原生视图 bounds / 活动页 window.innerWidth，确认三者同步变化；
          // 另跑 maximize/unmaximize（LOOPSOAR_E2E_FULLSCREEN=1 时再跑全屏），覆盖「事件不伴随 resize」路径。
          if (process.env.LOOPSOAR_E2E_RESIZE) {
            const [w, h] = process.env.LOOPSOAR_E2E_RESIZE.split("x").map((v) => Number(v));
            const host = browserHost;
            const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
            const pageMetrics = async (): Promise<unknown> =>
              (await host?.debugEval(
                "(() => ({ innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio, vv: window.visualViewport ? Math.round(window.visualViewport.width) : null }))()",
              )) ?? null;
            const steps: { step: string; contentSize: number[]; browser: unknown; page: unknown }[] = [];
            const probe = async (step: string): Promise<void> => {
              const browser = host ? host.debugBounds() : null;
              steps.push({ step, contentSize: win.getContentSize(), browser, page: await pageMetrics() });
              console.log("E2E_RESIZE_STEP", JSON.stringify(steps[steps.length - 1]));
            };
            await probe("baseline");
            if (Number.isFinite(w) && Number.isFinite(h) && w > 400 && h > 400) {
              win.setContentSize(Math.round(w), Math.round(h));
              await sleep(900);
              await probe("setContentSize");
            }
            // maximize/unmaximize：Windows 上可能先发中间尺寸 resize 再定格，验证防抖后的最终几何
            win.maximize();
            await sleep(900);
            await probe("maximize");
            win.unmaximize();
            await sleep(900);
            await probe("unmaximize");
            // 全屏：F11 类切换在部分平台不伴随 resize，仅显式开关时验证（避免影响常规截图）
            if (process.env.LOOPSOAR_E2E_FULLSCREEN === "1") {
              win.setFullScreen(true);
              await sleep(1200);
              await probe("fullscreen");
              win.setFullScreen(false);
              await sleep(1200);
              await probe("exitFullScreen");
            }
            if (Number.isFinite(w) && Number.isFinite(h) && w > 400 && h > 400) {
              win.setContentSize(Math.round(w), Math.round(h));
              await sleep(600);
            }
            console.log("E2E_RESIZE", JSON.stringify({ steps }));
          }

          // E2E：向上滚动离开底部，验证「锁定最新」不会把用户拽回去，且出现回到最新按钮
          if (process.env.LOOPSOAR_E2E_SCROLL_UP) {
            const top = await win.webContents
              .executeJavaScript(
                `(() => {
                  const el = document.querySelector('.chat-scroll');
                  if (!el) return -1;
                  el.scrollBy(0, -700);
                  return el.scrollTop;
                })()`,
                true,
              )
              .catch(() => -1);
            console.log("E2E_SCROLL_UP", top);
            await new Promise((r) => setTimeout(r, 900));
          }

          // E2E：任意表达式求值（LOOPSOAR_E2E_EVAL）——探针用，生产不触发
          if (process.env.LOOPSOAR_E2E_EVAL) {
            const result = await win.webContents
              .executeJavaScript(process.env.LOOPSOAR_E2E_EVAL, true)
              .catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));
            console.log("E2E_EVAL", JSON.stringify(result));
          }

          // E2E：受信鼠标点击 range 轨道（合成 input 会被 React 的值追踪丢弃；原生事件才改得动受控滑块）。
          if (process.env.LOOPSOAR_E2E_RANGE_CLICK) {
            const [selector, ratioRaw] = process.env.LOOPSOAR_E2E_RANGE_CLICK.split(":");
            const ratio = Number.isFinite(Number(ratioRaw)) ? Number(ratioRaw) : 0.5;
            const rect = await win.webContents
              .executeJavaScript(
                `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`,
                true,
              )
              .catch(() => null);
            if (rect) {
              const x = Math.round(rect.x + rect.w * ratio);
              const y = Math.round(rect.y + rect.h / 2);
              win.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
              win.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
              await new Promise((r) => setTimeout(r, 900));
              console.log("E2E_RANGE_CLICK", JSON.stringify({ x, y }));
            } else {
              console.log("E2E_RANGE_CLICK", JSON.stringify({ error: "not-found" }));
            }
          }

          // E2E：浮层窗口清单（验证「点击已展开的按钮收起到 0 个子窗口」等交互）
          if (process.env.LOOPSOAR_E2E_WINDOWS) {
            console.log(
              "E2E_WINDOWS",
              JSON.stringify(
                BrowserWindow.getAllWindows().map((w) => ({
                  title: w.getTitle(),
                  visible: typeof w.isVisible === "function" ? w.isVisible() : null,
                })),
              ),
            );
          }

          // E2E：捕获工具栏浮层窗口自身（验证阴影是否在页面内容里 vs 窗口 DWM 阴影）
          if (process.env.LOOPSOAR_E2E_POPOVER_SHOT) {
            await new Promise((r) => setTimeout(r, Number(process.env.LOOPSOAR_E2E_POPOVER_HOLD_MS ?? 1200)));
            const popWin = BrowserWindow.getAllWindows().find((w) => w !== win);
            if (popWin) {
              const png = (await popWin.capturePage()).toPNG();
              fs.writeFileSync(process.env.LOOPSOAR_E2E_POPOVER_SHOT, png);
              console.log("E2E_POPOVER_SHOT", process.env.LOOPSOAR_E2E_POPOVER_SHOT, png.length);
            } else {
              console.log("E2E_POPOVER_SHOT_NO_WINDOW");
            }
          }

          // E2E：悬停预览（LOOPSOAR_E2E_HOVER_TITLE=更多）——真实 mouseMove 触发 250ms hover 打开浮层
          if (process.env.LOOPSOAR_E2E_HOVER_TITLE) {
            const target = process.env.LOOPSOAR_E2E_HOVER_TITLE;
            const rect = await win.webContents
              .executeJavaScript(
                `(() => {
                  const nodes = Array.from(document.querySelectorAll('button, [role="button"]'));
                  const el = nodes.find((n) => (n.getAttribute('title') || '') === ${JSON.stringify(target)});
                  if (!el) return null;
                  const r = el.getBoundingClientRect();
                  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
                })()`,
                true,
              )
              .catch(() => null);
            if (rect) {
              win.webContents.sendInputEvent({ type: "mouseMove", x: rect.x, y: rect.y });
              await new Promise((r) => setTimeout(r, 900));
              console.log("E2E_HOVER", JSON.stringify({ target, at: rect, windows: BrowserWindow.getAllWindows().length }));
            } else {
              console.log("E2E_HOVER_TARGET_NOT_FOUND", target);
            }
          }

          // E2E：浮层内点击（LOOPSOAR_E2E_POPOVER_CLICK=.chrome-pop-viewmore）→ 验证整页管理界面打开
          if (process.env.LOOPSOAR_E2E_POPOVER_CLICK) {
            const selector = process.env.LOOPSOAR_E2E_POPOVER_CLICK;
            const popWin = BrowserWindow.getAllWindows().find((w) => w !== win);
            if (popWin) {
              const clicked = await popWin.webContents
                .executeJavaScript(
                  `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`,
                  true,
                )
                .catch(() => false);
              await new Promise((r) => setTimeout(r, 900));
              const page = await win.webContents
                .executeJavaScript(
                  `(() => { const el = document.querySelector('.chrome-page'); return el ? (el.textContent || '').slice(0, 80) : null; })()`,
                  true,
                )
                .catch(() => null);
              console.log("E2E_POPOVER_CLICK", JSON.stringify({ clicked, chromePage: page }));
            } else {
              console.log("E2E_POPOVER_CLICK_NO_WINDOW");
            }
          }

          // E2E：浮层独立子窗口验证（LOOPSOAR_E2E_CAPTURE_POPOVER=1）
          if (process.env.LOOPSOAR_E2E_CAPTURE_POPOVER) {
            const others = BrowserWindow.getAllWindows().filter((w) => w !== win);
            console.log(
              "E2E_POPOVER_WINDOWS",
              others.length,
              JSON.stringify(
                others.map((w) => ({ bounds: w.getBounds(), title: w.getTitle(), visible: w.isVisible() })),
              ),
            );
            if (others[0]) {
              await new Promise((r) => setTimeout(r, 500));
              try {
                const popWin = others[0];
                console.log("E2E_POPOVER_URL", popWin.webContents.getURL());
                const info = await popWin.webContents.executeJavaScript(
                  `JSON.stringify({
                    qs: location.search,
                    sheets: document.styleSheets.length,
                    bodyBg: getComputedStyle(document.body).backgroundColor,
                    card: (() => { const el = document.querySelector('.chrome-pop-card'); if (!el) return null; const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); return { bg: cs.backgroundColor, w: r.width, h: r.height, top: r.top, left: r.left, display: cs.display }; })(),
                    shellBg: (() => { const el = document.querySelector('.chrome-pop-shell'); return el ? getComputedStyle(el).backgroundColor : null; })(),
                    rootRect: (() => { const el = document.getElementById('root'); const r = el.getBoundingClientRect(); return { w: r.width, h: r.height }; })(),
                    cardHtml: (() => { const el = document.querySelector('.chrome-pop-card'); return el ? el.outerHTML.slice(0, 240) : null; })(),
                    cardKids: (() => { const el = document.querySelector('.chrome-pop-card'); return el ? el.children.length : null; })(),
                    cssRules: (() => { try { const sheet = document.styleSheets[0]; const rules = sheet ? sheet.cssRules : []; const hits = []; for (const r of rules) if (r.cssText && r.cssText.includes('chrome-pop-card')) hits.push(r.cssText.slice(0, 120)); return { total: rules.length, hits }; } catch (e) { return String(e); } })(),
                    cardStyle: (() => { const el = document.querySelector('.chrome-pop-card'); if (!el) return null; const cs = getComputedStyle(el); return { height: cs.height, minHeight: cs.minHeight, maxHeight: cs.maxHeight, overflow: cs.overflow, position: cs.position, flex: cs.flex }; })(),
                    items: Array.from(document.querySelectorAll('.chrome-pop-item')).slice(0, 6).map((el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return { text: (el.textContent || '').slice(0, 8), h: Math.round(r.height), w: Math.round(r.width), display: cs.display, visible: cs.visibility, color: cs.color }; }),
                    menuRect: (() => { const el = document.querySelector('.chrome-pop-menu'); if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
                  })`,
                  true,
                );
                console.log("E2E_POPOVER_DOM", info);
              } catch (err) {
                console.warn("E2E_POPOVER_DOM_FAILED", err instanceof Error ? err.message : String(err));
              }
              try {
                const img = await others[0].capturePage();
                const popPath = shotPath.replace(/.png$/, "-popover.png");
                fs.writeFileSync(popPath, img.toPNG());
                console.log("POPOVER_SHOT_SAVED", popPath);
              } catch (err) {
                console.warn("POPOVER_SHOT_SKIPPED", err instanceof Error ? err.message : String(err));
              }
            }
          }

          // E2E：只截 Agent 指针覆盖窗口自身（透明背景，不包含用户桌面任何内容）。
          // 为什么不用桌面截图：抓屏会把用户自己的窗口拍进证据图，既不安全也不稳定。
          if (process.env.LOOPSOAR_E2E_POINTER_SHOT) {
            const pointerWin = BrowserWindow.getAllWindows().find((w) => {
              try {
                const url = w.webContents.getURL();
      // 四角遮罩也是 data:text/html；排除它，否则 E2E 拍到的是遮罩而不是指针覆盖层。
      return url.startsWith("data:text/html") && !url.includes("loopsoar-corner");
              } catch {
                return false;
              }
            });
            if (pointerWin) {
              try {
                // 透明指针窗口的 BrowserWindow.capturePage 在 Windows 上也可能永久挂起：加超时，失败不阻断主截图/退出。
                const img = await Promise.race([
                  pointerWin.webContents.capturePage(),
                  new Promise<never>((_, reject) => {
                    setTimeout(() => reject(new Error("pointer capturePage 超时 5000ms")), 5_000);
                  }),
                ]);
                if (!img.isEmpty()) {
                  fs.writeFileSync(process.env.LOOPSOAR_E2E_POINTER_SHOT, img.toPNG());
                  console.log("POINTER_SHOT_SAVED", process.env.LOOPSOAR_E2E_POINTER_SHOT);
                }
              } catch (err) {
                console.warn("POINTER_SHOT_SKIPPED", err instanceof Error ? err.message : String(err));
              }
            }
          }

          // E2E：整屏截图（用于验证独立浮层窗口真实浮在网页之上）
          if (process.env.LOOPSOAR_E2E_DESKTOP_SHOT) {
            const { desktopCapturer } = await import("electron");
            try {
              // 桌面截图拍的是「屏幕最上层」，E2E 窗口必须置顶，否则拍到的是用户自己的浏览器。
              mainWindow?.show();
              mainWindow?.moveTop();
              mainWindow?.focus();
              await new Promise((r) => setTimeout(r, 400));
              const sources = await desktopCapturer.getSources({
                types: ["screen"],
                thumbnailSize: { width: 1920, height: 1200 },
              });
              const img = sources[0]?.thumbnail;
              if (img && !img.isEmpty()) {
                const deskPath = shotPath.replace(/.png$/, "-desktop.png");
                fs.writeFileSync(deskPath, img.toPNG());
                console.log("DESKTOP_SHOT_SAVED", deskPath);
              }
            } catch (err) {
              console.warn("DESKTOP_SHOT_SKIPPED", err instanceof Error ? err.message : String(err));
            }
          }

          // E2E：窗口级合成截图（LOOPSOAR_E2E_WINDOW_SHOT=1）——capturePage 不含原生 WebContentsView，
          // 用 desktopCapturer 抓屏后按窗口矩形裁切，验证网页圆角面板/标签高亮等合成效果（不含桌面其他内容）。
          if (process.env.LOOPSOAR_E2E_WINDOW_SHOT === "1") {
            try {
              // 先置顶：抓屏只能拍到屏幕上真正可见的像素，窗口被别的应用盖住时裁切出来会是别人的内容。
              win.show();
              win.moveTop();
              win.focus();
              await new Promise((r) => setTimeout(r, 350));
              const { desktopCapturer } = await import("electron");
              const winBounds = win.getBounds();
              const display = screen.getDisplayMatching(winBounds);
              const scale = display.scaleFactor;
              const sources = await desktopCapturer.getSources({
                types: ["screen"],
                thumbnailSize: {
                  width: Math.round(display.bounds.width * scale),
                  height: Math.round(display.bounds.height * scale),
                },
              });
              const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
              const img = source?.thumbnail;
              if (img && !img.isEmpty()) {
                const size = img.getSize();
                const crop = {
                  x: Math.max(0, Math.round((winBounds.x - display.bounds.x) * scale)),
                  y: Math.max(0, Math.round((winBounds.y - display.bounds.y) * scale)),
                  width: Math.round(winBounds.width * scale),
                  height: Math.round(winBounds.height * scale),
                };
                crop.width = Math.min(crop.width, size.width - crop.x);
                crop.height = Math.min(crop.height, size.height - crop.y);
                const cropped = img.crop(crop);
                const winPath = shotPath.replace(/\.png$/, "-window.png");
                fs.writeFileSync(winPath, cropped.toPNG());
                console.log("WINDOW_SHOT_SAVED", winPath);
              }
            } catch (err) {
              console.warn("WINDOW_SHOT_SKIPPED", err instanceof Error ? err.message : String(err));
            }
          }

          // E2E：Agent 会话栏独立窗口验证（LOOPSOAR_E2E_CAPTURE_AGENT_WINDOW=1）——
          // 点「小窗化」后应出现第二个系统窗口（URL 带 ?mini=1），窗口内只渲染会话栏。
          if (process.env.LOOPSOAR_E2E_CAPTURE_AGENT_WINDOW) {
            const others = BrowserWindow.getAllWindows().filter((w) => w !== win);
            console.log(
              "E2E_AGENT_WINDOW_WINDOWS",
              others.length,
              JSON.stringify(
                others.map((w) => ({ bounds: w.getBounds(), title: w.getTitle(), visible: w.isVisible() })),
              ),
            );
            console.log(
              "E2E_AGENT_WINDOW_MAIN",
              JSON.stringify({ contentSize: win.getContentSize(), browser: browserHost ? browserHost.debugBounds() : null }),
            );
            const agentWinCandidate = others.find((w) => { try { return w.webContents.getURL().includes("mini=1") && !w.webContents.getURL().includes("icon.html"); } catch { return false; } }) ?? others[0];
            if (agentWinCandidate) {
              const agentWin = agentWinCandidate;
              console.log("E2E_AGENT_FOCUSED", JSON.stringify({ focused: BrowserWindow.getFocusedWindow() === agentWin, visible: agentWin.isVisible() }));
              try {
                console.log("E2E_AGENT_WINDOW_URL", agentWin.webContents.getURL());
                const dom = await agentWin.webContents.executeJavaScript(
                  `JSON.stringify({
                    qs: location.search,
                    mini: document.documentElement.dataset.mini ?? null,
                    sidebar: (() => { const el = document.querySelector('.agent-sidebar'); if (!el) return null; const r = el.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })(),
                    titlebar: !!document.querySelector('.titlebar'),
                    chrome: !!document.querySelector('.browser-chrome'),
                    rootW: Math.round(document.getElementById('root').getBoundingClientRect().width),
                  })`,
                  true,
                );
                console.log("E2E_AGENT_WINDOW_DOM", dom);

                // 小窗内「会话列表」单图标展开列表验证（Vibecoding 同款 SessionListPanel）。
                if (process.env.LOOPSOAR_E2E_AGENT_SESSION_LIST === "1") {
                  const opened = await agentWin.webContents
                    .executeJavaScript(
                      `(() => { const b = document.querySelector("[data-testid=\\\"agent-mini-session-toggle\\\"]"); if (!b) return { found: false }; b.click(); return { found: true, pressed: b.getAttribute("aria-pressed") }; })()`,
                      true,
                    )
                    .catch((err) => ({ error: String(err) }));
                  await new Promise((r) => setTimeout(r, 400));
                  const dom = await agentWin.webContents
                    .executeJavaScript(
                      `JSON.stringify({
                        toggle: !!document.querySelector("[data-testid=\\\"agent-mini-session-toggle\\\"]"),
                        pressed: document.querySelector("[data-testid=\\\"agent-mini-session-toggle\\\"]")?.getAttribute("aria-pressed") ?? null,
                        panel: !!document.querySelector("[data-testid=\\\"session-list-panel\\\"]"),
                        search: !!document.querySelector("[data-testid=\\\"session-search\\\"]"),
                        workspaceChip: document.body.innerText.includes("挂载项目文件夹"),
                        toggleStyle: (() => { const b = document.querySelector("[data-testid=\\\"agent-mini-session-toggle\\\"]"); if (!b) return null; const cs = getComputedStyle(b); const icon = b.querySelector(".icon"); const ics = icon ? getComputedStyle(icon) : null; return { color: cs.color, bg: cs.backgroundColor, border: cs.borderColor, iconBg: ics ? ics.backgroundImage : null, iconW: icon ? icon.getBoundingClientRect().width : null, iconH: icon ? icon.getBoundingClientRect().height : null }; })(),
                        sessionRows: document.querySelectorAll("[data-testid=\\\"session-item-row\\\"]").length,
                      })`,
                      true,
                    )
                    .catch((err) => JSON.stringify({ error: String(err) }));
                  try {
                    fs.writeFileSync(shotPath.replace(/\.png$/, "-session-list.png"), (await agentWin.capturePage()).toPNG());
                  } catch { /* ignore */ }
                  // 再点一次应收起列表、恢复对话与输入区
                  await agentWin.webContents
                    .executeJavaScript(
                      `(() => { const b = document.querySelector("[data-testid=\\\"agent-mini-session-toggle\\\"]"); if (!b) return false; b.click(); return true; })()`,
                      true,
                    )
                    .catch(() => false);
                  await new Promise((r) => setTimeout(r, 350));
                  const closedDom = await agentWin.webContents
                    .executeJavaScript(
                      `JSON.stringify({
                        panel: !!document.querySelector("[data-testid=\\\"session-list-panel\\\"]"),
                        toggle: !!document.querySelector("[data-testid=\\\"agent-mini-session-toggle\\\"]"),
                        pressed: document.querySelector("[data-testid=\\\"agent-mini-session-toggle\\\"]")?.getAttribute("aria-pressed") ?? null,
                        composer: !!document.querySelector("textarea"),
                        workspaceChip: document.body.innerText.includes("挂载项目文件夹"),
                      })`,
                      true,
                    )
                    .catch((err) => JSON.stringify({ error: String(err) }));
                  // 再次打开 → Esc 应收起（全局浮层协调）
                  await agentWin.webContents
                    .executeJavaScript(
                      `(() => { const b = document.querySelector("[data-testid=\\"agent-mini-session-toggle\\"]"); if (!b) return false; b.click(); return true; })()`,
                      true,
                    )
                    .catch(() => false);
                  await new Promise((r) => setTimeout(r, 250));
                  await agentWin.webContents
                    .executeJavaScript(
                      `(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true; })()`,
                      true,
                    )
                    .catch(() => false);
                  await new Promise((r) => setTimeout(r, 250));
                  const escDom = await agentWin.webContents
                    .executeJavaScript(
                      `JSON.stringify({ panel: !!document.querySelector("[data-testid=\\"agent-mini-session-list\\"]"), pressed: document.querySelector("[data-testid=\\"agent-mini-session-toggle\\"]")?.getAttribute("aria-pressed") ?? null, composer: !!document.querySelector("textarea") })`,
                      true,
                    )
                    .catch((err) => JSON.stringify({ error: String(err) }));
                  console.log("E2E_AGENT_SESSION_LIST_ESC", JSON.stringify({ escDom }));
                  console.log("E2E_AGENT_SESSION_LIST_CLOSED", JSON.stringify({ closedDom }));
                  console.log("E2E_AGENT_SESSION_LIST", JSON.stringify({ opened, dom }));
                }
                // 普通态 Agent 窗口标题栏显式拖拽验证：连续 5 次 start/move/move/end，记录尺寸是否漂移。
                if (process.env.LOOPSOAR_E2E_AGENT_WINDOW_DRAG === "1") {
                  const steps: Array<{ x: number; y: number; w: number; h: number }> = [];
                  const pushBounds = (): void => { const b = agentWin.getBounds(); steps.push({ x: b.x, y: b.y, w: b.width, h: b.height }); };
                  pushBounds();
                  for (let i = 0; i < 5; i += 1) {
                    await agentWin.webContents
                      .executeJavaScript(
                        `(() => {
                          const el = document.querySelector("[data-agent-title-drag]");
                          if (!el) return false;
                          const base = 500 + ${i} * 100;
                          el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerId: 21 + ${i}, screenX: base, screenY: 400 }));
                          window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 21 + ${i}, screenX: base + 20, screenY: 415 }));
                          window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 21 + ${i}, screenX: base + 40, screenY: 430 }));
                          window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 21 + ${i}, screenX: base + 40, screenY: 430 }));
                          return true;
                        })()`,
                        true,
                      )
                      .catch(() => false);
                    await new Promise((r) => setTimeout(r, 260));
                    pushBounds();
                  }
                  console.log("E2E_AGENT_WINDOW_DRAG", JSON.stringify({ steps }));
                }
                // 小窗「最小化 = 缩成图标按钮」交互验证：点标题栏最小化 → 变图标 → 点图标还原
                if (process.env.LOOPSOAR_E2E_AGENT_ICON_CYCLE) {
                  await new Promise((r) => setTimeout(r, 900));
                  const before = agentWin.getBounds();
                  // 动画帧率探针：图标窗内 rAF 计数 + 主进程 bounds 采样（诊断掉帧来源）。
                  await agentWin.webContents
                    .executeJavaScript(
                      `(() => {
                        window.__e2eFPS = { n: 0, t0: performance.now(), stamps: [] };
                        const tick = (ts) => {
                          window.__e2eFPS.n += 1;
                          window.__e2eFPS.stamps.push(Math.round(ts));
                          if (performance.now() - window.__e2eFPS.t0 < 900) requestAnimationFrame(tick);
                        };
                        requestAnimationFrame(tick);
                        return true;
                      })()`,
                      true,
                    )
                    .catch(() => false);
                  const clicked = await agentWin.webContents
                    .executeJavaScript(
                      `(() => { const b = Array.from(document.querySelectorAll('.win-btn')).find((x) => (x.getAttribute('aria-label') || '').includes('最小化')); if (!b) return false; b.click(); return true; })()`,
                      true,
                    )
                    .catch(() => false);
                  // 衔接动画证据：逐帧采样 bounds（应严格介于原尺寸与 56 之间）。
                  const samples: Array<{ t: number; w: number; h: number }> = [];
                  const sampleStart = Date.now();
                  let midShotSaved = false;
                  let midDom: string | null = null;
                  while (Date.now() - sampleStart < 320) {
                    const b = agentWin.getBounds();
                    samples.push({ t: Date.now() - sampleStart, w: b.width, h: b.height });
                    const elapsed = Date.now() - sampleStart;
                    if (!midShotSaved && elapsed >= 80) {
                      midShotSaved = true;
                      try {
                        fs.writeFileSync(
                          shotPath.replace(/\.png$/, "-mid.png"),
                          (await agentWin.capturePage()).toPNG(),
                        );
                        midDom = await agentWin.webContents
                          .executeJavaScript(
                            `JSON.stringify({
                              panel: (() => { const el = document.querySelector('[data-agent-panel]'); if (!el) return null; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), transition: cs.transitionDuration }; })(),
                              icon: (() => { const el = document.querySelector('[data-agent-icon]'); return el ? { opacity: getComputedStyle(el).opacity } : null; })(),
                              content: (() => { const el = document.querySelector('[data-agent-panel] > div'); return el ? getComputedStyle(el).opacity : null; })(),
                              win: [innerWidth, innerHeight],
                            })`,
                            true,
                          )
                          .catch(() => null);
                      } catch {
                        midShotSaved = false;
                      }
                    }
                    await new Promise((r) => setTimeout(r, 16));
                  }
                  const midBounds = samples[Math.floor(samples.length / 2)]
                    ? { x: agentWin.getBounds().x, y: agentWin.getBounds().y, width: samples[Math.floor(samples.length / 2)].w, height: samples[Math.floor(samples.length / 2)].h }
                    : agentWin.getBounds();
                  const fpsInfo = await agentWin.webContents
                    .executeJavaScript(
                      `({ frames: window.__e2eFPS ? window.__e2eFPS.n : null, span: window.__e2eFPS ? Math.round(performance.now() - window.__e2eFPS.t0) : null })`,
                      true,
                    )
                    .catch(() => null);
                  await new Promise((r) => setTimeout(r, 180));
                  // 面板过渡 400ms；截图可能阻塞主进程定时器，多等一会儿再取终态。
                  await new Promise((r) => setTimeout(r, 700));
                  const iconBounds = agentWin.getBounds();
                  const iconWindow = BrowserWindow.getAllWindows().find((w) => { try { return w !== win && w !== agentWin && w.webContents.getURL().includes("icon.html"); } catch { return false; } }) ?? null;
                  console.log("E2E_AGENT_ICONWIN", JSON.stringify({ bounds: iconWindow?.getBounds() ?? null, visible: iconWindow?.isVisible() ?? null, url: iconWindow?.webContents.getURL() ?? null }));
                  if (process.env.LOOPSOAR_E2E_AGENT_ICON_WINDOW_DRAG === "1" && iconWindow) {
                    const dragBefore = iconWindow.getBounds();
                    await iconWindow.webContents.executeJavaScript(`(() => {
                      const el = document.getElementById("icon");
                      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerId: 7, screenX: 600, screenY: 400 }));
                      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 7, screenX: 640, screenY: 430 }));
                      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 7, screenX: 680, screenY: 460 }));
                      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 7, screenX: 680, screenY: 460 }));
                      return true;
                    })()`, true).catch(() => false);
                    await new Promise((r) => setTimeout(r, 350));
                    console.log("E2E_AGENT_ICONWIN_DRAG", JSON.stringify({ before: dragBefore, after: iconWindow.getBounds(), visible: iconWindow.isVisible() }));
                  }
                  if (process.env.LOOPSOAR_E2E_AGENT_ICON_WINDOW_CLICK === "1" && iconWindow) {
                    iconWindow.webContents.sendInputEvent({ type: "mouseDown", x: 28, y: 28, button: "left", clickCount: 1 });
                    iconWindow.webContents.sendInputEvent({ type: "mouseUp", x: 28, y: 28, button: "left", clickCount: 1 });
                    await new Promise((r) => setTimeout(r, 900));
                    console.log("E2E_AGENT_ICONWIN_CLICK", JSON.stringify({ iconMode: agentWindow?.isIconMode() ?? null, agentVisible: agentWin.isVisible(), iconVisible: iconWindow.isVisible() }));
                  }
                  const iconDom = await agentWin.webContents
                    .executeJavaScript(
                      `JSON.stringify({ icon: !!document.querySelector('[data-agent-icon]'), logo: !!document.querySelector('[data-agent-icon] img'), innerButton: !!document.querySelector('[data-agent-icon] button'), transparent: getComputedStyle(document.documentElement).backgroundColor, radius: (() => { const el = document.querySelector('[data-agent-icon]'); if (!el) return null; const cs = getComputedStyle(el); return { r: cs.borderRadius, bg: cs.backgroundColor, border: cs.borderWidth }; })(), w: innerWidth, h: innerHeight })`,
                      true,
                    )
                    .catch(() => null);
                  console.log("E2E_AGENT_ICON", JSON.stringify({ clicked, before, midBounds, iconBounds, fpsInfo, midDom, samples, iconDom }));
                  if (process.env.LOOPSOAR_E2E_AGENT_DESKTOP === "1") {
                    try {
                      const { desktopCapturer } = await import("electron");
                      const display = screen.getDisplayMatching(agentWin.getBounds());
                      const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: Math.round(display.bounds.width * display.scaleFactor), height: Math.round(display.bounds.height * display.scaleFactor) } });
                      const src = sources.find((x) => x.display_id === String(display.id)) ?? sources[0];
                      if (src?.thumbnail && !src.thumbnail.isEmpty()) {
                        const deskPath = shotPath.replace(/\.png$/, "-agent-desktop.png");
                        fs.writeFileSync(deskPath, src.thumbnail.toPNG());
                        console.log("AGENT_DESKTOP_SHOT", deskPath);
                      }
                    } catch (err) { console.warn("AGENT_DESKTOP_SHOT_FAILED", err instanceof Error ? err.message : String(err)); }
                  }
                  try {
                    const iconShot = shotPath.replace(/\.png$/, "-icon.png");
                    fs.writeFileSync(iconShot, (await agentWin.capturePage()).toPNG());
                    console.log("E2E_AGENT_ICON_SHOT", iconShot);
                  } catch (err) {
                    console.warn("E2E_AGENT_ICON_SHOT_FAILED", err instanceof Error ? err.message : String(err));
                  }
                  // 拖动验证：合成 pointer 序列（screen 坐标增量 30/30）→ 窗口应移位且图标仍在
                  const dragDone = await agentWin.webContents
                    .executeJavaScript(
                      `(() => {
                        const el = document.querySelector('[data-agent-icon]');
                        if (!el) return false;
                        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 1, screenX: 600, screenY: 400 }));
                        window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, screenX: 640, screenY: 430 }));
                        window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, screenX: 675, screenY: 455 }));
                        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, screenX: 675, screenY: 455 }));
                        return true;
                      })()`,
                      true,
                    )
                    .catch(() => false);
                  await new Promise((r) => setTimeout(r, 350));
                  const draggedBounds = agentWin.getBounds();
                  const stillIcon = await agentWin.webContents
                    .executeJavaScript(`!!document.querySelector('[data-agent-icon]')`, true)
                    .catch(() => false);
                  console.log("E2E_AGENT_ICON_DRAG", JSON.stringify({ dragDone, iconBounds, draggedBounds, stillIcon }));
                  // 单击还原：pointerdown + pointerup（无位移）→ 触发 restore 动画
                  const restoreClicked = await agentWin.webContents
                    .executeJavaScript(
                      `(() => {
                        const el = document.querySelector('[data-agent-icon]');
                        if (!el) return false;
                        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 2, screenX: 700, screenY: 500 }));
                        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 2, screenX: 700, screenY: 500 }));
                        return true;
                      })()`,
                      true,
                    )
                    .catch(() => false);
                  await new Promise((r) => setTimeout(r, 90));
                  try {
                    fs.writeFileSync(
                      shotPath.replace(/\.png$/, "-restore-mid.png"),
                      (await agentWin.capturePage()).toPNG(),
                    );
                    const restoreDom = await agentWin.webContents
                      .executeJavaScript(
                        `JSON.stringify({
                          panel: (() => { const el = document.querySelector('[data-agent-panel]'); if (!el) return null; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), transition: cs.transitionDuration }; })(),
                          icon: (() => { const el = document.querySelector('[data-agent-icon]'); return el ? { opacity: getComputedStyle(el).opacity } : null; })(),
                          content: (() => { const el = document.querySelector('[data-agent-panel] > div'); return el ? getComputedStyle(el).opacity : null; })(),
                          win: [innerWidth, innerHeight],
                        })`,
                        true,
                      )
                      .catch(() => null);
                    console.log("E2E_AGENT_ICON_RESTORE_MID", restoreDom);
                  } catch {
                    // 还原中途截图失败不影响断言
                  }
                  await new Promise((r) => setTimeout(r, 420));
                  await new Promise((r) => setTimeout(r, 700));
                  console.log(
                    "E2E_AGENT_ICON_RESTORED",
                    JSON.stringify({ clicked: restoreClicked, bounds: agentWin.getBounds() }),
                  );                }
                const img = await agentWin.capturePage();
                const agentPath = shotPath.replace(/\.png$/, "-agent-window.png");
                fs.writeFileSync(agentPath, img.toPNG());
                console.log("AGENT_WINDOW_SHOT_SAVED", agentPath);
                // 铺满证据：主窗口整窗截图（DOM 层；原生视图不入 capturePage，宽度以 debugBounds 为准）
                if (process.env.LOOPSOAR_E2E_CLOSE_AGENT_WINDOW) {
                  fs.writeFileSync(shotPath.replace(/.png$/, "-main-fullwidth.png"), (await win.capturePage()).toPNG());
                  agentWin.close();
                  await new Promise((r) => setTimeout(r, 1500));
                  const restored = await win.webContents
                    .executeJavaScript(
                      `(() => { const side = document.querySelector(".agent-sidebar"); const wrap = side ? side.parentElement : null; return JSON.stringify({ display: wrap ? getComputedStyle(wrap).display : null, splitter: !!document.querySelector("[title=\\"拖动调整面板宽度\\"]") }); })()`,
                      true,
                    )
                    .catch(() => null);
                  console.log(
                    "E2E_AGENT_WINDOW_RESTORED",
                    JSON.stringify({ restored, browser: browserHost ? browserHost.debugBounds() : null }),
                  );
                }
              } catch (err) {
                console.warn("AGENT_WINDOW_CAPTURE_FAILED", err instanceof Error ? err.message : String(err));
              }
            }
          }

          // 整窗截图：用 webContents.capturePage（BrowserWindow.capturePage 在带 WebContentsView 的 Windows 会话里会卡死）。
          // 合成层仍可能挂起：加 5s 超时，超时走 catch → finally app.quit()；浏览器子视图另拍。
          const capture = win.webContents.capturePage();
          const image = await Promise.race([
            capture,
            new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error("capturePage 超时 5000ms")), 5_000);
            }),
          ]);
          fs.mkdirSync(path.dirname(shotPath), { recursive: true });
          fs.writeFileSync(shotPath, image.toPNG());
          console.log(`GUI_SHOT_SAVED ${shotPath}`);

          // 原生浏览器视图单独截图（Electron 的窗口截图不含子视图；受限会话下可能拿不到合成层，失败不中断）
          if (navUrl && browserHost) {
            try {
              const base64 = await Promise.race([
                browserHost.screenshot(),
                new Promise<never>((_, reject) => {
                  setTimeout(() => reject(new Error("browserHost.screenshot 超时 5000ms")), 5_000);
                }),
              ]);
              if (base64) {
                const viewShot = shotPath.replace(/\.png$/, "-browser-view.png");
                fs.writeFileSync(viewShot, Buffer.from(base64, "base64"));
                console.log(`BROWSER_VIEW_SHOT_SAVED ${viewShot}`);
              }
            } catch (err) {
              console.warn("BROWSER_VIEW_SHOT_SKIPPED", err instanceof Error ? err.message : String(err));
            }
          }
          // 保持窗口可见一段时间（供外部屏幕抓图/人工观察）
          const holdMs = Number(process.env.LOOPSOAR_E2E_HOLD_MS ?? "0");
          if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
        } catch (err) {
          console.error("GUI_SHOT_FAILED", err);
        } finally {
          app.quit();
        }
      })();
    }, 600);
  });
}

/** E2E 演示钩子（仅验收用）：向渲染层注入一段假流式事件，用于截图验证动画/光标。 */
function scheduleE2EDemoChat(win: BrowserWindow): void {
  if (!process.env.LOOPSOAR_E2E_DEMO_CHAT) return;
  win.webContents.once("did-finish-load", () => {
    setTimeout(() => {
      const chunks = ["Loopsoar 正在", "以真实引擎", "流式回复：", "这一行演示", "逐单元渐入", "与光标闪烁。"];
      chunks.forEach((chunk, index) => {
        setTimeout(() => {
          pushToRenderer("chat:stream:chunk", { sessionId: "e2e-demo", content: chunk });
        }, index * 150);
      });
      setTimeout(() => {
        pushToRenderer("chat:stream:heartbeat", { sessionId: "e2e-demo" });
      }, 1000);
    }, 250);
  });
}

/**
 * E2E：把鼠标移到收起态侧栏的会话按钮上，验证 hover 反馈（仅显式环境变量启用）。
 * 为什么必须走 sendInputEvent：CSS :hover 不响应 DOM 合成事件，只有真实鼠标输入才触发。
 */
function scheduleE2ESidebarRailHover(win: BrowserWindow): void {
  if (!process.env.LOOPSOAR_E2E_HOVER_SIDEBAR_RAIL) return;
  win.webContents.once("did-finish-load", () => {
    const startedAt = Date.now();
    const poll = (): void => {
      void win.webContents
        .executeJavaScript(
          `(() => {
            const item = document.querySelector('[data-testid="rail-session"]');
            if (!item) return null;
            const box = item.getBoundingClientRect();
            if (box.width <= 0 || box.height <= 0) return null;
            return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
          })()`,
        )
        .then((pos: { x: number; y: number } | null) => {
          if (!pos) {
            if (Date.now() - startedAt < 12000) setTimeout(poll, 400);
            else console.log("[E2E] SIDEBAR_RAIL_HOVER no-item");
            return;
          }
          win.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(pos.x), y: Math.round(pos.y) });
          setTimeout(() => {
            void win.webContents
              .executeJavaScript(
                `(() => {
                  const item = document.querySelector('[data-testid="rail-session"]');
                  if (!item) return null;
                  const cs = getComputedStyle(item);
                  return { hovered: item.matches(':hover'), bg: cs.backgroundColor, color: cs.color };
                })()`,
              )
              .then((m: unknown) => console.log("[E2E] SIDEBAR_RAIL_HOVER", JSON.stringify(m)));
          }, 350);
        });
    };
    setTimeout(poll, 800);
  });
}

/** E2E：把鼠标移到卷轴上，验证悬停气泡/高亮（仅显式环境变量启用）。 */
function scheduleE2ERailHover(win: BrowserWindow): void {
  if (!process.env.LOOPSOAR_E2E_HOVER_RAIL) return;
  win.webContents.once("did-finish-load", () => {
    setTimeout(() => {
      void win.webContents
        .executeJavaScript(
          `(() => {
            const rail = document.querySelector('.topic-rail');
            if (!rail) return null;
            const r = rail.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height * 0.45 };
          })()`,
        )
        .then((pos: { x: number; y: number } | null) => {
          if (!pos) {
            console.log("[E2E] RAIL_HOVER no-rail");
            return;
          }
          // 走真实 Chromium 输入管线（sendInputEvent），避免 DOM 合成事件与真机鼠标行为不一致
          win.webContents.sendInputEvent({
            type: "mouseMove",
            x: Math.round(pos.x),
            y: Math.round(pos.y),
          });
          console.log(`[E2E] RAIL_HOVER moved ${JSON.stringify(pos)}`);
          // E2E 两步悬停（LOOPSOAR_E2E_HOVER_RAIL=2）：先离开轨道，再在另一个高度重新进入，
          // 用来验证「下一次悬停的突起直接出现在当前指针位置」而不是从旧位置滑过来。
          if (process.env.LOOPSOAR_E2E_HOVER_RAIL === "2") {
            const moveTo = (x: number, y: number): void => {
              win.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(x), y: Math.round(y) });
            };
            setTimeout(() => {
              // 1) 移到轨道左侧正文区（离开轨道触发 pointerleave，突起开始收回）
              moveTo(pos.x - 80, pos.y);
              console.log("[E2E] RAIL_HOVER leave");
              setTimeout(() => {
                void win.webContents
                  .executeJavaScript(
                    `(() => {
                      const rail = document.querySelector('.topic-rail');
                      if (!rail) return null;
                      const r = rail.getBoundingClientRect();
                      return { x: r.left + r.width / 2, y: r.top + r.height * 0.75 };
                    })()`,
                  )
                  .then((pos2: { x: number; y: number } | null) => {
                    if (!pos2) return;
                    // 2) 在 75% 高度重新进入：新突起必须直接出现在 75% 处
                    moveTo(pos2.x, pos2.y);
                    console.log(`[E2E] RAIL_HOVER reenter ${JSON.stringify(pos2)}`);
                  })
                  .catch((err) => console.log(`[E2E] RAIL_HOVER reenter failed: ${String(err)}`));
              }, 400);
            }, 500);
          }
          // 400ms 后回读 hover 卡片状态，确认「悬停卡片」在真实鼠标路径下也可见。
          setTimeout(() => {
            void win.webContents
              .executeJavaScript(
                `(() => {
                  const tip = document.querySelector('.topic-rail-tip');
                  const rail = document.querySelector('.topic-rail');
                  if (!tip || !rail) return null;
                  const tr = tip.getBoundingClientRect();
                  const rr = rail.getBoundingClientRect();
                  const cs = getComputedStyle(tip);
                  return {
                    cls: tip.className,
                    display: cs.display,
                    opacity: cs.opacity,
                    tipRect: [Math.round(tr.x), Math.round(tr.y), Math.round(tr.width), Math.round(tr.height)],
                    railRect: [Math.round(rr.x), Math.round(rr.y), Math.round(rr.width), Math.round(rr.height)],
                    text: tip.textContent,
                  };
                })()`,
              )
              .then((tip) => console.log(`[E2E] RAIL_TIP ${JSON.stringify(tip)}`))
              .catch((err) => console.log(`[E2E] RAIL_TIP failed: ${String(err)}`));
          }, 400);
        })
        .catch((err) => console.log(`[E2E] RAIL_HOVER failed: ${String(err)}`));
    }, 1200);
  });
}

/** E2E：演示工具「执行中」呼吸状态（只发 tool_start，不发结果；仅显式环境变量启用）。 */
function scheduleE2ELiveTool(win: BrowserWindow): void {
  if (!process.env.LOOPSOAR_E2E_LIVE_TOOL) return;
  win.webContents.once("did-finish-load", () => {
    const push = (channel: string, payload: unknown): void => pushToRenderer(channel, payload);
    setTimeout(() => push("chat:stream:chunk", { content: "先读取页面，再整理结论。" }), 700);
    setTimeout(() => push("chat:stream:reasoning", { content: "当前页面可能还没打开，我先调用浏览器快照工具。" }), 950);
    setTimeout(
      () =>
        push("chat:stream:tool_start", {
          content: JSON.stringify({ toolCallId: "call-e2e-live", toolName: "browser_snapshot", args: { maxChars: 4000 } }),
        }),
      1200,
    );
  });
}

/** E2E：演示计划卡 + 上下文环（合成 chat 事件，仅显式环境变量启用）。 */
function scheduleE2EPlanDemo(win: BrowserWindow): void {
  if (!process.env.LOOPSOAR_E2E_PLAN) return;
  win.webContents.once("did-finish-load", () => {
    const push = (channel: string, payload: unknown): void => pushToRenderer(channel, payload);
    setTimeout(() => {
      push("chat:stream:chunk", { content: "我先拆解一下任务，再逐步执行。" });
    }, 900);
    setTimeout(() => {
      push("chat:stream:tool", {
        content: JSON.stringify({
          toolName: "todo_write",
          args: {
            steps: [
              { content: "读取当前页面正文", status: "done" },
              { content: "提取三个关键结论", status: "in_progress" },
              { content: "整理成表格并复制", status: "pending" },
            ],
          },
          result: { ok: true },
        }),
      });
    }, 1200);
    setTimeout(() => {
      // TODO_UPDATE：计划推进（触发「已完成 / 开始」播报）
      push("chat:stream:tool", {
        content: JSON.stringify({
          toolName: "todo_write",
          args: {
            steps: [
              { content: "读取当前页面正文", status: "done" },
              { content: "提取三个关键结论", status: "done" },
              { content: "整理成表格并复制", status: "in_progress" },
            ],
          },
          result: { ok: true },
        }),
      });
    }, 1600);
    setTimeout(() => {
      push("chat:stream:chunk", { content: "正文已读取，正在提炼结论……" });
    }, 1900);
    setTimeout(() => {
      push("chat:stream:done", {
        content: JSON.stringify({ status: "done", reason: "E2E 计划演示", usage: { rounds: 1, toolCalls: 1, totalTokens: 128 } }),
      });
    }, 2600);
  });
}

/** E2E：运行中注入转向提示（验证转向卡与 steer 通道）。 */
function scheduleE2ESteerDemo(win: BrowserWindow): void {
  if (!process.env.LOOPSOAR_E2E_STEER) return;
  win.webContents.once("did-finish-load", () => {
    setTimeout(() => {
      void win.webContents
        .executeJavaScript(
          `(() => {
            const ta = document.querySelector('textarea');
            const sendBtn = document.querySelector('.send-btn');
            if (!ta || !sendBtn) return 'missing-ui';
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
            setter.call(ta, '换个方向：先给结论，再列证据。');
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            setTimeout(() => sendBtn.click(), 60);
            return 'steer-sent';
          })()`,
        )
        .then((r) => console.log(`[E2E] STEER ${r}`))
        .catch((err) => console.log(`[E2E] STEER failed: ${String(err)}`));
    }, 1200);
  });
}

/** E2E：地址栏搜索（验证 omnibox 搜索路径）。 */
function scheduleE2ESearchDemo(win: BrowserWindow): void {
  const query = process.env.LOOPSOAR_E2E_SEARCH;
  if (!query) return;
  win.webContents.once("did-finish-load", () => {
    setTimeout(() => {
      void win.webContents
        .executeJavaScript(
          `(() => {
            const input = document.querySelector('input');
            if (!input) return 'no-input';
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            setter.call(input, ${JSON.stringify(query)});
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            return 'search-sent';
          })()`,
        )
        .then((r) => console.log(`[E2E] SEARCH ${r}`))
        .catch((err) => console.log(`[E2E] SEARCH failed: ${String(err)}`));
    }, 900);
  });
}

/**
 * E2E：等「敏感确认弹窗」出现 → 截主窗口 → 落盘。
 *
 * 为什么单独一个钩子：截图时机必须由 DOM 决定（弹窗要等模型跑完几轮工具才出现），
 * 用固定 HOLD_MS 只会拍到弹窗出现前、或用户已经点掉之后的帧，证据不可复现。
 */
function scheduleE2EConfirmShot(win: BrowserWindow): void {
  const shotPath = process.env.LOOPSOAR_E2E_CONFIRM_SHOT;
  if (!shotPath) return;
  const waitMs = Number(process.env.LOOPSOAR_E2E_CONFIRM_WAIT_MS ?? 60_000);
  win.webContents.once("did-finish-load", () => {
    void (async () => {
      const deadline = Date.now() + waitMs;
      let seen = false;
      while (Date.now() < deadline) {
        seen = await win.webContents
          .executeJavaScript(`Boolean(document.querySelector('[data-kind="sensitive"]'))`, true)
          .catch(() => false);
        if (seen) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!seen) {
        console.log("CONFIRM_SHOT_SKIPPED 未在超时内看到敏感确认弹窗");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 400)); // 动画落定
      try {
        const image = await win.webContents.capturePage();
        fs.writeFileSync(shotPath, image.toPNG());
        console.log("CONFIRM_SHOT_SAVED", shotPath);
      } catch (err) {
        console.log("CONFIRM_SHOT_FAILED", err instanceof Error ? err.message : String(err));
      }
    })();
  });
}

function createMainWindow(): void {
  const appIcon = iconPath();
  if (appIcon) console.log(`[Loopsoar] appIcon=${appIcon}`);
  else console.warn("[Loopsoar] appIcon not found — Electron 默认图标兜底");
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    title: APP_NAME,
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
      preload: preloadPath(),
      additionalArguments: [
        `--loopsoar-bindings=${JSON.stringify(buildBindings())}`,
        `--loopsoar-events=${JSON.stringify(EVENTS)}`,
      ],
    },
  });
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    bootTrace.mark("window-ready-to-show");
    // 首帧已出：此时才启动会 spawn 子进程/同步落盘的非关键任务，避免与渲染抢资源。
    deferredBootTasks?.();
  });
  // 首帧渲染完成（UI 已可交互）：启动计时的最后一条锚点
  mainWindow.webContents.once("did-finish-load", () => bootTrace.mark("window-did-finish-load"));
  // 诊断钩子：preload 失败/渲染报错/加载失败必须在主进程日志可见，否则只能盲猜
  mainWindow.webContents.on("preload-error", (_e, preloadPath, error) => {
    console.error("PRELOAD_ERROR", preloadPath, error);
  });
  mainWindow.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) console.log(`RENDERER[${level}] ${message}`);
  });
  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error("DID_FAIL_LOAD", code, desc, url);
  });
  // 窗口几何变化 → 原生浏览器视图重新对齐（几何来源：contracts/layout）。
  // 为什么要 50ms 防抖 + 监听全部事件：拖拽缩放会连发 resize；maximize/unmaximize 在部分平台
  // 先发「中间尺寸」的 resize 再定格；全屏切换甚至可能不伴随 resize —— 只挂 resize 会让
  // WebContentsView 停在旧 bounds，表现就是「窗口变大了但网页没跟着自适应」。
  const scheduleBoundsSync = createDebouncedRunner(() => browserHost?.syncBounds(), 50);
  // Agent 独立窗口贴在主窗口右缘：主窗口移动/缩放时必须跟着走，否则会「留在原地」变成位置反逻辑。
  // 16ms 防抖 ≈ 一帧：跟手，但不用每个 move 事件都 setBounds。
  const scheduleAgentWindowFollow = createDebouncedRunner(() => agentWindow?.reposition(), 16);
  const syncWindowGeometry = (): void => {
    scheduleBoundsSync.schedule();
    scheduleAgentWindowFollow.schedule();
    // 窗口移动时视图矩形（内容坐标）不变，但屏幕原点变了：覆盖层必须跟着挪。
    schedulePointerAreaSync.schedule();
  };
  mainWindow.on("move", syncWindowGeometry);
  mainWindow.on("resize", syncWindowGeometry);
  mainWindow.on("maximize", syncWindowGeometry);
  mainWindow.on("unmaximize", syncWindowGeometry);
  mainWindow.on("restore", syncWindowGeometry);
  mainWindow.on("enter-full-screen", syncWindowGeometry);
  mainWindow.on("leave-full-screen", syncWindowGeometry);
  mainWindow.on("closed", () => {
    scheduleBoundsSync.cancel();
    scheduleAgentWindowFollow.cancel();
    schedulePointerAreaSync.cancel();
    // 独立 Agent 窗口若常驻，主窗口关掉后 window-all-closed 不会触发，进程会残留成“只有小窗”
    // 主窗口销毁场景不需要滑出动画（目标屏幕/工作区可能已不可用），立即关闭。
    agentWindow?.close({ animate: false });
    devToolsPanel?.dispose();
    mainWindow = null;
  });

  const devUrl = process.env.LOOPSOAR_DEV_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    // E2E 直达：LOOPSOAR_E2E_OPEN=settings 时带 query 打开并自动展开设置面板
    const e2eOpen = process.env.LOOPSOAR_E2E_OPEN;
    const chatText = process.env.LOOPSOAR_E2E_CHAT_TEXT;
    const query = `${e2eOpen ? `?e2e=${e2eOpen}` : "?"}${chatText ? `&chatText=${encodeURIComponent(chatText)}` : ""}`;
    void mainWindow.loadURL(`${PROTOCOL}://app/index.html${query}`);
  }
  scheduleE2EScreenshot(mainWindow);
  scheduleE2ERailHover(mainWindow);
  scheduleE2ESidebarRailHover(mainWindow);
  scheduleE2ELiveTool(mainWindow);
  scheduleE2EPlanDemo(mainWindow);
  scheduleE2ESteerDemo(mainWindow);
  scheduleE2ESearchDemo(mainWindow);
  scheduleE2EDemoChat(mainWindow);
  scheduleE2EConfirmShot(mainWindow);
}

/** 打开文件夹：Windows 直接拉起 explorer.exe（shell.openPath 在部分环境会弹「无法访问」错误）。 */
async function openDirectoryNative(dir: string): Promise<string> {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // 已存在/权限问题交给后续检查
  }
  if (!fs.existsSync(dir)) return `目录不存在：${dir}`;
  if (process.platform === "win32") {
    try {
      const child = spawn("explorer.exe", [dir], { detached: true, stdio: "ignore" });
      child.unref();
      return "";
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
  return (await shell.openPath(dir)) || "";
}

/**
 * 解析可写数据根：优先显式覆盖 → 品牌 userData → 工作区本地目录 → 临时目录。
 * 为什么做降级链：受限会话/只读盘上 %APPDATA% 可能不可写，宁可换目录也不能启动即挂。
 */
function ensureWritableDataDirs(): ReturnType<typeof ensureLoopsoarDirs> {
  const candidates = [
    process.env.LOOPSOAR_DATA_DIR,
    app.getPath("userData"),
    path.join(process.cwd(), ".loopsoar-data"),
    path.join(os.tmpdir(), `loopsoar-${process.pid}`),
  ].filter((c): c is string => typeof c === "string" && c.length > 0);

  let lastErr: unknown = new Error("无可写数据目录");
  for (const root of candidates) {
    try {
      const dirs = ensureLoopsoarDirs(root);
      app.setPath("userData", root);
      return dirs;
    } catch (err) {
      if (process.env.LOOPSOAR_E2E_SECRET_DUMP) {
        console.log(`[E2E] dataDir candidate failed: ${root} → ${err instanceof Error ? err.message : String(err)}`);
      }
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// Chromium 原生 UI（DevTools / 右键菜单 / 部分系统对话框）的语言跟随 Loopsoar 设置；
// --lang 必须在 app ready 之前设置，运行时切换语言会在下次启动生效。
try {
  const preDirs = ensureWritableDataDirs();
  const language = loadPreferences(preDirs.configDir).language;
  app.commandLine.appendSwitch("lang", language);
  // Windows 原生遮挡检测会把「被其它窗口盖住」的网页标记为 hidden，Chromium 随即丢弃注入的
  // 输入事件（Agent 点击/按键会静默失效）。浏览器自动化要求网页在后台仍可交互，关掉该特性。
  // 只影响本应用的页面可见性判定，不改变用户看到的窗口行为。
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
} catch (err) {
  console.warn("[Loopsoar] 设置 Chromium 语言失败", err instanceof Error ? err.message : String(err));
}

app.whenReady().then(async () => {
  bootTrace.mark("whenReady");
  try {
    const dirs = ensureWritableDataDirs();
  // 崩溃取证：原生 AV 进程直接退出，JS 抓不到；先把可捕获的进程/渲染器死亡与未处理异常写盘，
  // 用户下次复现时我们才有 renderer/child-process 的 exitCode/reason，而不是只有一张报错弹窗。
  const crashLogPath = path.join(dirs.dataDir, "crash.log");
  const writeCrashLog = (kind: string, detail: unknown): void => {
    try {
      fs.appendFileSync(crashLogPath, `${new Date().toISOString()} ${kind} ${JSON.stringify(detail)}\n`);
    } catch {
      // 日志写不进去不阻断启动
    }
    console.error("[Loopsoar]", kind, detail);
  };
  process.on("uncaughtException", (err) => writeCrashLog("uncaughtException", { message: err.message, stack: err.stack }));
  process.on("unhandledRejection", (reason) => writeCrashLog("unhandledRejection", reason instanceof Error ? { message: reason.message, stack: reason.stack } : reason));
  app.on("child-process-gone", (_event, details) => writeCrashLog("child-process-gone", details));
  app.on("web-contents-created", (_event, contents) => {
    contents.on("render-process-gone", (_evt, details) => {
      let url = "";
      try {
        url = contents.getURL();
      } catch {
        // 已销毁
      }
      writeCrashLog("render-process-gone", { url, ...details });
    });
  });
  // 审计落盘：<dataDir>/logs/audit-YYYYMMDD.jsonl（重启可查；失败不影响主流程）
  auditFile = new AuditFileLogger({ dir: path.join(dirs.dataDir, "logs") });
  bootTrace.mark("data-dirs");

  // 协议：服务真实 UI 产物；产物缺失时降级为可读提示页（不白屏）
  const uiDist = resolveUiDistDir(uiDistCandidates(__dirname, process.cwd()));
  if (uiDist) {
    protocol.handle(PROTOCOL, makeUiProtocolHandler(uiDist));
  } else {
    console.warn("[Loopsoar] 未找到 ui/dist（先运行 pnpm --filter loopsoar-ui build），使用占位页");
    protocol.handle(PROTOCOL, makePlaceholderProtocolHandler());
  }
  bootTrace.mark("protocol+ui-dist");

  // 装配：platform / 工具注册表 / 沙箱 / Provider 配置 → ChatService（真 LLM 闭环）
  const platform = createNodePlatform();
  const registry = new ToolRegistry();
  registerBuiltinMinimal(registry, platform);
  const sandbox = new SandboxManager();
  sandbox.setWorkspaceRoot(process.cwd());
  sandbox.syncKnownTools(registry.list().map((t) => t.name));

  // 偏好（工作区根 / 记忆库位置 / 自动记忆开关）→ 决定后续装配
  const initialPrefs = loadPreferences(dirs.configDir);
  let workspaceRoot = initialPrefs.workspaceRoot?.trim() || process.cwd();
  sandbox.setWorkspaceRoot(workspaceRoot);

  // 加密密钥库：OS 密钥库优先；不可用时降级 AES（.secret.key 0600）。
  // 注意：必须在 ProviderStore 之前创建 —— 供应商去重合并时要靠它迁移密钥（见下方 callback）。
  const secrets = new SecretStore(dirs.configDir, {
    available: safeStorage.isEncryptionAvailable(),
    encrypt: (plain: string) => safeStorage.encryptString(plain),
    decrypt: (buf: Buffer) => safeStorage.decryptString(buf),
  });
  // 降级备用后端：总是启用并与 OS 密文双写 —— 无论下次启动 safeStorage 是否可用都能解密
  // （此前单后端方案在「os 写入 → 下次不可用」或反方向切换时会读不出，表现为重启后要重填密钥）。
  secrets.setFallbackBackend(path.join(dirs.configDir, ".secret.key"));
  const secretFileMode = secrets.fileMode();
  if (!safeStorage.isEncryptionAvailable() || secretFileMode === "degraded") {
    secrets.useDegradedBackend(path.join(dirs.configDir, ".secret.key"));
  }
  /**
   * 供应商去重合并时迁移密钥（2026-11-10 用户报障「切换 Key 不生效/上游说无订阅」根因）：
   * dedupe 只保留首条 id，副本 id 上的新 Key 若不迁移就会成孤儿，聊天继续用旧 Key。
   * 规则：副本 Key 比保留 id 的更新（updatedAt 更晚）才覆盖，避免把用户刚选的 Key 换回旧值。
   */
  const migrateAliasedSecrets = (aliases: Map<string, string>): void => {
    for (const [from, to] of aliases) {
      if (from === to) continue;
      const incoming = secrets.meta(from);
      if (!incoming) continue;
      const current = secrets.meta(to);
      if (current && current.updatedAt >= incoming.updatedAt) continue;
      const key = secrets.get(from);
      if (!key) continue;
      secrets.set(to, key);
      console.log(`[Loopsoar] secret migrated ${from} → ${to} (${incoming.hint})`);
    }
  };
  // 多供应商：providers.json（兼容旧 provider.json 自动迁移）
  const providers = new ProviderStore(dirs.configDir, { onAliases: migrateAliasedSecrets });
  const legacyProvider = await loadProviderConfig(platform, dirs.configDir);
  if (providers.list().length === 0 && legacyProvider) {
    const item = providers.upsert(legacyProvider);
    providers.setActive(item.id);
  }
  /**
   * 兜底修复「历史已被合并掉的副本密钥」（如 opencode-go-2，文件里已无 alias 可依）：
   * 按「保留 id-数字」后缀归并；同样只在副本 Key 更新时迁移。
   */
  const reconcileOrphanSecrets = (): void => {
    const items = providers.list();
    const known = new Set(items.map((i) => i.id));
    for (const orphanId of secrets.ids()) {
      if (known.has(orphanId)) continue;
      const match = items.find(
        (item) => orphanId.startsWith(`${item.id}-`) && /^\d+$/.test(orphanId.slice(item.id.length + 1)),
      );
      if (!match) continue;
      const incoming = secrets.meta(orphanId);
      if (!incoming) continue;
      const current = secrets.meta(match.id);
      if (current && current.updatedAt >= incoming.updatedAt) continue;
      const key = secrets.get(orphanId);
      if (!key) continue;
      secrets.set(match.id, key);
      console.log(`[Loopsoar] secret reconciled ${orphanId} → ${match.id} (${incoming.hint})`);
    }
  };
  reconcileOrphanSecrets();
  console.log(
    `[Loopsoar] dataDir=${dirs.dataDir} secrets=${secrets.storageMode()} fileMode=${secretFileMode ?? "none"} osAvailable=${safeStorage.isEncryptionAvailable()}`,
  );
  bootTrace.mark("core-assembly");
  // 开发/E2E 密钥持久化验证钩子（仅显式环境变量启用；不打印明文）
  if (process.env.LOOPSOAR_E2E_SECRET_SET) {
    const [pidRaw, key] = process.env.LOOPSOAR_E2E_SECRET_SET.split("|");
    const pid = pidRaw && pidRaw !== "active" ? pidRaw : (providers.active()?.id ?? "e2e");
    try {
      secrets.set(pid, key ?? "");
      console.log(`[E2E] SECRET_SET ok provider=${pid} mode=${secrets.storageMode()}`);
    } catch (err) {
      console.log(`[E2E] SECRET_SET failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (process.env.LOOPSOAR_E2E_SECRET_DUMP) {
    const active = providers.active();
    console.log(
      `[E2E] SECRET_DUMP ${JSON.stringify({
        dataDir: dirs.dataDir,
        storageMode: secrets.storageMode(),
        fileMode: secrets.fileMode(),
        active: active?.id ?? null,
        has: active ? secrets.has(active.id) : false,
        decrypt: active ? (secrets.get(active.id) ? "ok" : "fail") : null,
      })}`,
    );
  }
  const resolveProviderKey = (providerId?: string): string => {
    const stored = providerId ? (secrets.get(providerId) ?? "") : "";
    return stored || resolveApiKeyFromEnv(process.env);
  };
  type ProviderEntry = ReturnType<ProviderStore["list"]>[number];
  /** 单个供应商 → LLM 客户端（请求头模板按 sessionId 渲染；缺 key 返回 undefined）。 */
  const buildLlmForProvider = (item: ProviderEntry, sessionId?: string): LlmClient | undefined => {
    const key = resolveProviderKey(item.id);
    if (!key) return undefined;
    // 请求头模板（{{sessionId}} / {{model}} / {{requestId}} …）：按请求渲染，
    // 让 x-opencode-session 这类"每会话/每请求"限制无需为每个供应商写死。
    const effectiveHeaders = withProviderDefaults(item.provider, item.baseUrl, item.headers);
    const resolveHeaders =
      Object.keys(effectiveHeaders).length > 0
        ? (): Record<string, string> =>
            renderHeaderTemplates(effectiveHeaders, {
              provider: item.provider,
              model: item.model,
              sessionId: sessionId ?? "no-session",
              requestId: randomUUID(),
              timestamp: new Date().toISOString(),
            })
        : undefined;
    // 端点协议：显式指定优先，auto 按 baseUrl 推断（OpenAI 兼容 / Anthropic Messages）
    const format = item.apiFormat && item.apiFormat !== "auto" ? item.apiFormat : inferApiFormat(item.baseUrl);
    if (format === "anthropic") {
      return createAnthropicClient({
        baseUrl: item.baseUrl.replace(/\/v1$/, ""),
        apiKey: key,
        model: item.model,
        resolveHeaders,
      });
    }
    return createOpenAiClient({ baseUrl: item.baseUrl, apiKey: key, model: item.model, resolveHeaders });
  };

  /**
   * 当前活动供应商 → LLM 客户端（**不做跨供应商静默降级**）。
   *
   * 2026-11-08 用户明确要求：「配的是 opencode-zen，回复却自称 Agnes-3.0-flash」——这是旧实现里
   * 的「多供应商降级链」：活动供应商 429/超时后自动切到下一个供应商继续回答（且有 30s 冷却），
   * 但 UI/模型 chip 仍显示活动供应商，于是「模型对应不上」。
   * 现在的语义：选哪个供应商就用哪个；用不了就把上游错误原样报出来（额度/鉴权等错误已在
   * core/llm/upstreamError.ts 里快速失败并给中文可行动提示）。要换供应商由用户显式切换。
   */
  const buildLlmFromActive = (sessionId?: string): LlmClient | undefined => {
    const active = providers.active();
    if (!active) return undefined;
    return buildLlmForProvider(active, sessionId);
  };
  // 惰性引用：供应商增删改/切换活跃后立即生效（无需重启）
  let llmRef: LlmClient | undefined = buildLlmFromActive();

  // 记忆库（路径可在设置里改）+ 会话持久化
  const memoryFile = initialPrefs.memoryStorePath?.trim() || path.join(dirs.dataDir, "memory", "memory.json");
  const memory = new MemoryService({ platform, filePath: memoryFile });
  // 记忆加载不阻塞首次出窗：load() 在重建向量索引时会探测本地 embedding（最坏 embedTimeout=3000ms，
  // 见 memoryService.ts:84 + buildExternalIndex），等待它会把窗口创建一起拖住。
  // 读取路径在「尚未 loaded」时按空库返回空结果（MemoryService 的读方法直接读 store），
  // 因此窗口/IPC 装配无需已加载状态；加载完成只影响「第一条消息」的记忆召回，代价可接受。
  const memoryReady = memory
    .load()
    .then(() => bootTrace.mark("memory-load-done"))
    .catch(() => undefined);
  // 加载在后台继续；只有「记忆写入」等极少数路径需要等它，首屏不等（见上方注释）。
  void memoryReady;
  bootTrace.mark("memory-load-started");

  // 询问用户总线（ask_user 工具）：ask:user 推渲染层弹窗，回答经 ask:respond 结算（超时按取消）
  const askBus = new AskBus({ push: (event, payload) => pushToRenderer(event, payload) });

  // Agent-Loop 运行时（ADR-0010）：内置 loop + 安全模式回退；选择持久化到偏好（运行时切换即生效）
  const loopRuntime = createLoopRuntime({
    push: (event, payload) => pushToRenderer(event, payload),
    getActiveId: () => loadPreferences(dirs.configDir).loopId,
    onActiveChanged: (id) => {
      savePreferencesPatch(dirs.configDir, { loopId: id });
    },
    // L2 声明式 / L3 脚本 loop 从 <dataDir>/loops 扫描（坏文件跳过并记录 error）
    dataDir: dirs.dataDir,
  });
  const sessions = new SessionStore(path.join(dirs.dataDir, "sessions"));
  // 工作区：挂载项目文件夹。旧偏好里的 workspaceRoot 作为默认工作区，兼容升级用户。
  const workspaces = new WorkspaceStore(
    path.join(dirs.dataDir, "workspaces.json"),
    initialPrefs.workspaceRoot?.trim() || process.cwd(),
  );
  const worktreesRoot = path.join(dirs.dataDir, "worktrees");
  // 书签（浏览器功能面 MVP）：独立 JSON 存储，单实例（多实例会互相覆盖）
  const bookmarks = new BookmarksStore(dirs.dataDir);
  /** 会话工作根：会话 worktree > 会话工作区 > 活动工作区。 */
  const resolveSessionRoot = (sessionId?: string): string => {
    const worktree = sessionId ? sessions.getWorktree(sessionId) : null;
    const workspaceId = sessionId ? sessions.get(sessionId)?.workspaceId : null;
    const bound = workspaceId ? workspaces.get(workspaceId) : null;
    return resolveRoot({
      worktreePath: worktree?.path ?? null,
      sessionWorkspaceRoot: bound?.root ?? null,
      activeWorkspaceRoot: workspaces.active()?.root ?? null,
      fallback: workspaceRoot,
      isDirectory: (dir) => {
        try {
          return fs.statSync(dir).isDirectory();
        } catch {
          return false;
        }
      },
    });
  };
  // 沙箱根跟随活动工作区（逐个工具执行前还会按会话根覆盖，见 ChatService.resolveWorkspaceRoot）
  sandbox.setWorkspaceRoot(workspaces.active()?.root ?? workspaceRoot);

  // 终端会话管理器（持久多环境终端）：每终端独立子进程，进程与工作根按会话隔离
  const terminals = new TerminalSessionManager({
    resolveWorkspaceRoot: (sessionId?: string) => resolveSessionRoot(sessionId),
    push: (event, payload) => pushToRenderer(event, payload),
  });
  const extensions = new ExtensionHost(path.join(dirs.dataDir, "extensions"));
  const skills = new SkillHost(path.join(dirs.dataDir, "skills"));
  const mcp = new McpHost(
    path.join(dirs.dataDir, "mcp.json"),
    registry,
    () => pushToRenderer("mcp:updated", { servers: mcp.list() }),
    () => sandbox.syncKnownTools(registry.list().map((t) => t.name)),
  );

  // Agent 注册表（真实实现）：内置默认 Agent → 决定身份段与工具白名单
  const agents = new AgentRegistry();
  agents.registerBuiltin(BUILTIN_AGENT);
  const defaultAgent = agents.defaultAgent();
  bootTrace.mark("stores");
  const ruleStats = new RuleStatsStore(path.join(dirs.dataDir, "rules", "stats.json"));
  const ruleHistory = new RuleHistoryStore(path.join(dirs.dataDir, "rules", "history.json"));
  const settingsDeps = {
    ...deps,
    platform,
    ruleStats,
    ruleHistory,
    workspaces,
    dataDir: dirs.dataDir,
    configDir: dirs.configDir,
    workspaceRoot,
    env: process.env,
    appVersion: app.getVersion(),
    pickPath: async (kind: "file" | "directory", title?: string) => {
      const result = await dialog.showOpenDialog(mainWindow ?? undefined!, {
        title: title ?? (kind === "directory" ? "选择文件夹" : "选择文件"),
        properties: kind === "directory" ? ["openDirectory", "createDirectory"] : ["openFile"],
      });
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
    },
    diagnosticsExtra: () => ({
      auditEntries: auditLog.length,
      auditFile: auditFile?.stats() ?? null,
      tools: registry.list().length,
      agents: agents.list().length,
      memoryEntries: memory.stats().total,
      secretStorageMode: secrets.storageMode(),
    }),
    // 供应商增删改/切换 → 重建 LLM（立即可对话）
    providers,
    secrets,
    onProvidersChanged: () => {
      llmRef = buildLlmFromActive();
    },
    onProviderCleared: () => {
      llmRef = buildLlmFromActive();
    },
    onProviderSaved: () => {
      llmRef = buildLlmFromActive();
    },
    // 偏好保存 → 应用工作区根 / 记忆库位置
    onPreferencesSaved: (prefs: { workspaceRoot?: string; memoryStorePath?: string }) => {
      const nextRoot = prefs.workspaceRoot?.trim() || process.cwd();
      if (nextRoot !== workspaceRoot) {
        workspaceRoot = nextRoot;
        settingsDeps.workspaceRoot = nextRoot;
        sandbox.setWorkspaceRoot(nextRoot);
      }
      const nextMemory = prefs.memoryStorePath?.trim() || path.join(dirs.dataDir, "memory", "memory.json");
      if (nextMemory !== memory.filePath) void memory.relocate(nextMemory);
    },
  };
  // 规则守卫缓存：按当前 workspace 的启用规则编译；内容/路径变化才重编译。
  let ruleGuardCache: {
    key: string;
    guards: ReturnType<typeof compileRuleGuards>;
    commandGuards: ReturnType<typeof compileCommandGuards>;
  } | null = null;
  const currentRuleGuards = (workspaceId?: string) => {
    const entries = readRuleEntries(settingsDeps, workspaceId).filter((entry) => entry.enabled && entry.content.trim());
    const key = entries.map((entry) => entry.path + ":" + entry.content).join("\u0000");
    if (ruleGuardCache?.key === key) return ruleGuardCache;
    const sources = entries.map((entry) => ({ id: entry.id, text: entry.content }));
    ruleGuardCache = {
      key,
      guards: compileRuleGuards(sources),
      commandGuards: compileCommandGuards(sources),
    };
    return ruleGuardCache;
  };

  const toolEvidence = new ToolEvidence(memory);
  const chatService = new ChatService({
    platform,
    registry,
    sandbox,
    // Agent-Loop 可插拔：统一经 LoopRegistry 运行（内置 loop 失败自动回退安全模式）
    runLoop: (input) => loopRuntime.run(input),
    agent: defaultAgent ? { name: defaultAgent.name, role: defaultAgent.role } : undefined,
    toolAllowlist: defaultAgent?.toolAllowlist,
    readImageAttachment: (filePath: string) => {
      // 非视觉模型不注入图片：否则 text-only 上游会直接 400（比“看不到图”更糟）。
      const active = providers.active();
      const spec = active?.models?.find((m) => m.id === active.model);
      if (spec?.vision !== true && !spec?.inputModalities?.includes("image")) return null;
      const image = readImageDataUrl(filePath);
      if (!image.ok || !image.dataUrl) return null;
      const comma = image.dataUrl.indexOf(",");
      if (comma < 0) return null;
      return { mime: image.mime ?? "image/png", base64: image.dataUrl.slice(comma + 1) };
    },
    // 规则文件（AGENTS.md）：每次 stream 重新读取；项目规则按会话所属工作区解析。
    getSystemRules: (sessionId?: string) =>
      currentRulesPrompt(
        settingsDeps,
        sessionId ? sessions.get(sessionId)?.workspaceId ?? undefined : undefined,
      ),
    // 规则守卫：把「不要修改 dist/」这类可判定的规则编译成执行前的拒绝
    guardToolCall: ({ toolName, args, kind, target, sessionId }) => {
      const workspaceId = sessionId ? sessions.get(sessionId)?.workspaceId ?? undefined : undefined;
      const { guards, commandGuards } = currentRuleGuards(workspaceId);
      if (guards.length === 0 && commandGuards.length === 0) return null;
      const decision = guards.length > 0
        ? checkRuleGuards(guards, {
            toolName,
            args,
            kind,
            target,
            workspaceRoot: resolveSessionRoot(sessionId),
          })
        : null;
      if (decision) {
        ruleStats.record({ text: decision.rule, toolName, target });
        return decision;
      }
      if (kind === "terminal" && commandGuards.length > 0) {
        const command = typeof args.command === "string" ? args.command : typeof args.cmd === "string" ? args.cmd : "";
        const commandDecision = checkCommandGuards(commandGuards, command);
        if (commandDecision) {
          ruleStats.record({ text: commandDecision.rule, toolName, target: command });
          return commandDecision;
        }
      }
      return null;
    },
    // 记忆召回：按当前消息取相关条目，注入 volatile 段
    // 记忆按会话所属工作区召回（D1）：未绑定工作区的会话归 default，绝不跨区注入。
    onToolCall: (toolName: string, sessionId: string) => memory.recordToolUsage(toolName, sessionId),
    // 工具失败证据：同一会话同一工具同一错误连续两次才写 lesson（首次是偶发）。
    onToolResult: (event) => {
      const workspaceId = sessions.get(event.sessionId)?.workspaceId ?? undefined;
      void toolEvidence
        .observe({ ...event, ...(workspaceId ? { workspaceId } : {}) })
        .then((result) => {
          if (result.lesson) {
            pushToRenderer("memory:updated", { action: "tool-lesson", added: 1, total: memory.stats().total });
          }
        })
        .catch(() => {});
    },
    getMemoryFor: (text: string, sessionId?: string) =>
      memory.recallPrompt(text, (sessionId ? sessions.get(sessionId)?.workspaceId : null) ?? "default"),
    // 技能：独立子系统，只注入 SKILL.md 文本（不提供工具）
    getSkillPrompt: (text: string) => skills.promptFor(text),
    // 权限策略：设置面板保存后即时生效
    permissionPolicy: () => loadPermissions(dirs.configDir),
    // 敏感步骤（登录/支付/不可撤销）始终强制确认；用户在设置里显式关闭才放行（缺省 true）
    sensitiveAlwaysConfirm: () => loadPreferences(dirs.configDir).sensitiveAlwaysConfirm !== false,
    // 工具执行前按会话切换沙箱根（工作区 / worktree，后台会话也不串根）
    resolveWorkspaceRoot: (sessionId?: string) => resolveSessionRoot(sessionId),
    // 供应商：设置面板保存后即时生效
    getLlm: (sessionId?: string) => buildLlmFromActive(sessionId) ?? llmRef,
    // 会话历史：按本次请求的 sessionId 读该会话消息（后台会话不串台；回滚后同样生效）
    getHistory: (sessionId?: string) => {
      const messages = sessionId
        ? (sessions.loadMessages(sessionId) ?? [])
        : (sessions.load()?.messages ?? []);
      return messages.slice(-400).map((m) => ({
        role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
        content: m.text,
        // 模型可见墙钟时间：持久化的 ts 透传给 services（由 messageTime 统一加前缀）
        ts: m.ts,
      }));
    },
    // 当前模型上下文窗口（tokens）：用于历史压缩预算；未探测到则回退 core 默认
    getContextWindow: () => {
      const active = providers.active();
      const spec = active?.models?.find((m) => m.id === active.model);
      return spec?.contextWindow;
    },
    // Agent 请求上限（设置 · 通用）
    getAgentLimits: () => {
      const prefs = loadPreferences(dirs.configDir);
      return {
        maxRounds: prefs.agentMaxRounds,
        maxToolCalls: prefs.agentMaxToolCalls,
        repeatToolWarnAt: prefs.agentRepeatToolWarn,
        repeatToolStopAt: prefs.agentRepeatToolStop,
      };
    },
    // 模式 × 会话：plan=只读规划（仅放行只读工具）；build=默认 Agent 白名单。
    // 再叠加会话级「浏览器控制」：关闭时剔除 BROWSER_AGENT_TOOLS（与 contracts 单源一致），
    // 这份名单同时决定模型可见面与执行闸（services/chat.ts 只解析一次）。
    getToolAllowlist: (mode?: "build" | "plan", sessionId?: string) => {
      const base =
        mode === "plan"
          ? registry
              .list()
              .filter((t) => t.permissions.read && !t.permissions.write && !t.permissions.terminal && !t.permissions.network)
              .map((t) => t.name)
          : defaultAgent?.toolAllowlist;
      const id = sessionId ?? sessions.currentId();
      // 未知会话 / 读不到 → 关闭（fail-closed）：幽灵会话不该意外获得浏览器控制权。
      const browserControl = id ? sessions.get(id)?.browserControl === true : false;
      // 关闭时剔除浏览器工具；base 为 undefined 时由 resolveToolSurface 用注册表全集重构名单。
      return resolveToolSurface({
        base,
        allNames: registry.list().map((t) => t.name),
        exclude: browserControl ? [] : [...BROWSER_AGENT_TOOLS],
      });
    },
    // 权限确认 → 推送到渲染层弹窗（perm:request 事件）
    onPermissionRequest: (request) => pushToRenderer("perm:request", request),
  });
  bootTrace.mark("chat-service");

  // 浏览器宿主：会话级标签组；WebContentsView 懒创建 + 布局对齐（electron 细节封装在 electronBrowser.ts）
  // 初始会话 = 最近一次使用的会话（重启后左右两侧一起恢复）；没有会话时建一个，保证"文件夹"存在。
  let initialSessionId = sessions.currentId() ?? sessions.newSession().sessionId;
  // 启动即把当前会话补绑活动工作区（旧会话/首启会话都落进"文件夹"）
  if (!sessions.get(initialSessionId)?.workspaceId && workspaces.activeId()) {
    sessions.setWorkspaceId(initialSessionId, workspaces.activeId());
  }
  const tabSaveTimers = new Map<string, NodeJS.Timeout>();
  /** 本轮首次动作触发任务化：等回合一结束就把任务身份过户给「从操作阶段分出的分支」。 */
  const pendingTaskForks = new Set<string>();
  /** 本回合开始前的消息数：任务分支必须从这里切，分支点在「浏览器操作之前」。 */
  const turnStartCounts = new Map<string, number>();
  const pendingTaskKeep = new Map<string, number>();
  /** 用户标签 + 任务快照统一落盘（旧 browser-user-tabs.json 仅作迁移读取）。 */
  const browserStates = new BrowserStateStore(path.join(dirs.dataDir, "browser-state.json"));
  // 旧版本可能把 task 标记写丢，但任务工作区快照还在：有 agentBound 页的会话必然曾是任务，
  // 启动时补回标记，避免「有折叠工作区但会话列表没有任务徽标」。
  for (const [taskSessionId, state] of browserStates.entries()) {
    if (taskSessionId === USER_TABS_SESSION) continue;
    if (!state.tabs.some((tab) => tab.agentBound === true)) continue;
    if (sessions.get(taskSessionId) && !sessions.isTask(taskSessionId)) {
      sessions.setTask(taskSessionId, true);
    }
  }
  type PendingFork = { sourceId: string; keep: number; forkId?: string };
  const pendingForkFile = path.join(dirs.dataDir, "pending-task-forks.json");
  const pendingForkRecords = new Map<string, PendingFork>();
  try {
    if (fs.existsSync(pendingForkFile)) {
      const raw = JSON.parse(fs.readFileSync(pendingForkFile, "utf8")) as PendingFork[];
      for (const item of Array.isArray(raw) ? raw : []) {
        if (item && typeof item.sourceId === "string" && Number.isFinite(item.keep)) {
          pendingForkRecords.set(item.sourceId, item);
        }
      }
    }
  } catch {
    // 标记文件损坏：忽略
  }
  const persistPendingForks = (): void => {
    try {
      fs.writeFileSync(pendingForkFile, JSON.stringify([...pendingForkRecords.values()]), "utf8");
    } catch {
      // 恢复标记落盘失败不阻断运行
    }
  };
  const legacyUserTabsFile = path.join(dirs.dataDir, "browser-user-tabs.json");
  const cancelBrowserStateSave = (sessionId: string): void => {
    const timer = tabSaveTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    tabSaveTimers.delete(sessionId);
  };
  const queueBrowserStateSave = (sessionId: string, state: PersistedBrowserState): void => {
    const prev = tabSaveTimers.get(sessionId);
    if (prev) clearTimeout(prev);
    tabSaveTimers.set(
      sessionId,
      setTimeout(() => {
        tabSaveTimers.delete(sessionId);
        if (sessionId === USER_TABS_SESSION) {
          browserStates.set(USER_TABS_SESSION, state);
          return;
        }
        // 任务会话把页面关光（或只剩用户页）时，保留上一次的任务页快照：
        // 用户重新打开这个会话时，折叠工作区还能按原样回来（关页 ≠ 结束任务）。
        if (sessions.isTask(sessionId) && !state.tabs.some((tab) => tab.agentBound === true)) {
          // 任务工作区没有绑定页了：删快照并结束任务，避免下次打开/重启把旧页复活。
          browserStates.delete(sessionId);
          sessions.setTask(sessionId, false);
          return;
        }
        browserStates.set(sessionId, state);
      }, 400),
    );
  };
  // 全局浏览器历史（跨标签/跨会话共享）：持久化 <dataDir>/browser-history.json；
  // 上限 500、按 URL 去重合并；每次成功访问即原子落盘（退出前无需额外 flush）。
  const browserHistory = new BrowserHistoryStore(path.join(dirs.dataDir, "browser-history.json"));
  // 浏览器扩展（Chrome/Edge 系）：安装目录 <dataDir>/browser-extensions；开机异步加载。
  const browserExtensions = new BrowserExtensionHost({
    rootDir: path.join(dirs.dataDir, "browser-extensions"),
    api: session.fromPartition(SESSION_PARTITION).extensions as unknown as ExtensionApiLike,
  });
  browserExtensionsHost = browserExtensions;
  void browserExtensions.loadAll().catch(() => undefined);
  // 浏览器工具栏浮层：独立子窗口渲染（天然浮在原生网页视图之上，不再需要隐藏网页）
  const chromePopover = createChromePopoverManager({
    getMainWindow: () => mainWindow,
    loadUrlFor: (kind, lang) =>
      `${PROTOCOL}://app/index.html?popover=${kind}${lang ? `&lang=${encodeURIComponent(lang)}` : ""}`,
    preloadPath: preloadPath(),
    // 浮层关闭（Esc/失焦/hover 离开/切 kind）→ 通知渲染层同步状态，支持「已展开时点击一次即收起」
    onClosed: () => pushToRenderer("chrome:popoverClosed", {}),
    additionalArguments: [
      `--loopsoar-bindings=${JSON.stringify(buildBindings())}`,
      `--loopsoar-events=${JSON.stringify(EVENTS)}`,
    ],
  });
  // Agent 会话栏「独立窗口」（真·窗口化）：无 parent 的顶层系统窗口，可拖动/缩放/最小化/贴边，
  // 主窗口隐藏侧栏、网页铺满；与 chromePopover（悬停浮层子窗口）刻意区分，不要合并。
  const agentWindowManager = createAgentWindowManager({
    // 独立 56px 图标窗口：静态页，只画 logo + 拖动/还原，不加载整个 App（避免多余订阅/初始化）。
    iconUrlFor: () => `${PROTOCOL}://app/icon.html`,
    loadUrlFor: (sessionId) =>
      `${PROTOCOL}://app/index.html?mini=1${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`,
    preloadPath: preloadPath(),
    icon: iconPath(),
    // 最小化=缩成图标按钮（Slime 同款）；图标模式切换通知渲染层切换「图标视图/会话视图」
    onIconModeChange: (icon) => pushToRenderer("chrome:agentWindowIconMode", { icon }),
    // 最小化/还原衔接：窗口截图交给渲染层做「内容连续」的过渡（避免大 UI 逐帧重排掉帧）。
    onTransition: (payload) => pushToRenderer("chrome:agentWindowTransition", payload),
    additionalArguments: [
      `--loopsoar-bindings=${JSON.stringify(buildBindings())}`,
      `--loopsoar-events=${JSON.stringify(EVENTS)}`,
    ],
    // 不传 onClosed：registerAgentWindowDomain 内部已订阅并 push chrome:agentWindowClosed（避免双推）
    // 贴边：会话栏窗口默认贴主窗口右缘、顶部对齐浏览器视图（坐标随主窗口移动/缩放实时更新）。
    getMainWindowContentBounds: () => {
      try {
        return mainWindow && !mainWindow.isDestroyed() ? mainWindow.getContentBounds() : null;
      } catch {
        return null;
      }
    },
  });
  agentWindow = agentWindowManager;
  devToolsPanel = new BrowserDevToolsPanel({
    getWindow: () => mainWindow,
    onOpenChange: (open) => pushToRenderer("chrome:devToolsPanel", { open }),
  });
  browserHost = createElectronBrowserHost(
    () => mainWindow,
    (url) => {
      // 只把真实网页转为新标签：about:blank/空地址等（弹窗占位）直接忽略，避免凭空多出「新标签页」
      if (!/^https?:\/\//i.test(url)) return;
      void browserHost?.newTab(url);
    },
    {
      initialSessionId,
      devToolsPanel: devToolsPanel ?? undefined,
      onSessionStateChanged: queueBrowserStateSave,
      // 成功访问（应用内导航/网页内跳转/新标签首屏）→ 追加全局历史
      onVisited: (visit) => {
        browserHistory.record(visit);
      },
      // 标题迟到 → 刷新同 URL 条目标题（不新增访问）
      onTitleChanged: (url, title) => {
        browserHistory.updateTitle(url, title);
      },
      // 图标迟到 → 刷新同 URL 条目图标（不新增访问）
      onFaviconChanged: (url, favicon) => {
        browserHistory.updateFavicon(url, favicon);
      },
      // Agent 首次动手 → 会话升级为「浏览器任务」：列表专属标记，关页不退回普通会话。
      onTaskCreated: (sessionId) => {
        if (sessions.isTask(sessionId)) return;
        // 动作期间先把当前会话临时当任务（折叠页立即出现）；回合结束后再把它过户给分支。
        sessions.setTask(sessionId, true);
        const keep = turnStartCounts.get(sessionId) ?? 0;
        pendingTaskForks.add(sessionId);
        pendingTaskKeep.set(sessionId, keep);
        pendingForkRecords.set(sessionId, { sourceId: sessionId, keep });
        persistPendingForks();
      },
      // 首次动作克隆出可见页面：光标从这一刻起常驻，直到本轮结束。
      onAgentActing: (sessionId) => holdPointerForAgent(sessionId),
      // 网页视图几何（单源）：覆盖指针贴住网页区域；没有可见网页时传 null → 覆盖层隐藏。
      onViewLayout: (rect) => {
        lastViewRect = rect;
        syncPointerArea();
        // 页面加载完成/切到前台时，若这一轮还在跑，把常驻光标补上（克隆页往往晚于轮次开始才可见）。
        if (rect && browserHost && agentTurnSessions.has(browserHost.currentSessionId())) {
          holdPointerForAgent(browserHost.currentSessionId());
        }
      },
      // 广告/追踪拦截开关跟随偏好（默认开；设置里改动即时生效）
      isAdBlockEnabled: () => loadPreferences(dirs.configDir).adBlockEnabled ?? true,
      // 点原生网页 = 点了「列表外」：通知渲染层收起按钮展开的浮层（DOM 收不到该区域 pointerdown）
      onViewFocused: () => {
        chromePopover.close();
        pushToRenderer("chrome:dismissPopovers", {});
      },
    },
  );
  // 崩溃/中途退出恢复：首次动作后没来得及 fork 的任务，在启动时补完或清掉孤儿任务标记。
  for (const [sourceId, record] of [...pendingForkRecords]) {
    const source = sessions.get(sourceId);
    if (!source) {
      pendingForkRecords.delete(sourceId);
      continue;
    }
    let fork = record.forkId ? sessions.get(record.forkId) : null;
    if (!fork && source.messages.length > record.keep) {
      fork = sessions.fork(sourceId, record.keep, undefined, { activate: false });
      if (fork) {
        record.forkId = fork.sessionId;
        persistPendingForks();
      }
    }
    if (fork) {
      if (source.messages.length > record.keep) sessions.moveTail(sourceId, fork.sessionId, record.keep);
      sessions.setTask(sourceId, false);
      sessions.setTask(fork.sessionId, true);
      const state = browserStates.get(sourceId) ?? sessions.getBrowserState(sourceId);
      if (state) browserStates.set(fork.sessionId, state);
      browserStates.delete(sourceId);
      if (initialSessionId === sourceId) initialSessionId = fork.sessionId;
    } else {
      // 没有可搬的操作回合：不留任务身份，也不留只剩任务页的孤儿存档。
      sessions.setTask(sourceId, false);
      browserStates.delete(sourceId);
    }
    pendingForkRecords.delete(sourceId);
    persistPendingForks();
  }

  // 出网守卫注入「Agent 标签」判定：Agent 任务标签默认不得访问回环地址（用户标签不受影响），
  // 与 web_fetch 的 allowLoopback:false 对齐；E2E/开发可用 LOOPSOAR_ALLOW_LOOPBACK=1 放开。
  // 放在启动恢复之前：恢复出来的任务页在加载时就要按新策略判定。
  setAgentTabPredicate((id) => browserHost?.isAgentWebContents(id) ?? false);

  // 启动恢复：全局用户标签独立于会话；会话只恢复 Agent 工作区（agentBound 标签）。
  let bootUserState: PersistedBrowserState | null = null;
  try {
    bootUserState = browserStates.get(USER_TABS_SESSION);
    if (!bootUserState && fs.existsSync(legacyUserTabsFile)) {
      bootUserState = sanitizeBrowserState(JSON.parse(fs.readFileSync(legacyUserTabsFile, "utf8")));
    }
  } catch {
    // 文件损坏：当作没有用户标签
  }
  const bootBrowserState = browserStates.get(initialSessionId) ?? sessions.getBrowserState(initialSessionId);
  const bootTaskState = bootBrowserState && bootBrowserState.tabs.some((tab) => tab.agentBound === true)
    ? { ...bootBrowserState, tabs: bootBrowserState.tabs.filter((tab) => tab.agentBound === true) }
    : undefined;
  void (async () => {
    if (bootUserState) await browserHost.restoreUserTabs(bootUserState);
    const tabs = await browserHost.switchSession(initialSessionId, bootTaskState).catch(() => []);
    // 普通会话启动时显示用户全局标签；任务会话显示自己的工作区。
    if (!sessions.isTask(initialSessionId)) browserHost.showUserTabs();
    pushToRenderer("browser:tabs", { tabs, visibleSession: browserHost?.visibleSessionId() });
  })();
  bootTrace.mark("browser-host");
  // 注：全局历史补记（browser-history.json 的同步落盘）已移到首帧后的 deferred 启动任务里，见 runDeferredBootTasks。
  /**
   * Agent 打开网页前的「会话窗口布局」应用（第二阶段 Slice E · 功能②，E2 修订）。
   *
   * 用户决定（m00974）：不再每次打开网页都弹窗询问。默认布局在**首次启动向导**里选一次，
   * 之后随时可在「设置 · 通用 → Agent 打开网页时的窗口布局」修改。因此本钩子只做三件事：
   *   1. 读偏好；keep → 完全不动窗口（用户自己摆）；
   *   2. docked / agentWindow → pushToRenderer("chrome:applyLayout")，渲染层执行真正窗口动作；
   *   3. 同一会话已经应用过同一布局 → 不重复推（避免每次导航都动窗口）。
   */
  const appliedLayoutBySession = new Map<string, "docked" | "agentWindow" | "keep">();
  /**
   * 接管锁提示文案：主进程拿不到渲染层词典，这里按偏好语言保留一份
   * （与 UI 的 browser.agentLockedHint 同义；改文案时两处一起改）。
   */
  const userLockLabel = (): string =>
    loadPreferences(dirs.configDir).language.startsWith("en")
      ? "The agent is operating this page · stop the session to take over"
      : "Agent 正在操作此页面 · 停止会话后可自行操作";

  const beforeOpenBrowserPage = async (input: { sessionId?: string; url: string }) => {
    // 没有会话（草稿态）就读不到 browserControl；且此时 browser_* 工具本就不可见，直接放行。
    const sessionId = input.sessionId;
    if (!sessionId) return { proceed: true };
    const session = sessions.get(sessionId);
    if (!session || session.browserControl !== true) return { proceed: true };
    const layout = loadPreferences(dirs.configDir).browserOpenLayout ?? "docked";
    if (layout === "keep") return { proceed: true };
    if (appliedLayoutBySession.get(sessionId) === layout) return { proceed: true };
    appliedLayoutBySession.set(sessionId, layout);
    pushToRenderer("chrome:applyLayout", { mode: layout, sessionId, reason: "preference" });
    return { proceed: true };
  };

  // Agent 浏览器工具（快照/导航/点击/输入/滚动/抓取）：在浏览器宿主创建后注册
  registerBrowserTools(registry, () => browserHost, resolveSessionRoot, {
    beforeOpenPage: beforeOpenBrowserPage,
    // 敏感步骤二次确认：策略层只看到 target（多为 #e12），只有定位后拿到真实文案才判得出
    // 「立即支付 / 确认转账」。返回 false（含取消/超时/异常）= 不点击（fail-closed）。
    confirmSensitive: async ({ sessionId, tool, label, reason, url }) => {
      try {
        const answer = await askBus.request({
          question: `Agent 准备在网页上执行敏感操作：「${label}」。这一步不可撤销，确认要执行吗？`,
          options: ["确认执行", "取消"],
          allowFreeText: false,
          // 给用户留足阅读时间；到期由渲染层自动收起（不会留下一个点了也没用的弹窗）。
          timeoutMs: 180_000,
          // 会话归属：后台会话的确认只在对应会话里显示，不抢用户当前界面。
          sessionId,
          kind: "sensitive",
          title: "敏感操作确认",
          detail: [
            { label: "操作", value: tool },
            { label: "目标", value: label },
            { label: "原因", value: reason },
            ...(url ? [{ label: "页面", value: url }] : []),
          ],
        });
        if (answer.cancelled) return false;
        // 渲染层回填稳定 token "confirm"：按钮文案走 i18n，不能拿中文文案当判据
        // （否则英文界面下「Confirm」会被判成拒绝）。
        const value = (answer.answer ?? "").trim();
        return value === "confirm" || value.includes("确认");
      } catch {
        return false;
      }
    },
    // 视觉层：Agent 的「鼠标」画在应用级覆盖窗口里（网页 DOM 零注入）。
    pointer: {
      moveTo: (x, y) => agentPointer?.moveTo(x, y),
      highlight: (rect) => agentPointer?.highlight(rect),
      click: (x, y) => agentPointer?.click(x, y),
      chip: (text) => agentPointer?.chip(text),
    },
    // 只有视觉模型才把截图作为图片回灌；text-only 模型继续只拿文件路径。
    visionEnabled: () => {
      const active = providers.active();
      const spec = active?.models?.find((m) => m.id === active.model);
      return spec?.vision === true || spec?.inputModalities?.includes("image") === true;
    },
  });
  // Agent 浏览器活动广播（会话隔离）：只在动作执行期间推 start/end，
  // 渲染层据此显示呼吸灯、把「该会话的活动标签」切到可见；绝不切走用户所在会话。
  for (const toolName of BROWSER_AGENT_TOOLS) {
    const def = registry.get(toolName);
    if (!def) continue;
    const original = def.execute.bind(def);
    registry.register(
      {
        ...def,
        execute: async (ctx) => {
          pushToRenderer("chrome:agentActivity", { sessionId: ctx.sessionId, tool: toolName, phase: "start" });
          try {
            return await original(ctx);
          } finally {
            pushToRenderer("chrome:agentActivity", { sessionId: ctx.sessionId, tool: toolName, phase: "end" });
          }
        },
      },
      { force: true },
    );
  }
  registerTerminalTools(registry, resolveSessionRoot);
  registerPlanTools(registry);
  registerFileTools(registry, resolveSessionRoot);
  registerDocumentTools(registry);
  registerSkillTools(registry, skills);
  registerSubagentTools(registry, createChatSubagentRunner(chatService, registry));
  // 记忆工具（设置·记忆同源数据）：读工具 plan 可用，写工具按 sandbox L2 确认
  registerMemoryTools(registry, memory, {
    workspaceIdForSession: (sessionId?: string) =>
      (sessionId ? sessions.get(sessionId)?.workspaceId : null) ?? "default",
    // E-M2：命中即刷新面板/图谱，节点激活上升后由图组件做脉冲反馈。
    onSearchUsed: () => pushToRenderer("memory:updated", { action: "used" }),
  });
  // 联网搜索工具：走注入的 platform.net.request（SSRF/DNS 钉扎），引擎来自偏好
  registerSearchTools(registry, {
    getEngine: () => loadPreferences(dirs.configDir).searchEngine,
    getPlatform: () => platform,
    getMaxResults: () => 5,
  });
  // 询问用户工具：挂起等待真人回答（弹窗）
  registerAskTools(registry, askBus);
  // 新工具注册后必须再同步沙箱白名单（否则会被判「未知工具名」）
  sandbox.syncKnownTools(registry.list().map((t) => t.name));
  bootTrace.mark("tools-registered");

  /** 退出前全量落盘：标签防抖队列可能还没触发，必须同步刷一次。 */
  const saveAllBrowserStates = (): void => {
    for (const timer of tabSaveTimers.values()) clearTimeout(timer);
    tabSaveTimers.clear();
    for (const meta of sessions.list()) {
      const state = browserHost?.snapshotSession(meta.id);
      if (!state || state.tabs.length === 0) continue;
      // 任务会话把页面关光时保留上一次的任务页快照（与运行时防抖保存同一规则），
      // 否则退出这一次会把「重新打开任务会话能恢复工作区」的存档覆盖成空。
      if (sessions.isTask(meta.id) && !state.tabs.some((tab) => tab.agentBound === true)) {
        browserStates.delete(meta.id);
        sessions.setTask(meta.id, false);
        continue;
      }
      browserStates.set(meta.id, state);
    }
    const userState = browserHost?.snapshotSession(USER_TABS_SESSION);
    if (userState) browserStates.set(USER_TABS_SESSION, userState);
  };

  // 下载管理：目录跟随偏好（downloadDir，留空=系统下载目录），变更推送 UI
  const downloads = new DownloadsBridge(
    () => loadPreferences(dirs.configDir).downloadDir ?? "",
    () => pushToRenderer("browser:downloads", { downloads: downloads.list() }),
  );

  registerRuntimeDomain(deps);
  registerWorkspaceDomain({
    ...deps,
    platform,
    openPath: (target: string) => shell.openPath(target),
    workspaces,
    sessions,
    worktreesRoot,
    // file:read/write 的会话工作根解析（worktree > 会话工作区 > 活动工作区）
    resolveSessionRoot: (sessionId?: string) => resolveSessionRoot(sessionId),
    pickFolder: async () => {
      const result = await dialog.showOpenDialog(mainWindow ?? undefined!, {
        title: "选择工作区文件夹",
        properties: ["openDirectory", "createDirectory"],
      });
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
    },
  });
  registerAgentsDomain({ ...deps, agents });
  registerSettingsDomain(settingsDeps);
  const ruleCandidates = new RuleCandidateStore(path.join(dirs.dataDir, "rules", "candidates.json"));
  registerRuleLearningDomain({
    ...deps,
    dataDir: dirs.dataDir,
    store: ruleCandidates,
    history: ruleHistory,
    workspaces,
    sessions,
    evidenceFor: (sessionId) => toolEvidence.recentFailures(sessionId),
    review: (messages) => reviewSessionRules(buildLlmFromActive() ?? llmRef, messages),
    push: pushToRenderer,
  });
  registerChatDomain({
    ...deps,
    chatService,
    push: pushToRenderer,
    memory,
    sessions,
    ruleLearning: {
      observe: (input) => ruleCandidates.observe({
        ...input,
        evidence: toolEvidence.recentFailures(input.sessionId),
      }),
    },
    shouldAutoCapture: () => loadPreferences(dirs.configDir).memoryAutoCapture,
    getActiveWorkspaceId: () => workspaces.activeId(),
    getDefaultWorkspaceId: () => {
      const items = workspaces.list();
      return items.find((item) => item.name === "默认工作区")?.id ?? workspaces.activeId();
    },
    // 本轮回复模型快照（会话持久化用，历史悬停显示真实模型）
    getModelInfo: () => {
      const active = providers.active();
      return active ? { provider: active.provider, model: active.model } : undefined;
    },
    /**
     * 「Agent 工作区」接管锁（Slice H）：一轮对话期间锁住该会话里 Agent 绑定/操作过的网页，
     * 结束或用户停止后解锁。锁由壳层下发，因此后台会话、独立小窗、无窗口都成立。
     */
    onTurnStarted: (sessionId) => {
      turnStartCounts.set(sessionId, sessions.get(sessionId)?.messages.length ?? 0);
      // 呼吸灯也按「轮次」而不是单次工具调用：工具执行只有几百毫秒，用户根本看不到。
      if (!browserHost) return;
      // 没有开启浏览器控制的会话本来就没有 Agent 网页：锁了只会挡住用户自己开的页面。
      if (sessions.get(sessionId)?.browserControl !== true) return;
      agentTurnSessions.add(sessionId);
      void browserHost.lockForSession(sessionId, true, userLockLabel()).catch(() => undefined);
      // 虚拟光标常驻：本轮开始就亮出来（页面随后才可见时由 setArea 补显示），
      // 让用户一直能看到「Agent 的鼠标」而不是只闪一下。
      holdPointerForAgent(sessionId);
    },
    onTurnSettled: (sessionId) => {
      turnStartCounts.delete(sessionId);
      agentTurnSessions.delete(sessionId);
      void browserHost?.lockForSession(sessionId, false).catch(() => undefined);
      if (pointerHeldSession === sessionId) {
        pointerHeldSession = null;
        agentPointer?.hold(false);
      }
      // 首次动作的任务化延迟到回合结束：这时 append 刚把本轮回复写进原会话，
      // 分支能完整带上「Agent 控制发生时的会话阶段」，原会话则恢复为普通讨论。
      if (pendingTaskForks.delete(sessionId) && browserHost) {
        const source = sessions.get(sessionId);
        const keep = pendingTaskKeep.get(sessionId) ?? Math.max(0, (source?.messages.length ?? 0) - 2);
        pendingTaskKeep.delete(sessionId);
        turnStartCounts.delete(sessionId);
        if (source && source.messages.length > keep) {
          // 分支点在操作前：fork 只拿 keep 之前的历史；本轮用户消息+回复搬到分支。
          const fork = sessions.fork(sessionId, keep, undefined, { activate: false });
          if (fork) {
            const record = pendingForkRecords.get(sessionId);
            if (record) {
              record.forkId = fork.sessionId;
              persistPendingForks();
            }
            if (!sessions.moveTail(sessionId, fork.sessionId, keep)) {
              sessions.remove(fork.sessionId);
              sessions.setTask(sessionId, false);
              pendingForkRecords.delete(sessionId);
              persistPendingForks();
              return;
            }
            sessions.setTask(sessionId, false);
            sessions.setTask(fork.sessionId, true);
            browserHost.reassignSession(sessionId, fork.sessionId);
            const state = browserHost.snapshotSession(fork.sessionId);
            if (state && state.tabs.length > 0) browserStates.set(fork.sessionId, state);
            // 过户后旧会话可能还有防抖保存队列：先取消，避免 400ms 后把任务页又写回普通会话。
            cancelBrowserStateSave?.(sessionId);
            browserStates.delete(sessionId);
            pendingForkRecords.delete(sessionId);
            persistPendingForks();
            pushToRenderer("chat:taskForked", { from: sessionId, to: fork.sessionId });
          }
        } else {
          // 回合没落库（异常/退出）：不留「任务但没有分支」的孤儿状态。
          sessions.setTask(sessionId, false);
          pendingForkRecords.delete(sessionId);
          persistPendingForks();
        }
      }
    },
    // 会话即浏览器"文件夹"：切会话 = 切左侧标签组；先由 host 保存旧会话状态，再恢复目标会话
    onSessionOpened: async (sessionId, requestedWorkspaceId) => {
      // 用户切走正在操作的会话：覆盖层光标不该停在新会话的网页上（Agent 仍在后台跑）。
      if (pointerHeldSession && pointerHeldSession !== sessionId) {
        pointerHeldSession = null;
        agentPointer?.hold(false);
      }
      const sessionData = sessions.get(sessionId);
      if (requestedWorkspaceId === undefined) {
        // 旧会话补绑工作区：首次打开时归属当前活动工作区
        if (!sessionData?.workspaceId && workspaces.activeId()) {
          sessions.setWorkspaceId(sessionId, workspaces.activeId());
        }
      } else if (requestedWorkspaceId) {
        // 明确指定工作区的新会话：绑定并在后续切换时成为活动工作区
        sessions.setWorkspaceId(sessionId, requestedWorkspaceId);
      } // null = 暂不归属，等首次对话自动落默认工作区
      // 当前会话的工作区成为活动工作区：新会话默认落在同一"文件夹"
      const boundWorkspaceId = sessions.get(sessionId)?.workspaceId;
      if (boundWorkspaceId && workspaces.activeId() !== boundWorkspaceId) {
        workspaces.select(boundWorkspaceId);
      }
      if (!browserHost) return;
      // 打开会话不再自动恢复它上次的网页（用户 m03744：进会话不该被网页拖住）。
      // 唯一例外是「任务会话」（浏览状态里有 Agent 绑定标签）——折叠工作区是任务本体，
      // 打开任务时恢复其页面属于预期；普通会话保持空白，只显示对话。
      const saved = browserStates.get(sessionId) ?? sessions.getBrowserState(sessionId) ?? undefined;
      const isTaskSession = sessions.isTask(sessionId) || saved?.tabs.some((tab) => tab.agentBound === true) === true;
      const taskState = isTaskSession && saved
        ? { ...saved, tabs: saved.tabs.filter((tab) => tab.agentBound === true) }
        : undefined;
      const tabs = await browserHost.switchSession(sessionId, taskState);
      pushToRenderer("browser:tabs", { tabs, visibleSession: browserHost?.visibleSessionId() });
    },
    onSessionDeleting: async (sessionId) => {
      terminals.closeSession(sessionId);
      // E-M1：删除会话 → 压缩成一条 episode（游离层原料）；失败不阻断删除。
      try {
        const already = memory
          .list({ includeInvalidated: true })
          .some((fact) => fact.category === "episode" && fact.provenance?.sessionId === sessionId);
        if (!already) {
          const meta = sessions.get(sessionId);
          const episode = buildSessionEpisode({
            sessionId,
            title: meta?.title,
            workspaceId: meta?.workspaceId ?? undefined,
            messages: sessions.loadMessages(sessionId) ?? [],
          });
          if (episode) await memory.add(episode);
        }
      } catch (err) {
        console.warn("[Loopsoar] 会话记忆压缩失败（已忽略）：", err);
      }
      const worktree = sessions.getWorktree(sessionId);
      if (!worktree) return;
      await removeWorktree({
        repoRoot: worktree.repoRoot,
        worktreesRoot,
        worktreePath: worktree.path,
        branch: worktree.branch,
        force: true,
        deleteBranch: true,
      }).catch(() => undefined);
      sessions.setWorktree(sessionId, null);
    },
    onSessionDeleted: async (sessionId, nextSessionId) => {
      // 会话删除即撤销该会话的全部「总是允许」，避免残留授权影响后续复用同名会话。
      sandbox.clearSessionApprovals(sessionId);
      browserStates.delete(sessionId);
      if (!browserHost) return;
      await browserHost.deleteSession(sessionId).catch(() => undefined);
      if (nextSessionId) {
        // 同样只恢复任务会话的页面；普通会话只切会话，不拖出网页。
        const nextSaved = browserStates.get(nextSessionId) ?? sessions.getBrowserState(nextSessionId) ?? undefined;
        const nextTask = sessions.isTask(nextSessionId) || nextSaved?.tabs.some((tab) => tab.agentBound === true) ? nextSaved : undefined;
        await browserHost.switchSession(nextSessionId, nextTask).catch(() => undefined);
      }
      pushToRenderer("browser:tabs", { tabs: browserHost.listTabs(), visibleSession: browserHost.visibleSessionId() });
    },
  });
  registerMemoryDomain({
    ...deps,
    memory,
    sessions,
    push: pushToRenderer,
    // 回顾命名：运行时才解析当前模型（设置里换供应商后立即生效）；无模型时返回 null，按钮提示不可用。
    review: (facts) => reviewMemory(buildLlmFromActive() ?? llmRef, facts),
  });
  registerBrowserDomain({
    ...deps,
    browser: browserHost,
    downloads,
    history: browserHistory,
    browserExtensions,
    devtoolsPanel: devToolsPanel ?? undefined,
    resolveFavicon: resolveFaviconForPage,
    endTask: async (sessionId) => {
      await browserHost?.closeSessionTabs(sessionId).catch(() => undefined);
      browserStates.delete(sessionId);
      sessions.setTask(sessionId, false);
      browserHost?.showUserTabs();
    },
    // 任务条持久化：已落盘、尚未打开的任务会话也要出现（否则重启后任务条是空的）。
    listTaskSessions: () =>
      sessions
        .list()
        .filter((meta) => sessions.isTask(meta.id))
        .map((meta) => {
          const state = browserStates.get(meta.id) ?? sessions.getBrowserState(meta.id);
          const tabs = (state?.tabs ?? [])
            .map((tab, index) => ({ tab, index }))
            .filter(({ tab }) => tab.agentBound === true)
            .map(({ tab, index }) => ({
              id: `saved-${meta.id}-${index}`,
              url: tab.url,
              title: tab.title ?? "",
              active: state?.activeIndex === index,
              agentBound: true,
            }));
          return { sessionId: meta.id, tabs };
        })
        .filter((task) => task.tabs.length > 0),
  });
  // 浏览器页 preload 的「应用商店安装」通道：不进入受信 IPC 契约（发送者不是 loopsoar://），
  // 先校验发送者必须是本应用的浏览器标签页，再走 BrowserExtensionHost（含 Chrome/Edge 商店下载）。
  ipcMain.handle("loopsoar-browser:install-extension", async (event, payload) => {
    if (!browserHost?.hasWebContents(event.sender.id)) {
      return { ok: false, error: "来源不是 Loopsoar 浏览器标签页" };
    }
    const raw = (payload ?? {}) as { id?: unknown };
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!/^[a-p]{32}$/.test(id)) return { ok: false, error: "扩展 ID 非法" };
    try {
      const extension = await browserExtensions.installFromStore(id);
      return { ok: true, id: extension.id, name: extension.name, version: extension.version };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  registerTerminalDomain(deps, terminals);
  registerLoopDomain(deps, loopRuntime);
  registerAskDomain(deps, askBus);
  // 浮层域：ui:openPopover/closePopover/popoverAction（仅主窗口可打开；动作转发主窗口执行）
  registerChromePopoverDomain(
    { ...deps, push: pushToRenderer, getMainWebContentsId: () => mainWindow?.webContents.id ?? null },
    chromePopover,
  );
  // Agent 会话栏独立窗口域：ui:openAgentWindow 仅主窗口可调；用户关窗 → push chrome:agentWindowClosed
  registerAgentWindowDomain(
    { ...deps, push: pushToRenderer, getMainWebContentsId: () => mainWindow?.webContents.id ?? null },
    agentWindowManager,
  );
  // /compact：真实压缩并写回持久化（预览/应用由 UI 决定；生成中拒绝，避免与落盘竞态）
  registerCompactDomain({
    ...deps,
    sessions,
    push: pushToRenderer,
    getContextWindow: () => {
      const active = providers.active();
      const spec = active?.models?.find((m) => m.id === active.model);
      return spec?.contextWindow;
    },
  });
  /**
   * 应用级提示：独立透明子窗口，压在原生网页之上（DOM 提示会被 WebContentsView 盖住）。
   * 以主窗口内容区为基准「下方居中」；定时自动隐藏，点击穿透。
   */
  const toastWindow = createToastWindow({
    createWindow: (options) =>
      new BrowserWindow({
        ...(options as ConstructorParameters<typeof BrowserWindow>[0]),
        parent: mainWindow ?? undefined,
      }),
    getAnchor: () => {
      if (!mainWindow || mainWindow.isDestroyed()) return null;
      const bounds = mainWindow.getContentBounds();
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    },
  });
  mainWindow?.once("closed", () => toastWindow.destroy());
  registerToastDomain({ ...deps, showToast: (text, sticky) => toastWindow.show(text, sticky) });

  /**
   * Agent 虚拟指针：透明、不可聚焦、点击穿透的覆盖窗口，严丝合缝盖在网页视图上。
   * 用户要求（m02991）：把网页当屏幕，光标是最上层的「Agent 的鼠标」，由应用绘制。
   */
  // 空闲隐藏时长可调：E2E 取证时保持光标可见（默认 1.6s 足够看完一次动作）。
  const pointerIdleMs = Number(process.env.LOOPSOAR_POINTER_IDLE_MS ?? "");
  agentPointer = createAgentPointerWindow({
    ...(Number.isFinite(pointerIdleMs) && pointerIdleMs > 0 ? { idleHideMs: pointerIdleMs } : {}),
    createWindow: (options) =>
      new BrowserWindow({
        ...(options as ConstructorParameters<typeof BrowserWindow>[0]),
        parent: mainWindow ?? undefined,
      }),
  });
  mainWindow?.once("closed", () => {
    agentPointer?.destroy();
    agentPointer = null;
  });
  // 初始化对齐：页面在启动恢复时可能已经可见（此时还没有任何 Agent 动作，窗口保持懒创建）。
  syncPointerArea();

  registerBookmarksDomain(deps, bookmarks);
  registerPageSaveDomain({
    ...deps,
    browser: browserHost ?? undefined,
    dataDir: dirs.dataDir,
    // 下载目录随时可在设置里改：执行时读最新偏好
    downloadDir: () => loadPreferences(dirs.configDir).downloadDir ?? "",
  });
  // 扩展运行时：每个启用扩展一个隔离子进程，工具桥接为 ext__<id>__<tool>
  const extensionRuntime = new ExtensionRuntime({
    extensions,
    registry,
    workerPath: resolveWorkerPath(__dirname),
    onUpdate: (id, status) => pushToRenderer("extensions:updated", { id, runtime: status }),
    onToolsChanged: () => sandbox.syncKnownTools(registry.list().map((t) => t.name)),
  });
  // 注：扩展子进程启动、MCP 自动连接、浏览器历史补记都在首帧后的 runDeferredBootTasks 里执行（见下）。

  registerExtensionsDomain({
    ...deps,
    extensions,
    extensionStatus: () => extensionRuntime.statuses(),
    startExtension: (id) => extensionRuntime.start(id),
    stopExtension: (id) => extensionRuntime.stop(id),
    push: pushToRenderer,
    openExtensionsDir: async () => {
      const error = await openDirectoryNative(extensions.dirPath());
      if (error) console.log(`[Loopsoar] 打开扩展目录失败：${error}`);
      return error === "";
    },
  });
  registerSkillsDomain({
    ...deps,
    skills,
    push: pushToRenderer,
    openSkillsDir: async () => {
      const error = await openDirectoryNative(skills.dirPath());
      if (error) console.log(`[Loopsoar] 打开技能目录失败：${error}`);
      return error === "";
    },
  });
  // 图片域：读取（附件缩略图）+ 剪贴板图片落盘（写 <dataDir>/pasted-images/）
  registerFsDomain({ ...deps, dataDir: dirs.dataDir });
  registerMcpDomain({
    ...deps,
    mcp,
    push: pushToRenderer,
    mcpConfigPath: path.join(dirs.dataDir, "mcp.json"),
  });
  // 自动连接启用的 MCP 移到首帧后（connect 会 spawn 子进程并做 stdio 握手，见 runDeferredBootTasks）
  registerWindowDomain({
    ...deps,
    windowControls: {
      minimize: () => mainWindow?.minimize(),
      toggleMaximize: () => {
        if (!mainWindow) return;
        if (mainWindow.isMaximized()) mainWindow.unmaximize();
        else mainWindow.maximize();
      },
      close: () => {
        const win = mainWindow;
        if (!win || win.isDestroyed()) return;
        try {
          win.close();
        } catch (err) {
          console.warn("[Loopsoar] 关闭主窗口失败，改为强制销毁：", err instanceof Error ? err.message : err);
          win.destroy();
          return;
        }
        // 兜底：若某次 close 被渲染层卸载钩子/浮层窗口拖住而未真正销毁，800ms 后强制销毁，
        // 保证右上角退出键不会「点了没反应」（用户 m05586 反馈的老问题）。
        setTimeout(() => {
          if (!win.isDestroyed()) {
            console.warn("[Loopsoar] 主窗口关闭未生效，强制销毁");
            win.destroy();
          }
        }, 800).unref?.();
      },
      isMaximized: () => mainWindow?.isMaximized() ?? false,
      isFocused: () => mainWindow?.isFocused() ?? false,
    },
  });

  // 退出清理装配（P0）：子进程/终端/落盘/审计全部收尾后再退出
  shutdownHandler = createShutdownHandler({
    // 生成中的回复先落盘（退出瞬间已流出的正文不能丢，否则重启后像「回复截断」）
    flushActiveStreams: () => {
      flushActivePartials((sessionId, text) => {
        try {
          sessions.appendAssistantPartial(sessionId, text);
        } catch (err) {
          console.warn("[Loopsoar] 退出时保存部分回复失败（已忽略）：", err);
        }
      });
    },
    saveBrowserStates: saveAllBrowserStates,
    shutdownMcp: () => mcp.shutdown(),
    stopExtensions: () => extensionRuntime.stopAll(),
    closeTerminals: () => {
      terminals.closeAll();
      askBus.clearAll("应用退出，按取消处理");
      chromePopover.dispose();
      agentWindow?.dispose();
    },
    flushAudit: () => (auditFile ? auditFile.flush() : Promise.resolve()),
  });

  bootTrace.mark("ipc-domains");

  /**
   * 首帧后启动的非关键任务（不参与首屏）：
   *   · MCP 自动连接：每个 server 一次 spawn + stdio JSON-RPC 握手，放在首帧前与渲染进程抢 CPU/IO（实测用户数据里 mcp.json 有 1 个 enabled server）；
   *   · 浏览器历史补记：标签恢复后的一次同步 JSON 落盘（browser-history.json 上限 500 条）；
   *   · 扩展子进程：保留原来的 500ms 延迟，但从首帧起算，避免启动瞬间连续 spawn 多个 Node 进程。
   */
  let deferredBootStarted = false;
  const runDeferredBootTasks = (): void => {
    if (deferredBootStarted) return;
    deferredBootStarted = true;
    bootTrace.mark("deferred-boot:start");
    // 全局历史补记：会话恢复被有意设计为「不计访问」（否则每次重启都把旧页面算成新访问），
    // 但全局历史面板只读 browser-history.json —— 不补记的话老用户升级后看到的是空面板（用户反馈）。
    // backfill 只补缺失 URL（visitedAt=启动时刻、visitCount=1）；已存在条目不改计数/排序，只按需补标题。
    if (bootBrowserState && bootBrowserState.tabs.length > 0) {
      const backfill = browserHistory.backfill(bootBrowserState.tabs);
      if (backfill.added > 0 || backfill.merged > 0 || backfill.skipped > 0) {
        console.log(`[Loopsoar] 浏览器历史补记 ${JSON.stringify(backfill)}`);
      }
    }
    // 自动连接启用的 MCP（失败不阻断启动；UI 里可重试）
    for (const srv of mcp.list()) {
      if (srv.enabled && srv.state === "idle") void mcp.connect(srv.id).catch(() => undefined);
    }
    setTimeout(() => {
      void extensionRuntime.startEnabled().catch(() => undefined);
    }, 500);
  };
  deferredBootTasks = runDeferredBootTasks;
  // 兜底：窗口加载失败等情况下 ready-to-show 可能不触发，3s 后仍要跑（否则 MCP/扩展永远不启动）
  setTimeout(() => deferredBootTasks?.(), 3000);

  // 移除原生菜单栏（File/Edit/View/Window）——品牌统一由自定义标题栏承载
  Menu.setApplicationMenu(null);

  createMainWindow();
  bootTrace.mark("window-created");
  // 启动恢复发生在 createMainWindow 之前：当时 attachView 拿不到主窗口（返回 false 跳过挂载），
  // 窗口创建后立刻重排一次，让恢复出来的原生网页视图补挂并设置 bounds/可见性。
  // 幂等：已挂上的视图不会重复挂载；没有标签页时只是一次空布局。
  browserHost?.syncBounds();
  bootTrace.mark("window-sync-bounds");
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
  } catch (err) {
    // 启动失败必须「可见地失败」：打印原因并退出，绝不挂起成无窗口进程
    console.error("[Loopsoar] 启动失败：", err);
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

export { getHandlerRegistry, handleTrusted } from "./trustedIpc.js";
