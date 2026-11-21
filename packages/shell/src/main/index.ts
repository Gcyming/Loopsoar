// Loopsoar 主进程入口：协议注册 → 数据目录 → 域装配（受信 IPC）→ 窗口创建 → 浏览器宿主挂载。
import { randomUUID } from "node:crypto";
import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, safeStorage, screen, session, shell } from "electron";
import fs from "node:fs";
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
import { APP_ID, APP_NAME, APP_VERSION, PROTOCOL } from "../shared/brand.js";
import { type AuditEntry, type TrustedIpcDeps } from "./trustedIpc.js";
import { createBootTrace, ensureLoopsoarDirs, installUiProtocol } from "./boot.js";
import { resolveUiDistDir, uiDistCandidates } from "./uiProtocol.js";
import { createCoreServices } from "./coreServices.js";
import { TaskForkCoordinator } from "./taskForks.js";
import { iconPath, preloadPath, openDirectoryNative } from "./mainPaths.js";
import { ensureWritableDataDirs } from "./dataDir.js";
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
import { flushActivePartials, hasActiveStreams, registerChatDomain } from "./domains/chat.js";
import { registerToastDomain } from "./domains/toast.js";
import { createToastWindow } from "./toastWindow.js";
import { createAgentPointerWindow, pointerScreenArea, type AgentPointerController } from "./agentPointerWindow.js";
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
import { createScheduledTaskRuntime } from "./scheduledTaskRuntime.js";
import { showDesktopNotification } from "./desktopNotify.js";
import { ensureSingleInstance } from "./singleInstance.js";
import { createBrowserExternalLinks } from "./browserExternalLinks.js";
import { createRendererPusher } from "./rendererBus.js";
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
import { maybeAutoSkillCandidate } from "./skillAutoCapture.js";
import { McpHost } from "./mcpHost.js";
import { registerBrowserTools } from "./browserTools.js";
import { registerBrowserDataRuntime } from "./browserDataRuntime.js";
import { instrumentBrowserActivity } from "./browserActivity.js";
import { createCdpBrowserBackendFromEnv, type CdpBrowserBackend } from "./cdpBrowserBackend.js";
import { registerTerminalTools } from "./terminalTools.js";
import { registerPlanTools } from "./planTools.js";
import { registerFileTools } from "./fileTools.js";
import { closeTurn, createRunStores } from "./runStores.js";
import { registerTraceTools } from "./traceTools.js";
import { BackgroundTaskManager, registerBackgroundTerminalTools } from "./backgroundTasks.js";
import { registerDocumentTools } from "./documentTools.js";
import { registerPdfTools } from "./pdfTools.js";
import { registerOfficeTools } from "./officeTools.js";
import { registerOfficeConvertTools } from "./officeConvert.js";
import { registerSkillTools } from "./skillTools.js";
import { createChatSubagentRunner, registerSubagentTools } from "./subagentTools.js";
import { SubagentTaskStore } from "./subagentTaskStore.js";
import { createChromePopoverManager } from "./chromePopover.js";
import { registerChromePopoverDomain } from "./domains/chromePopover.js";
import { createAgentWindowManager, type AgentWindowManager } from "./agentWindow.js";
import { createE2eHooks } from "./e2eHooks.js";
import { createMainWindowWindow } from "./mainWindowFactory.js";
import { registerAgentWindowDomain } from "./domains/agentWindow.js";
import { ExtensionRuntime, resolveWorkerPath } from "./extensionRuntime.js";
import { createExtensionAgentHooks } from "./extensionAgentHooks.js";
import { registerExtensionWiring } from "./extensionWiring.js";
import { pickExtensionSource } from "./extensionPicker.js";
import { EXTENSION_UI_SCHEME, makeExtensionProtocolHandler } from "./extensionProtocol.js";
import { registerSkillsDomain } from "./domains/skills.js";
import { registerMcpDomain } from "./domains/mcp.js";
import { registerFsDomain } from "./domains/fs.js";
import { registerTerminalDomain } from "./domains/terminal.js";
import { TerminalSessionManager } from "./terminalSession.js";
import { AuditFileLogger } from "./auditFile.js";
import { redactDeep } from "./logRedaction.js";
import { runUpgradeBackupSafe } from "./dataBackup.js";
import { installMainLogIfPackaged } from "./mainLog.js";
import { createCrashLog } from "./crashLog.js";
import { installQuitGuard, quitConfirmOptions } from "./quitGuard.js";
import { createShutdownHandler } from "./shutdown.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 启动链路计时：LOOPSOAR_BOOT_TRACE=1 时打印各阶段耗时（默认关闭，无开销）。 */
const bootTrace = createBootTrace();

// 自定义协议必须声明为 standard + secure，相对路径资源与 fetch 才能按网页语义工作。
// 必须在 app ready 之前调用（Electron 要求），因此放在模块顶层。
protocol.registerSchemesAsPrivileged([
  { scheme: PROTOCOL, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  // 扩展富 UI：与主界面不同 origin；只读扩展目录，CSP 在处理器里逐响应注入。
  { scheme: EXTENSION_UI_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false } },
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

const pushToRenderer = createRendererPusher(() => BrowserWindow.getAllWindows());
let mainWindow: BrowserWindow | null = null;
let browserHost: BrowserHost | null = null;
const browserLinks = createBrowserExternalLinks({
  appName: APP_NAME, executablePath: process.env.APPIMAGE ?? process.execPath, appPath: app.isPackaged ? null : process.argv.find((arg) => /main(?:\.bundle)?\.mjs$|main[\\/]index\.js$/.test(arg)) ?? null,
  packaged: app.isPackaged, initialArgv: process.argv, userTabsSession: USER_TABS_SESSION,
  getBrowserHost: () => browserHost, getMainWindow: () => mainWindow, ensureWindow: () => { if (!mainWindow) createMainWindow(); return mainWindow; },
});
/** 远端 CDP 浏览器后端（仅显式设置 LOOPSOAR_BROWSER_CDP_ENDPOINT 时存在；不接管原生标签 UI）。 */
let remoteBrowserBackend: CdpBrowserBackend | null = null;
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

/** 把覆盖指针贴到网页视图上（几何换算见 pointerScreenArea）。 */
function syncPointerArea(): void {
  if (!agentPointer) return;
  const content = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getContentBounds() : null;
  agentPointer.setArea(pointerScreenArea(content, lastViewRect));
}
const schedulePointerAreaSync = createDebouncedRunner(syncPointerArea, 16);

/** 退出清理：MCP/扩展/终端/标签落盘/审计收尾；先 preventDefault，清理完再 app.exit（幂等）。 */
let shutdownHandler: (() => Promise<void>) | null = null;
installQuitGuard({
  registerBeforeQuit: (listener) => app.on("before-quit", listener),
  hasActiveStreams,
  isAutomated: () => Object.keys(process.env).some((key) => key.startsWith("LOOPSOAR_E2E")),
  confirmQuit: () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
    const options = quitConfirmOptions();
    const choice =
      mainWindow && !mainWindow.isDestroyed()
        ? dialog.showMessageBoxSync(mainWindow, options)
        : dialog.showMessageBoxSync(options);
    return choice === 1;
  },
  shutdown: () => shutdownHandler?.() ?? Promise.resolve(),
  exit: (code) => app.exit(code),
});


const e2eHooks = createE2eHooks({
  getBrowserHost: () => browserHost,
  getBrowserExtensionsHost: () => browserExtensionsHost,
  getAgentWindow: () => agentWindow,
  getMainWindow: () => mainWindow,
  pushToRenderer,
});

function createMainWindow(): void {
  mainWindow = createMainWindowWindow({
    appName: APP_NAME,
    protocol: PROTOCOL,
    events: EVENTS,
    bindings: buildBindings,
    iconPath,
    preloadPath,
    bootTrace,
    deferredBootTasks: () => deferredBootTasks?.(),
    getBrowserHost: () => browserHost,
    getAgentWindow: () => agentWindow,
    disposeDevTools: () => devToolsPanel?.dispose(),
    syncPointerArea: () => schedulePointerAreaSync.schedule(),
    cancelPointerAreaSync: () => schedulePointerAreaSync.cancel(),
    onClosed: () => {
      mainWindow = null;
    },
    e2eHooks,
    getCloseBehavior: () => loadPreferences(ensureWritableDataDirs(app, { allowCwdFallback: !app.isPackaged }).configDir).closeBehavior ?? "quit", onOpenSchedules: () => { pushToRenderer("ui:openSettings", { section: "schedules" }); mainWindow?.show(); mainWindow?.focus(); },
  });
}

// Chromium 原生 UI 语言跟随设置；--lang 必须在 app ready 之前设置，运行时切换下次启动生效。
try {
  const preDirs = ensureWritableDataDirs(app, { allowCwdFallback: !app.isPackaged });
  const language = loadPreferences(preDirs.configDir).language;
  app.commandLine.appendSwitch("lang", language);
  // Windows 原生遮挡检测会把「被其它窗口盖住」的网页标记为 hidden，Chromium 随即丢弃注入的
  // 输入事件（Agent 点击/按键会静默失效）。浏览器自动化要求网页在后台仍可交互，关掉该特性。
  // 只影响本应用的页面可见性判定，不改变用户看到的窗口行为。
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
} catch (err) {
  console.warn("[Loopsoar] 设置 Chromium 语言失败", err instanceof Error ? err.message : String(err));
}

ensureSingleInstance(app, (argv) => { browserLinks.acceptArgs(argv); mainWindow?.show(); mainWindow?.focus(); });
// macOS 的默认浏览器入口走 open-url；Windows/Linux 走 argv + second-instance。
app.on("open-url", (event, url) => { event.preventDefault(); browserLinks.acceptUrl(url); });

app.whenReady().then(async () => {
  bootTrace.mark("whenReady");
  try {
    const dirs = ensureWritableDataDirs(app, { allowCwdFallback: !app.isPackaged });
    // 安装包没有控制台：把 error/warn 同时写 <dataDir>/logs/main.log（5MB 轮转）。
    installMainLogIfPackaged(dirs.dataDir, app.isPackaged);
    // 升级前自动备份：版本号变化才执行；失败只记录，不阻断启动。
    runUpgradeBackupSafe(dirs.dataDir, APP_VERSION);
    const stores = createRunStores(dirs.dataDir);
    // 后台任务：应用退出时统一杀进程树，避免留下孤儿构建/dev server。
    const backgroundTasks = new BackgroundTaskManager();
    app.on("will-quit", () => backgroundTasks.killAll());
  // 崩溃取证：原生 AV 进程直接退出，JS 抓不到；先把可捕获的进程/渲染器死亡与未处理异常写盘。
  const crashLog = createCrashLog({
    dataDir: dirs.dataDir,
    version: APP_VERSION,
    versions: process.versions,
    platform: process.platform,
    arch: process.arch,
  });
  const writeCrashLog = (kind: string, detail: unknown): void => {
    crashLog.write(kind, detail);
    console.error("[Loopsoar]", kind, redactDeep(detail));
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
  const uiDist = resolveUiDistDir(uiDistCandidates(__dirname, process.cwd(), process.resourcesPath));
  installUiProtocol({
    protocol: PROTOCOL,
    distDir: uiDist,
    handle: (scheme, handler) => protocol.handle(scheme, handler),
    warn: (message) => console.warn(message),
  });
  bootTrace.mark("protocol+ui-dist");

  const core = await createCoreServices({ dirs, appVersion: APP_VERSION, bootTrace, pushToRenderer, safeStorage });
  const {
    platform,
    registry,
    sandbox,
    secrets,
    providers,
    buildLlmFromActive,
    memory,
    askBus,
    loopRuntime,
    sessions,
    workspaces,
    worktreesRoot,
    bookmarks,
    resolveSessionRoot,
    terminals,
    extensions,
    skills,
    subagentTasks,
    mcp,
    agents,
    defaultAgent,
  } = core;
  // 扩展富 UI（沙箱 iframe）：协议处理器只读扩展目录，CSP/realpath 在处理器内校验。
  protocol.handle(EXTENSION_UI_SCHEME, makeExtensionProtocolHandler(extensions));
  let workspaceRoot = core.getWorkspaceRoot();
  let llmRef = buildLlmFromActive();
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
    appVersion: APP_VERSION,
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
  const autoSkillLastAt = new Map<string, number>(); // 自动技能候选：每会话 10 分钟最多一次，避免刷出低质量草稿。
  const AUTO_SKILL_COOLDOWN_MS = 10 * 60 * 1000;
  // 扩展运行时在 chatService 之后装配；用 ref 让扩展事件钩子不必重排启动顺序。
  let extensionRuntimeRef: ExtensionRuntime | undefined;
  const chatService = new ChatService({
    platform,
    registry,
    sandbox,
    loopDebug: process.env.LOOPSOAR_LOOP_DEBUG ? (event, detail) => console.log("[LOOP]", event, detail ?? "") : undefined, // 环境读取留在壳层
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
    ...createExtensionAgentHooks(() => extensionRuntimeRef),
    onToolCall: (toolName: string, sessionId: string) => {
      stores.traces.begin(sessionId, toolName);
      memory.recordToolUsage(toolName, sessionId);
    },
    // 工具失败证据：同一会话同一工具同一错误连续两次才写 lesson（首次是偶发）。
    onToolResult: (event) => {
      stores.traces.observe(event);
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
    // 自动候选：显式开启 + 每会话 10 分钟节流；只写默认禁用的草稿，不影响本轮结果
    onTurnComplete: ({ sessionId, userText, result }) => {
      // 回合结束：关闭当前检查点组（快照保留），落一条 turn trace。
      closeTurn(stores, sessionId, result.usage, result.status, providers.active());
      if (loadPreferences(dirs.configDir).skillAutoCandidate !== true) return;
      const key = sessionId || "default";
      const now = Date.now();
      if (now - (autoSkillLastAt.get(key) ?? 0) < AUTO_SKILL_COOLDOWN_MS) return;
      const candidate = maybeAutoSkillCandidate(
        {
          status: result.status,
          toolCalls: result.usage.toolCalls,
          userText,
          finalText: result.finalText,
        },
        skills,
      );
      if (candidate) {
        autoSkillLastAt.set(key, now);
        // 设置页监听 skills:updated，自动候选无需重开设置即可出现
        pushToRenderer("skills:updated", { action: "auto-candidate", id: candidate.id });
      }
    },
    // 扩展声明式指令：仅启用扩展，注入 volatile 段；不提供工具/代码执行
    getExtensionPrompt: () => extensions.instructionsPrompt(),
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
    // 当前模型最大输出：请求 max_tokens 的唯一来源（Anthropic thinking 预算会据此收敛）
    getMaxOutputTokens: () => {
      const active = providers.active();
      const spec = active?.models?.find((m) => m.id === active.model);
      return spec?.maxOutput;
    },
    // stable 段日志：同输入下必须 changed=false；true 仅表示规则/身份合法变更
    onStableSegment: ({ sessionId, changed, length }) => {
      console.info(`[stable] session=${sessionId} changed=${changed} length=${length}`);
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
    // 模式 × 会话：plan=只读；build=默认 Agent 白名单。再叠加会话级「浏览器控制」：
    // 关闭时剔除 BROWSER_AGENT_TOOLS；这份名单同时决定模型可见面与执行闸（services 只解析一次）。
    getToolAllowlist: (mode?: "build" | "plan", sessionId?: string, userText?: string) => {
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
      const resolved = resolveToolSurface({
        base,
        allNames: registry.list().map((t) => t.name),
        exclude: browserControl ? [] : [...BROWSER_AGENT_TOOLS],
      });
      // 技能声明了 allowed-tools 时再收窄（多个命中技能取并集；未声明不动）。
      return skills.limitToolSurface(userText, resolved);
    },
    onPermissionRequest: (request) => pushToRenderer("perm:request", request),
    onPermissionResolved: (requestId) => pushToRenderer("perm:resolved", { requestId }),
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
  /**
   * 任务分支状态机：把「首次动作 → 回合结束过户 → 崩溃恢复」收进一个所有者。
   * 状态（待分支/分支点/落盘记录/回合起点）不再散落在启动闭包里。
   */
  const taskForks = new TaskForkCoordinator({
    sessions,
    browserStates,
    file: path.join(dirs.dataDir, "pending-task-forks.json"),
    browserHost: () => browserHost,
    push: pushToRenderer,
    cancelStateSave: cancelBrowserStateSave,
    onSourceMoved: (from, to) => {
      if (initialSessionId === from) initialSessionId = to;
    },
  });
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
    loadUrlFor: (kind, lang, params) =>
      `${PROTOCOL}://app/index.html?popover=${kind}${lang ? `&lang=${encodeURIComponent(lang)}` : ""}${params?.tabId ? `&tabId=${encodeURIComponent(params.tabId)}` : ""}`,
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
      // 网页按钮可能默认 target=_blank；必须开在“当前可见会话”，否则在搜索页/用户标签里
      // 新页会落进后台 chat 会话组，用户看到的就是点击没反应。
      void browserHost?.newTabInVisibleSession(url);
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
      onTaskCreated: (sessionId) => taskForks.markBrowserAction(sessionId),
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
  taskForks.recover();

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
  // 远端 CDP 模式：显式 env 时工具面走 CdpBrowserBackend；原生标签 UI 仍由 BrowserHost 提供。
  remoteBrowserBackend = createCdpBrowserBackendFromEnv();
  if (remoteBrowserBackend) console.log(`[Loopsoar] 浏览器工具使用 CDP 后端：${process.env.LOOPSOAR_BROWSER_CDP_ENDPOINT}`);
  registerBrowserTools(registry, () => remoteBrowserBackend ?? browserHost, resolveSessionRoot, {
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
  registerTerminalTools(registry, resolveSessionRoot);
  registerBackgroundTerminalTools(registry, backgroundTasks, resolveSessionRoot);
  registerPlanTools(registry);
  registerFileTools(registry, resolveSessionRoot, stores.checkpoints);
  registerTraceTools(registry, stores.traces);
  registerDocumentTools(registry);
  registerPdfTools(registry);
  registerOfficeTools(registry);
  registerOfficeConvertTools(registry);
  registerSkillTools(registry, skills);
  registerSubagentTools(registry, createChatSubagentRunner(chatService, registry), subagentTasks);
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
  // 注意：sandbox.syncKnownTools 必须放在**全部**工具注册之后（见下方浏览器状态面），
  // 否则后注册的工具会被沙箱判成「未知工具名」——这正是 browser_cookies / downloads /
  // diagnostics / upload 曾经全部失效的根因。
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
    if (userState) {
      browserStates.set(USER_TABS_SESSION, userState);
    }
    browserStates.flush();
  };
  // 下载管理：目录跟随偏好（downloadDir，留空=系统下载目录），变更推送 UI
  const downloads = new DownloadsBridge(
    () => loadPreferences(dirs.configDir).downloadDir ?? "",
    () => pushToRenderer("browser:downloads", { downloads: downloads.list() }),
  );
  registerBrowserDataRuntime(registry, () => browserHost, downloads, resolveSessionRoot, (url: string) => session.fromPartition(SESSION_PARTITION).cookies.get({ url }));
  instrumentBrowserActivity(registry, BROWSER_AGENT_TOOLS, pushToRenderer);
  // 所有工具注册完毕后再同步一次：同步点必须晚于最后一个 register*，否则新工具在沙箱里是「未知工具」。
  sandbox.syncKnownTools(registry.list().map((t) => t.name));
  registerRuntimeDomain(deps);
  registerWorkspaceDomain({
    ...deps,
    openPath: (target: string) => shell.openPath(target),
    workspaces,
    sessions,
    worktreesRoot,
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
  const chatDeps = registerChatDomain({
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
      taskForks.onTurnStarted(sessionId);
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
      taskForks.onTurnSettledStart(sessionId);
      agentTurnSessions.delete(sessionId);
      void browserHost?.lockForSession(sessionId, false).catch(() => undefined);
      if (pointerHeldSession === sessionId) {
        pointerHeldSession = null;
        agentPointer?.hold(false);
      }
      // 首次动作的任务化延迟到回合结束：这时 append 刚把本轮回复写进原会话，
      // 分支能完整带上「Agent 控制发生时的会话阶段」，原会话则恢复为普通讨论。
      // 分支点、过户、落盘、状态搬运全部由 TaskForkCoordinator 负责（见 taskForks.ts）。
      taskForks.settle(sessionId);
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
  createScheduledTaskRuntime({ dataDir: dirs.dataDir, chatDeps, push: pushToRenderer, notify: showDesktopNotification }).start();
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
  registerLoopDomain(deps, loopRuntime, dirs.dataDir);
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
    onViewMessage: (id, viewId, message) => pushToRenderer("extensions:viewMessage", { id, viewId, message }),
  });
  extensionRuntimeRef = extensionRuntime;
  // 注：扩展子进程启动、MCP 自动连接、浏览器历史补记都在首帧后的 runDeferredBootTasks 里执行（见下）。

  registerExtensionWiring({
    deps, extensions, runtime: extensionRuntime, configDir: dirs.configDir,
    push: pushToRenderer, openPath: (target) => shell.openPath(target),
    pickSource: () => pickExtensionSource({ messageBox: (options) => dialog.showMessageBox(mainWindow ?? undefined!, options), openDialog: (options) => dialog.showOpenDialog(mainWindow ?? undefined!, options) }),
  });
  registerSkillsDomain({
    ...deps,
    skills,
    push: pushToRenderer,
    openSkillsDir: async () => {
      const error = await openDirectoryNative(skills.dirPath(), shell.openPath); if (error) console.log(`[Loopsoar] 打开技能目录失败：${error}`);
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
    stopExtensions: () => { extensionRuntime.stopAll(); skills.dispose(); },
    closeTerminals: () => {
      terminals.closeAll();
      askBus.clearAll("应用退出，按取消处理");
      chromePopover.dispose();
      agentWindow?.dispose();
      void remoteBrowserBackend?.close();
    },
    // app.exit() 不触发 will-quit：后台任务必须在这里杀，否则留孤儿进程。
    killBackgroundTasks: () => backgroundTasks.killAll(),
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
  browserLinks.drain();
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