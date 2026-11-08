/**
 * Loopsoar 主进程入口。
 * 允许 import electron 的文件只有两个：本文件与 main/electronBrowser.ts（薄适配层）。
 * 职责：协议注册 → 数据目录 → 域装配（受信 IPC）→ 窗口创建 → 浏览器宿主挂载。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, safeStorage, screen, shell } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHANNEL_BINDINGS, EVENTS } from "loopsoar-contracts/schemas";
import { renderHeaderTemplates } from "loopsoar-contracts/headerTemplate";
import { createNodePlatform } from "loopsoar-core/platform";
import { ToolRegistry } from "loopsoar-core/tools/registry";
import { registerBuiltinMinimal } from "loopsoar-core/tools/builtin";
import { SandboxManager } from "loopsoar-core/sandbox";
import { ChatService } from "loopsoar-services/chat";
import { createAnthropicClient, createOpenAiClient, inferApiFormat, type LlmClient } from "loopsoar-core/llm";
import { AgentRegistry, BUILTIN_AGENT } from "loopsoar-core/agent";
import { resolveApiKeyFromEnv, providerUsability } from "loopsoar-core/provider";
import { loadPreferences, loadPermissions } from "./domains/settings.js";
import { resolveDataDir } from "./dataDir.js";
import { APP_NAME, PROTOCOL } from "../shared/brand.js";
import { handleTrusted, type AuditEntry, type TrustedIpcDeps } from "./trustedIpc.js";
import {
  createBootTrace,
  ensureLoopsoarDirs,
  makePlaceholderProtocolHandler,
  makeUiProtocolHandler,
} from "./boot.js";
import { resolveUiDistDir, uiDistCandidates } from "./uiProtocol.js";
import { createElectronBrowserHost, DownloadsBridge } from "./electronBrowser.js";
import { withProviderDefaults } from "./providerDefaults.js";
import { createDebouncedRunner, type BrowserHost } from "./browserHost.js";
import { BrowserHistoryStore } from "./browserHistoryStore.js";
import type { PersistedBrowserState } from "./browserSessionState.js";
import { registerRuntimeDomain } from "./domains/runtime.js";
import { registerWorkspaceDomain } from "./domains/workspace.js";
import { registerAgentsDomain } from "./domains/agents.js";
import { registerChatDomain } from "./domains/chat.js";
import { registerCompactDomain } from "./domains/compact.js";
import { registerBrowserDomain } from "./domains/browserAdapter.js";
import { registerWindowDomain } from "./domains/window.js";
import {
  loadProviderConfig,
  registerSettingsDomain,
  currentRulesPrompt,
  savePreferencesPatch,
} from "./domains/settings.js";
import { registerMemoryTools } from "./memoryTools.js";
import { registerSearchTools } from "./searchTools.js";
import {
  createFallbackLlmClient,
  createModelRouterForTargets,
  type FallbackLlmTarget,
} from "./routerLlm.js";
import { createLoopRuntime } from "./loopRuntime.js";
import { registerLoopDomain } from "./domains/loop.js";
import { AskBus } from "./askBus.js";
import { registerAskDomain } from "./domains/ask.js";
import { registerAskTools } from "./askTools.js";
import { BookmarksStore } from "./bookmarksStore.js";
import { registerBookmarksDomain } from "./domains/bookmarks.js";
import { registerPageSaveDomain } from "./domains/pageSave.js";
import { registerMemoryDomain } from "./domains/memory.js";
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
import { registerExtensionsDomain } from "./domains/extensions.js";
import { createChromePopoverManager } from "./chromePopover.js";
import { registerChromePopoverDomain } from "./domains/chromePopover.js";
import { createAgentWindowManager, type AgentWindowManager } from "./agentWindow.js";
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
// 首帧后启动的非关键任务（main() 内装配；createMainWindow 的 ready-to-show 回调里触发）
let deferredBootTasks: (() => void) | null = null;
// Agent 会话栏独立窗口管理器（main() 内创建；createMainWindow 的 closed 回调需在模块作用域访问）
let agentWindow: AgentWindowManager | null = null;

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

function iconPath(): string | undefined {
  const candidate = path.join(__dirname, "../../resources/icon.png");
  return fs.existsSync(candidate) ? candidate : undefined;
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

          // E2E：整屏截图（用于验证独立浮层窗口真实浮在网页之上）
          if (process.env.LOOPSOAR_E2E_DESKTOP_SHOT) {
            const { desktopCapturer } = await import("electron");
            try {
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
            if (others[0]) {
              const agentWin = others[0];
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

          // 整窗截图：优先 BrowserWindow.capturePage（含子视图合成），否则退回 webContents
          const anyWin = win as unknown as { capturePage?: () => Promise<{ toPNG(): Buffer }> };
          const image =
            typeof anyWin.capturePage === "function"
              ? await anyWin.capturePage()
              : await win.webContents.capturePage();
          fs.mkdirSync(path.dirname(shotPath), { recursive: true });
          fs.writeFileSync(shotPath, image.toPNG());
          console.log(`GUI_SHOT_SAVED ${shotPath}`);

          // 原生浏览器视图单独截图（Electron 的窗口截图不含子视图；受限会话下可能拿不到合成层，失败不中断）
          if (navUrl && browserHost) {
            try {
              const base64 = await browserHost.screenshot();
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

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    title: APP_NAME,
    icon: iconPath(),
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
    // 独立 Agent 窗口若常驻，主窗口关掉后 window-all-closed 不会触发，进程会残留成“只有小窗”
    // 主窗口销毁场景不需要滑出动画（目标屏幕/工作区可能已不可用），立即关闭。
    agentWindow?.close({ animate: false });
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
  scheduleE2ELiveTool(mainWindow);
  scheduleE2EPlanDemo(mainWindow);
  scheduleE2ESteerDemo(mainWindow);
  scheduleE2ESearchDemo(mainWindow);
  scheduleE2EDemoChat(mainWindow);
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

app.whenReady().then(async () => {
  bootTrace.mark("whenReady");
  try {
    const dirs = ensureWritableDataDirs();
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

  // 多供应商：providers.json（兼容旧 provider.json 自动迁移）
  const providers = new ProviderStore(dirs.configDir);
  const legacyProvider = await loadProviderConfig(platform, dirs.configDir);
  if (providers.list().length === 0 && legacyProvider) {
    const item = providers.upsert(legacyProvider);
    providers.setActive(item.id);
  }
  // 加密密钥库：OS 密钥库优先；不可用时降级 AES（.secret.key 0600）
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

  // 多供应商降级链（模型路由）：active 最高优先级，其余按配置顺序；冷却状态挂在 router 上跨请求复用。
  let llmRouter = createModelRouterForTargets([]);
  const buildLlmTargets = (sessionId?: string): FallbackLlmTarget[] => {
    const activeId = providers.active()?.id;
    return providers
      .list()
      .map((item, index) => {
        if (!resolveProviderKey(item.id)) return null;
        return {
          id: item.id,
          provider: item.provider,
          model: item.model,
          priority: item.id === activeId ? 100 : Math.max(1, 50 - index),
          roles: ["chat"],
          build: () => {
            const client = buildLlmForProvider(item, sessionId);
            if (!client) throw new Error(`供应商 ${item.provider} 未配置密钥`);
            return client;
          },
        } satisfies FallbackLlmTarget;
      })
      .filter((target): target is FallbackLlmTarget => target !== null);
  };
  const rebuildLlmRouter = (): void => {
    llmRouter = createModelRouterForTargets(buildLlmTargets());
  };
  const buildLlmFromActive = (sessionId?: string): LlmClient | undefined => {
    const targets = buildLlmTargets(sessionId);
    if (targets.length === 0) return undefined;
    if (targets.length === 1) return targets[0].build();
    return createFallbackLlmClient({ targets, router: llmRouter });
  };
  // 惰性引用：供应商增删改/切换活跃后立即生效（无需重启）
  rebuildLlmRouter();
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
  const settingsDeps = {
    ...deps,
    platform,
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
      rebuildLlmRouter();
      llmRef = buildLlmFromActive();
    },
    onProviderCleared: () => {
      rebuildLlmRouter();
      llmRef = buildLlmFromActive();
    },
    onProviderSaved: () => {
      rebuildLlmRouter();
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
  const chatService = new ChatService({
    platform,
    registry,
    sandbox,
    // Agent-Loop 可插拔：统一经 LoopRegistry 运行（内置 loop 失败自动回退安全模式）
    runLoop: (input) => loopRuntime.run(input),
    agent: defaultAgent ? { name: defaultAgent.name, role: defaultAgent.role } : undefined,
    toolAllowlist: defaultAgent?.toolAllowlist,
    // 规则文件（AGENTS.md）：每次 stream 重新读取，设置面板保存后即时生效
    getSystemRules: () => currentRulesPrompt(settingsDeps),
    // 记忆召回：按当前消息取相关条目，注入 volatile 段
    getMemoryFor: (text: string) => memory.recallPrompt(text),
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
    // 模式：plan=只读规划（仅放行只读工具）；build=默认 Agent 白名单
    getToolAllowlist: (mode?: "build" | "plan") => {
      if (mode === "plan") {
        return registry
          .list()
          .filter((t) => t.permissions.read && !t.permissions.write && !t.permissions.terminal && !t.permissions.network)
          .map((t) => t.name);
      }
      return defaultAgent?.toolAllowlist;
    },
    // 权限确认 → 推送到渲染层弹窗（perm:request 事件）
    onPermissionRequest: (request) => pushToRenderer("perm:request", request),
  });
  bootTrace.mark("chat-service");

  // 浏览器宿主：会话级标签组；WebContentsView 懒创建 + 布局对齐（electron 细节封装在 electronBrowser.ts）
  // 初始会话 = 最近一次使用的会话（重启后左右两侧一起恢复）；没有会话时建一个，保证"文件夹"存在。
  const initialSessionId = sessions.currentId() ?? sessions.newSession().sessionId;
  // 启动即把当前会话补绑活动工作区（旧会话/首启会话都落进"文件夹"）
  if (!sessions.get(initialSessionId)?.workspaceId && workspaces.activeId()) {
    sessions.setWorkspaceId(initialSessionId, workspaces.activeId());
  }
  const tabSaveTimers = new Map<string, NodeJS.Timeout>();
  const queueBrowserStateSave = (sessionId: string, state: PersistedBrowserState): void => {
    const prev = tabSaveTimers.get(sessionId);
    if (prev) clearTimeout(prev);
    tabSaveTimers.set(
      sessionId,
      setTimeout(() => {
        tabSaveTimers.delete(sessionId);
        sessions.saveBrowserState(sessionId, state);
      }, 400),
    );
  };
  // 全局浏览器历史（跨标签/跨会话共享）：持久化 <dataDir>/browser-history.json；
  // 上限 500、按 URL 去重合并；每次成功访问即原子落盘（退出前无需额外 flush）。
  const browserHistory = new BrowserHistoryStore(path.join(dirs.dataDir, "browser-history.json"));
  // 浏览器工具栏浮层：独立子窗口渲染（天然浮在原生网页视图之上，不再需要隐藏网页）
  const chromePopover = createChromePopoverManager({
    getMainWindow: () => mainWindow,
    loadUrlFor: (kind, lang) =>
      `${PROTOCOL}://app/index.html?popover=${kind}${lang ? `&lang=${encodeURIComponent(lang)}` : ""}`,
    preloadPath: preloadPath(),
    additionalArguments: [
      `--loopsoar-bindings=${JSON.stringify(buildBindings())}`,
      `--loopsoar-events=${JSON.stringify(EVENTS)}`,
    ],
  });
  // Agent 会话栏「独立窗口」（真·窗口化）：无 parent 的顶层系统窗口，可拖动/缩放/最小化/贴边，
  // 主窗口隐藏侧栏、网页铺满；与 chromePopover（悬停浮层子窗口）刻意区分，不要合并。
  const agentWindowManager = createAgentWindowManager({
    loadUrlFor: (sessionId) =>
      `${PROTOCOL}://app/index.html?mini=1${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`,
    preloadPath: preloadPath(),
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
  browserHost = createElectronBrowserHost(
    () => mainWindow,
    (url) => {
      // 只把真实网页转为新标签：about:blank/空地址等（弹窗占位）直接忽略，避免凭空多出「新标签页」
      if (!/^https?:\/\//i.test(url)) return;
      void browserHost?.newTab(url);
    },
    {
      initialSessionId,
      onSessionStateChanged: queueBrowserStateSave,
      // 成功访问（应用内导航/网页内跳转/新标签首屏）→ 追加全局历史
      onVisited: (visit) => {
        browserHistory.record(visit);
      },
      // 标题迟到 → 刷新同 URL 条目标题（不新增访问）
      onTitleChanged: (url, title) => {
        browserHistory.updateTitle(url, title);
      },
      // 广告/追踪拦截开关跟随偏好（默认开；设置里改动即时生效）
      isAdBlockEnabled: () => loadPreferences(dirs.configDir).adBlockEnabled ?? true,
    },
  );
  // 启动即恢复当前会话上次的网页（标题/URL/活动标签）
  const bootBrowserState = sessions.getBrowserState(initialSessionId);
  if (bootBrowserState) {
    void browserHost
      .switchSession(initialSessionId, bootBrowserState)
      .then((tabs) => pushToRenderer("browser:tabs", { tabs }))
      .catch(() => undefined);
  }
  bootTrace.mark("browser-host");
  // 注：全局历史补记（browser-history.json 的同步落盘）已移到首帧后的 deferred 启动任务里，见 runDeferredBootTasks。
  // Agent 浏览器工具（快照/导航/点击/输入/滚动/抓取）：在浏览器宿主创建后注册
  registerBrowserTools(registry, () => browserHost, resolveSessionRoot);
  registerTerminalTools(registry, resolveSessionRoot);
  registerPlanTools(registry);
  registerFileTools(registry, resolveSessionRoot);
  // 记忆工具（设置·记忆同源数据）：读工具 plan 可用，写工具按 sandbox L2 确认
  registerMemoryTools(registry, memory);
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
      if (state && state.tabs.length > 0) sessions.saveBrowserState(meta.id, state);
    }
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
  registerChatDomain({
    ...deps,
    chatService,
    push: pushToRenderer,
    memory,
    sessions,
    shouldAutoCapture: () => loadPreferences(dirs.configDir).memoryAutoCapture,
    getActiveWorkspaceId: () => workspaces.activeId(),
    // 本轮回复模型快照（会话持久化用，历史悬停显示真实模型）
    getModelInfo: () => {
      const active = providers.active();
      return active ? { provider: active.provider, model: active.model } : undefined;
    },
    // 会话即浏览器"文件夹"：切会话 = 切左侧标签组；先由 host 保存旧会话状态，再恢复目标会话
    onSessionOpened: async (sessionId) => {
      // 旧会话补绑工作区：首次打开时归属当前活动工作区
      const sessionData = sessions.get(sessionId);
      if (!sessionData?.workspaceId && workspaces.activeId()) {
        sessions.setWorkspaceId(sessionId, workspaces.activeId());
      }
      // 当前会话的工作区成为活动工作区：新会话默认落在同一"文件夹"
      const boundWorkspaceId = sessions.get(sessionId)?.workspaceId;
      if (boundWorkspaceId && workspaces.activeId() !== boundWorkspaceId) {
        workspaces.select(boundWorkspaceId);
      }
      if (!browserHost) return;
      const tabs = await browserHost.switchSession(sessionId, sessions.getBrowserState(sessionId) ?? undefined);
      pushToRenderer("browser:tabs", { tabs });
    },
    onSessionDeleting: async (sessionId) => {
      terminals.closeSession(sessionId);
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
      if (!browserHost) return;
      await browserHost.deleteSession(sessionId).catch(() => undefined);
      if (nextSessionId) {
        await browserHost
          .switchSession(nextSessionId, sessions.getBrowserState(nextSessionId) ?? undefined)
          .catch(() => undefined);
      }
      pushToRenderer("browser:tabs", { tabs: browserHost.listTabs() });
    },
  });
  registerMemoryDomain({ ...deps, memory, push: pushToRenderer });
  registerBrowserDomain({ ...deps, browser: browserHost, downloads, history: browserHistory });
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
      close: () => mainWindow?.close(),
      isMaximized: () => mainWindow?.isMaximized() ?? false,
      isFocused: () => mainWindow?.isFocused() ?? false,
    },
  });

  // 退出清理装配（P0）：子进程/终端/落盘/审计全部收尾后再退出
  shutdownHandler = createShutdownHandler({
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
