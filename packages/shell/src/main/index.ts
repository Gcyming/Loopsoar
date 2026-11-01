/**
 * Loopsoar 主进程入口。
 * 允许 import electron 的文件只有两个：本文件与 main/electronBrowser.ts（薄适配层）。
 * 职责：协议注册 → 数据目录 → 域装配（受信 IPC）→ 窗口创建 → 浏览器宿主挂载。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, safeStorage, shell } from "electron";
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
import { APP_NAME, DATA_DIR_NAME, PROTOCOL } from "../shared/brand.js";
import { handleTrusted, type AuditEntry, type TrustedIpcDeps } from "./trustedIpc.js";
import {
  ensureLoopsoarDirs,
  makePlaceholderProtocolHandler,
  makeUiProtocolHandler,
} from "./boot.js";
import { resolveUiDistDir, uiDistCandidates } from "./uiProtocol.js";
import { createElectronBrowserHost, DownloadsBridge } from "./electronBrowser.js";
import { withProviderDefaults } from "./providerDefaults.js";
import type { BrowserHost } from "./browserHost.js";
import type { PersistedBrowserState } from "./browserSessionState.js";
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
import { ExtensionRuntime, resolveWorkerPath } from "./extensionRuntime.js";
import { registerSkillsDomain } from "./domains/skills.js";
import { registerMcpDomain } from "./domains/mcp.js";
import { registerFsDomain } from "./domains/fs.js";

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
          await new Promise((r) => setTimeout(r, Number(process.env.LOOPSOAR_E2E_HOLD_MS ?? 800))); // 等 React 首帧与 IPC 数据渲染
          const navUrl = process.env.LOOPSOAR_E2E_NAV_URL;
          if (navUrl) {
            const outcome = await browserHost?.navigate(navUrl);
            console.log("E2E_NAV", JSON.stringify(outcome));
            await new Promise((r) => setTimeout(r, Number(process.env.LOOPSOAR_E2E_NAV_WAIT_MS ?? 2500))); // 等真实页面渲染完成
          }
          // 验收辅助：按可见文案点击一次（如设置页「编辑」），用于截图前展开表单
          const clickText = process.env.LOOPSOAR_E2E_CLICK_TEXT;
          if (clickText) {
            const clickDelay = Number(process.env.LOOPSOAR_E2E_CLICK_DELAY_MS ?? 0);
            if (Number.isFinite(clickDelay) && clickDelay > 0) {
              await new Promise((r) => setTimeout(r, clickDelay));
            }
            // 支持 "编辑|OpenCode Go" 依次点击多个可见文案，用于截图前展开并填充表单
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
              await new Promise((r) => setTimeout(r, 500));
            }
            await new Promise((r) => setTimeout(r, 500));
            const postClick = Number(process.env.LOOPSOAR_E2E_POST_CLICK_MS ?? 0);
            if (Number.isFinite(postClick) && postClick > 0) {
              await new Promise((r) => setTimeout(r, postClick));
            }
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
            if (!rail) return 'no-rail';
            const r = rail.getBoundingClientRect();
            const x = r.left + r.width / 2;
            const y = r.top + r.height * 0.45;
            for (const type of ['pointerenter', 'pointermove']) {
              rail.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, bubbles: true }));
            }
            return 'hovered';
          })()`,
        )
        .then((r) => console.log(`[E2E] RAIL_HOVER ${r}`))
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
  const buildLlmFromActive = (sessionId?: string): LlmClient | undefined => {
    const active = providers.active();
    const key = resolveProviderKey(active?.id);
    if (!active || !key) return undefined;
    // 请求头模板（{{sessionId}} / {{model}} / {{requestId}} …）：按请求渲染，
    // 让 x-opencode-session 这类"每会话/每请求"限制无需为每个供应商写死。
    const effectiveHeaders = withProviderDefaults(active.provider, active.baseUrl, active.headers);
    const resolveHeaders =
      Object.keys(effectiveHeaders).length > 0
        ? (): Record<string, string> =>
            renderHeaderTemplates(effectiveHeaders, {
              provider: active.provider,
              model: active.model,
              sessionId: sessionId ?? "no-session",
              requestId: randomUUID(),
              timestamp: new Date().toISOString(),
            })
        : undefined;
    // 端点协议：显式指定优先，auto 按 baseUrl 推断（OpenAI 兼容 / Anthropic Messages）
    const format = active.apiFormat && active.apiFormat !== "auto" ? active.apiFormat : inferApiFormat(active.baseUrl);
    if (format === "anthropic") {
      return createAnthropicClient({
        baseUrl: active.baseUrl.replace(/\/v1$/, ""),
        apiKey: key,
        model: active.model,
        resolveHeaders,
      });
    }
    return createOpenAiClient({ baseUrl: active.baseUrl, apiKey: key, model: active.model, resolveHeaders });
  };
  // 惰性引用：供应商增删改/切换活跃后立即生效（无需重启）
  let llmRef: LlmClient | undefined = buildLlmFromActive();

  // 记忆库（路径可在设置里改）+ 会话持久化
  const memoryFile = initialPrefs.memoryStorePath?.trim() || path.join(dirs.dataDir, "memory", "memory.json");
  const memory = new MemoryService({ platform, filePath: memoryFile });
  await memory.load();
  const sessions = new SessionStore(path.join(dirs.dataDir, "sessions"));
  // 工作区：挂载项目文件夹。旧偏好里的 workspaceRoot 作为默认工作区，兼容升级用户。
  const workspaces = new WorkspaceStore(
    path.join(dirs.dataDir, "workspaces.json"),
    initialPrefs.workspaceRoot?.trim() || process.cwd(),
  );
  const worktreesRoot = path.join(dirs.dataDir, "worktrees");
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
    // 技能：独立子系统，只注入 SKILL.md 文本（不提供工具）
    getSkillPrompt: (text: string) => skills.promptFor(text),
    // 权限策略：设置面板保存后即时生效
    permissionPolicy: () => loadPermissions(dirs.configDir),
    // 工具执行前按会话切换沙箱根（工作区 / worktree，后台会话也不串根）
    resolveWorkspaceRoot: (sessionId?: string) => resolveSessionRoot(sessionId),
    // 供应商：设置面板保存后即时生效
    getLlm: (sessionId?: string) => buildLlmFromActive(sessionId) ?? llmRef,
    // 会话历史：每次 stream 读取持久化消息，让模型具备多轮上下文（回滚后同样生效）
    getHistory: () =>
      (sessions.load()?.messages ?? []).slice(-400).map((m) => ({
        role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
        content: m.text,
      })),
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
  browserHost = createElectronBrowserHost(
    () => mainWindow,
    (url) => {
      // 只把真实网页转为新标签：about:blank/空地址等（弹窗占位）直接忽略，避免凭空多出「新标签页」
      if (!/^https?:\/\//i.test(url)) return;
      void browserHost?.newTab(url);
    },
    { initialSessionId, onSessionStateChanged: queueBrowserStateSave },
  );
  // 启动即恢复当前会话上次的网页（标题/URL/活动标签）
  const bootBrowserState = sessions.getBrowserState(initialSessionId);
  if (bootBrowserState) {
    void browserHost
      .switchSession(initialSessionId, bootBrowserState)
      .then((tabs) => pushToRenderer("browser:tabs", { tabs }))
      .catch(() => undefined);
  }
  // Agent 浏览器工具（快照/导航/点击/输入/滚动/抓取）：在浏览器宿主创建后注册
  registerBrowserTools(registry, () => browserHost);
  registerTerminalTools(registry, resolveSessionRoot);
  registerPlanTools(registry);
  registerFileTools(registry, resolveSessionRoot);
  sandbox.syncKnownTools(registry.list().map((t) => t.name));

  // 退出前把每个会话的标签状态落盘（防抖队列可能还没触发）
  app.on("before-quit", () => {
    for (const timer of tabSaveTimers.values()) clearTimeout(timer);
    tabSaveTimers.clear();
    for (const meta of sessions.list()) {
      const state = browserHost?.snapshotSession(meta.id);
      if (state && state.tabs.length > 0) sessions.saveBrowserState(meta.id, state);
    }
  });

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
  registerBrowserDomain({ ...deps, browser: browserHost, downloads });
  // 扩展运行时：每个启用扩展一个隔离子进程，工具桥接为 ext__<id>__<tool>
  const extensionRuntime = new ExtensionRuntime({
    extensions,
    registry,
    workerPath: resolveWorkerPath(__dirname),
    onUpdate: (id, status) => pushToRenderer("extensions:updated", { id, runtime: status }),
    onToolsChanged: () => sandbox.syncKnownTools(registry.list().map((t) => t.name)),
  });
  // 异步启动已启用扩展（失败互相隔离，不阻塞主窗口）
  setTimeout(() => {
    void extensionRuntime.startEnabled().catch(() => undefined);
  }, 500);

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
  registerFsDomain(deps);
  registerMcpDomain({
    ...deps,
    mcp,
    push: pushToRenderer,
    mcpConfigPath: path.join(dirs.dataDir, "mcp.json"),
  });
  // 自动连接启用的 MCP（失败不阻断启动；UI 里可重试）
  for (const srv of mcp.list()) {
    if (srv.enabled && srv.state === "idle") void mcp.connect(srv.id);
  }
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
