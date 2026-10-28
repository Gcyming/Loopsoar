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
import { APP_NAME, PROTOCOL } from "../shared/brand.js";
import { handleTrusted, type AuditEntry, type TrustedIpcDeps } from "./trustedIpc.js";
import { ensureLoopsoarDirs, makeProtocolHandler } from "./boot.js";
import { registerRuntimeDomain } from "./domains/runtime.js";
import { registerWorkspaceDomain } from "./domains/workspace.js";
import { registerAgentsDomain } from "./domains/agents.js";
import { registerChatDomain } from "./domains/chat.js";
import { registerBrowserDomain } from "./domains/browserAdapter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

app.whenReady().then(() => {
  ensureLoopsoarDirs(app.getPath("userData"));
  protocol.handle(PROTOCOL, makeProtocolHandler((u) => net.fetch(u)));

  registerRuntimeDomain(deps);
  registerWorkspaceDomain({ ...deps, platform: createNodePlatform() });
  registerAgentsDomain(deps);
  registerChatDomain({ ...deps, push: pushToRenderer });
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
