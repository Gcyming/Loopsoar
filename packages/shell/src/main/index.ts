/**
 * Loopsoar 主进程入口（唯一允许 import electron 的文件，≤150 行）。
 * 职责：app 生命周期 → 数据目录/协议 → 域注册（受信 IPC）→ 创建窗口。
 * 域模块全部依赖注入，可脱离 electron 测试（见 tests/guards）。
 */
import { app, BrowserWindow, ipcMain, net, protocol } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHANNEL_BINDINGS, EVENTS } from "loopsoar-contracts/schemas";
import { createNodePlatform } from "loopsoar-core/platform";
import { ToolRegistry } from "loopsoar-core/tools/registry";
import { registerBuiltinMinimal } from "loopsoar-core/tools/builtin";
import { SandboxManager } from "loopsoar-core/sandbox";
import { ChatService } from "loopsoar-services/chat";
import { createOpenAiClient } from "loopsoar-core/llm";
import { AgentRegistry, BUILTIN_AGENT } from "loopsoar-core/agent";
import { resolveApiKeyFromEnv, providerUsability } from "loopsoar-core/provider";
import { APP_NAME, DATA_DIR_NAME, PROTOCOL } from "../shared/brand.js";
import { handleTrusted, type AuditEntry, type TrustedIpcDeps } from "./trustedIpc.js";
import { ensureLoopsoarDirs, makeProtocolHandler } from "./boot.js";
import { registerRuntimeDomain } from "./domains/runtime.js";
import { registerWorkspaceDomain } from "./domains/workspace.js";
import { registerAgentsDomain } from "./domains/agents.js";
import { registerChatDomain } from "./domains/chat.js";
import { registerBrowserDomain } from "./domains/browserAdapter.js";
import { loadProviderConfig, registerSettingsDomain } from "./domains/settings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 项目隔离：Electron 默认 userData 是 %APPDATA%\<package name>；这里显式落到品牌目录
// （%APPDATA%\loopsoar），确保与 slime / 其他 Electron 应用的数据、缓存、登录态完全分开。
app.setName(APP_NAME);
app.setPath("userData", path.join(app.getPath("appData"), DATA_DIR_NAME));

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
    w.webContents.send(`loopsoar:${event}`, payload);
  }
}

let mainWindow: BrowserWindow | null = null;

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: APP_NAME,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      preload: path.join(__dirname, "../../src/preload/index.cjs"),
      additionalArguments: [
        `--loopsoar-bindings=${JSON.stringify(buildBindings())}`,
        `--loopsoar-events=${JSON.stringify(EVENTS)}`,
      ],
    },
  });
  const devUrl = process.env.LOOPSOAR_DEV_URL;
  if (devUrl) void mainWindow.loadURL(devUrl);
  else void mainWindow.loadURL(`${PROTOCOL}://app/index.html`);
}

app.whenReady().then(async () => {
  const dirs = ensureLoopsoarDirs(app.getPath("userData"));
  protocol.handle(PROTOCOL, makeProtocolHandler((u) => net.fetch(u)));

  // 装配：platform / 工具注册表 / 沙箱 / Provider 配置 → ChatService（真 LLM 闭环）
  const platform = createNodePlatform();
  const registry = new ToolRegistry();
  registerBuiltinMinimal(registry, platform);
  const sandbox = new SandboxManager();
  sandbox.setWorkspaceRoot(process.cwd());
  sandbox.syncKnownTools(registry.list().map((t) => t.name));

  const providerConfig = await loadProviderConfig(platform, dirs.configDir);
  const apiKey = resolveApiKeyFromEnv(process.env);
  const llmUsability = providerUsability(providerConfig, apiKey);
  const llm =
    providerConfig && llmUsability.usable
      ? createOpenAiClient({
          baseUrl: providerConfig.baseUrl,
          apiKey,
          model: providerConfig.model,
        })
      : undefined;

  // Agent 注册表（真实实现）：内置默认 Agent → 决定身份段与工具白名单
  const agents = new AgentRegistry();
  agents.registerBuiltin(BUILTIN_AGENT);
  const defaultAgent = agents.defaultAgent();
  const chatService = new ChatService({
    platform,
    registry,
    sandbox,
    llm,
    agent: defaultAgent ? { name: defaultAgent.name, role: defaultAgent.role } : undefined,
    toolAllowlist: defaultAgent?.toolAllowlist,
  });

  registerRuntimeDomain(deps);
  registerWorkspaceDomain({ ...deps, platform });
  registerAgentsDomain({ ...deps, agents });
  registerSettingsDomain({ ...deps, platform, configDir: dirs.configDir, env: process.env });
  registerChatDomain({ ...deps, chatService, push: pushToRenderer });
  registerBrowserDomain(deps);

  createMainWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

export { getHandlerRegistry, handleTrusted } from "./trustedIpc.js";
