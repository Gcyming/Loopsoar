/**
 * Loopsoar 主进程入口。
 * 允许 import electron 的文件只有两个：本文件与 main/electronBrowser.ts（薄适配层）。
 * 职责：协议注册 → 数据目录 → 域装配（受信 IPC）→ 窗口创建 → 浏览器宿主挂载。
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, shell } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHANNEL_BINDINGS, EVENTS } from "loopsoar-contracts/schemas";
import { createNodePlatform } from "loopsoar-core/platform";
import { ToolRegistry } from "loopsoar-core/tools/registry";
import { registerBuiltinMinimal } from "loopsoar-core/tools/builtin";
import { SandboxManager } from "loopsoar-core/sandbox";
import { ChatService } from "loopsoar-services/chat";
import { createOpenAiClient, type LlmClient } from "loopsoar-core/llm";
import { AgentRegistry, BUILTIN_AGENT } from "loopsoar-core/agent";
import { resolveApiKeyFromEnv, providerUsability } from "loopsoar-core/provider";
import { loadPreferences, loadPermissions } from "./domains/settings.js";
import { APP_NAME, DATA_DIR_NAME, PROTOCOL } from "../shared/brand.js";
import { handleTrusted, type AuditEntry, type TrustedIpcDeps } from "./trustedIpc.js";
import {
  ensureLoopsoarDirs,
  makePlaceholderProtocolHandler,
  makeUiProtocolHandler,
} from "./boot.js";
import { resolveUiDistDir, uiDistCandidates } from "./uiProtocol.js";
import { createElectronBrowserHost, DownloadsBridge } from "./electronBrowser.js";
import type { BrowserHost } from "./browserHost.js";
import { registerRuntimeDomain } from "./domains/runtime.js";
import { registerWorkspaceDomain } from "./domains/workspace.js";
import { registerAgentsDomain } from "./domains/agents.js";
import { registerChatDomain } from "./domains/chat.js";
import { registerBrowserDomain } from "./domains/browserAdapter.js";
import { registerWindowDomain } from "./domains/window.js";
import { loadProviderConfig, registerSettingsDomain, currentRulesPrompt } from "./domains/settings.js";
import { registerMemoryDomain } from "./domains/memory.js";
import { MemoryService } from "./memoryService.js";
import { SessionStore } from "./sessionStore.js";
import { ProviderStore } from "./providerStore.js";
import { ExtensionHost } from "./extensions.js";
import { registerExtensionsDomain } from "./domains/extensions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
app.setName(APP_NAME);
app.setPath(
  "userData",
  process.env.LOOPSOAR_DATA_DIR || path.join(app.getPath("appData"), DATA_DIR_NAME),
);

const auditLog: AuditEntry[] = [];
const deps: TrustedIpcDeps = {
  ipc: ipcMain,
  audit: (entry) => {
    auditLog.push(entry);
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
          await new Promise((r) => setTimeout(r, 800)); // 等 React 首帧与 IPC 数据渲染
          const navUrl = process.env.LOOPSOAR_E2E_NAV_URL;
          if (navUrl) {
            const outcome = await browserHost?.navigate(navUrl);
            console.log("E2E_NAV", JSON.stringify(outcome));
            await new Promise((r) => setTimeout(r, 2500)); // 等真实页面渲染完成
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
  mainWindow.once("ready-to-show", () => mainWindow?.show());
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
  // 窗口缩放 → 原生浏览器视图重新对齐（几何来源：contracts/layout）
  mainWindow.on("resize", () => browserHost?.syncBounds());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  const devUrl = process.env.LOOPSOAR_DEV_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    // E2E 直达：LOOPSOAR_E2E_OPEN=settings 时带 query 打开并自动展开设置面板
    const e2eOpen = process.env.LOOPSOAR_E2E_OPEN;
    const query = e2eOpen ? `?e2e=${e2eOpen}` : "";
    void mainWindow.loadURL(`${PROTOCOL}://app/index.html${query}`);
  }
  scheduleE2EScreenshot(mainWindow);
  scheduleE2EDemoChat(mainWindow);
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
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

app.whenReady().then(async () => {
  try {
    const dirs = ensureWritableDataDirs();

  // 协议：服务真实 UI 产物；产物缺失时降级为可读提示页（不白屏）
  const uiDist = resolveUiDistDir(uiDistCandidates(__dirname, process.cwd()));
  if (uiDist) {
    protocol.handle(PROTOCOL, makeUiProtocolHandler(uiDist));
  } else {
    console.warn("[Loopsoar] 未找到 ui/dist（先运行 pnpm --filter loopsoar-ui build），使用占位页");
    protocol.handle(PROTOCOL, makePlaceholderProtocolHandler());
  }

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
  const apiKey = resolveApiKeyFromEnv(process.env);
  const buildLlmFromActive = (): LlmClient | undefined => {
    const active = providers.active();
    const key = resolveApiKeyFromEnv(process.env);
    if (!active || !key) return undefined;
    return createOpenAiClient({ baseUrl: active.baseUrl, apiKey: key, model: active.model });
  };
  // 惰性引用：供应商增删改/切换活跃后立即生效（无需重启）
  let llmRef: LlmClient | undefined = buildLlmFromActive();

  // 记忆库（路径可在设置里改）+ 会话持久化
  const memoryFile = initialPrefs.memoryStorePath?.trim() || path.join(dirs.dataDir, "memory", "memory.json");
  const memory = new MemoryService({ platform, filePath: memoryFile });
  await memory.load();
  const sessions = new SessionStore(path.join(dirs.dataDir, "sessions"));
  const extensions = new ExtensionHost(path.join(dirs.dataDir, "extensions"));

  // Agent 注册表（真实实现）：内置默认 Agent → 决定身份段与工具白名单
  const agents = new AgentRegistry();
  agents.registerBuiltin(BUILTIN_AGENT);
  const defaultAgent = agents.defaultAgent();
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
      tools: registry.list().length,
      agents: agents.list().length,
      memoryEntries: memory.stats().total,
    }),
    // 供应商增删改/切换 → 重建 LLM（立即可对话）
    providers,
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
  const chatService = new ChatService({
    platform,
    registry,
    sandbox,
    agent: defaultAgent ? { name: defaultAgent.name, role: defaultAgent.role } : undefined,
    toolAllowlist: defaultAgent?.toolAllowlist,
    // 规则文件（AGENTS.md）：每次 stream 重新读取，设置面板保存后即时生效
    getSystemRules: () => currentRulesPrompt(settingsDeps),
    // 记忆召回：按当前消息取相关条目，注入 volatile 段
    getMemoryFor: (text: string) => memory.recallPrompt(text),
    // 权限策略：设置面板保存后即时生效
    permissionPolicy: () => loadPermissions(dirs.configDir),
    // 供应商：设置面板保存后即时生效
    getLlm: () => llmRef,
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

  // 浏览器宿主：WebContentsView 懒创建 + 布局对齐（electron 细节封装在 electronBrowser.ts）
  browserHost = createElectronBrowserHost(() => mainWindow, (url) => {
    void browserHost?.newTab(url);
  });
  // 下载管理：目录跟随偏好（downloadDir，留空=系统下载目录），变更推送 UI
  const downloads = new DownloadsBridge(
    () => loadPreferences(dirs.configDir).downloadDir ?? "",
    () => pushToRenderer("browser:downloads", { downloads: downloads.list() }),
  );

  registerRuntimeDomain(deps);
  registerWorkspaceDomain({ ...deps, platform });
  registerAgentsDomain({ ...deps, agents });
  registerSettingsDomain(settingsDeps);
  registerChatDomain({
    ...deps,
    chatService,
    push: pushToRenderer,
    memory,
    sessions,
    shouldAutoCapture: () => loadPreferences(dirs.configDir).memoryAutoCapture,
  });
  registerMemoryDomain({ ...deps, memory, push: pushToRenderer });
  registerBrowserDomain({ ...deps, browser: browserHost, downloads });
  registerExtensionsDomain({
    ...deps,
    extensions,
    push: pushToRenderer,
    openExtensionsDir: async () => (await shell.openPath(extensions.dirPath())) === "",
  });
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

  // 移除原生菜单栏（File/Edit/View/Window）——品牌统一由自定义标题栏承载
  Menu.setApplicationMenu(null);

  createMainWindow();
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
