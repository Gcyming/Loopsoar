/**
 * 守卫：浏览器桥隔离——发布门 2 的四条攻击路径（ADR-0009）。
 *
 * 四条路径（每条都要有可执行断言，缺失即不验收）：
 *  ① 预加载脚本注入：网页内容不得经 preload 桥拿到主进程能力（bridge 只暴露白名单 API）
 *  ② IPC 冒用：伪造 sender 帧/绕过受信入口调用敏感通道必须被拒
 *  ③ window.open 逃逸：target=_blank / window.open 不得产生带 main 能力的独立窗口
 *  ④ CDP 端口滥用：生产代码不得开启远程调试端口/使用 debugger 附加绕过权限
 *
 * 说明：本守卫是静态结构断言（配合 tests/shell/trusted-ipc.spec.ts 的行为断言），
 * 在无法启动 Electron 的 CI 环境也能常跑；真机攻击演练见 docs/security。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

const ELECTRON_BROWSER = "packages/shell/src/main/electronBrowser.ts";
const INDEX = "packages/shell/src/main/index.ts";
const MAIN_WINDOW = "packages/shell/src/main/mainWindowFactory.ts";
const PRELOAD = "packages/shell/src/preload/index.cjs";
const TRUSTED_IPC = "packages/shell/src/main/trustedIpc.ts";
const NAVIGATION = "packages/contracts/src/navigation.ts";
const BROWSER_HOST = "packages/shell/src/main/browserHost.ts";
const BROWSER_TOOLS = "packages/shell/src/main/browserTools.ts";

describe("守卫：浏览器桥隔离（发布门 2 四攻击路径）", () => {
  it("① 预加载脚本注入：preload 只暴露白名单 API，不暴露 ipcRenderer/electron 原始对象", () => {
    const src = read(PRELOAD);
    expect(src).toContain('contextBridge.exposeInMainWorld("loopsoarAPI"');
    expect(src).toContain("--loopsoar-bindings=");
    expect(src).toContain("--loopsoar-events=");
    expect(src).not.toMatch(/exposeInMainWorld\(\s*["'](?:ipcRenderer|electron|require)["']/);
    // 只允许通过白名单拼装 api[domain][method]，不允许把 ipcRenderer 挂到 api 上
    expect(src).not.toMatch(/api\.ipcRenderer\s*=/);
    expect(src).not.toMatch(/window\.ipcRenderer\s*=/);
  });

  it("② IPC 冒用：所有 IPC handler 都必须经 handleTrusted（无裸 ipcMain.handle）", () => {
    const src = read(TRUSTED_IPC);
    expect(src).toContain("senderFrame");
    expect(src).toContain("loopsoar://");
    expect(src).toContain("IPC_CHANNELS");
    expect(src).toContain("IPC_VALIDATORS");

    // shell 内除 trustedIpc.ts 自身外，原则上不得直接调用 ipcMain.handle/on/once；
    // 唯一例外：浏览器页 preload 的商店安装通道（发送者是 https 页面，不属于 loopsoar:// 受信帧），
    // 必须显式校验 sender 是本应用浏览器标签（BrowserHost.hasWebContents），且只接受 id 一个字段。
    const shellIndex = read(INDEX);
    const bareHandlers = [...shellIndex.matchAll(/ipcMain\.(handle|on|once)\s*\(\s*"([^"]+)"/g)].map((m) => m[2]);
    expect(bareHandlers).toEqual(["loopsoar-browser:install-extension"]);
    expect(shellIndex).toContain("hasWebContents(event.sender.id)");
    expect(shellIndex).toContain("/^[a-p]{32}$/");
    // 域文件统一走 handleTrusted
    expect(shellIndex).toContain("handleTrusted");
  });

  it("③ window.open 逃逸：新窗口一律 deny 并转应用内标签，且只接受 http(s)", () => {
    const browser = read(ELECTRON_BROWSER);
    expect(browser).toContain("setWindowOpenHandler");
    expect(browser).toContain('return { action: "deny" }');
    // 转新标签的 URL 必须过 http(s) 白名单
    const index = read(INDEX);
    expect(index).toMatch(/\^https\?:\\?\/\\?\//i);
  });

  it("④ CDP 端口滥用：生产代码不得开启远程调试/使用 debugger 绕过权限", () => {
    const suspects = [INDEX, ELECTRON_BROWSER, BROWSER_HOST, BROWSER_TOOLS, "packages/shell/src/main/domains/browserAdapter.ts"];
    for (const rel of suspects) {
      const src = read(rel);
      expect(src, `${rel} 不得包含 remote-debugging`).not.toMatch(/remote-debugging-port/i);
      expect(src, `${rel} 不得使用 webContents.debugger`).not.toMatch(/webContents\.debugger/);
      expect(src, `${rel} 不得使用 debugger.attach`).not.toMatch(/debugger\.attach\s*\(/);
    }
  });

  it("浏览器视图安全基线：sandbox/contextIsolation/nodeIntegration 全部 fail-closed", () => {
    const src = read(ELECTRON_BROWSER);
    expect(src).toContain("sandbox: true");
    expect(src).toContain("contextIsolation: true");
    expect(src).toContain("nodeIntegration: false");
    const index = read(MAIN_WINDOW);
    expect(index).toContain("contextIsolation: true");
    expect(index).toContain("sandbox: true");
    expect(index).toContain("nodeIntegration: false");
    expect(index).toContain("webSecurity: true");
  });

  it("导航白名单：只允许 http/https，file:// 等协议进不来", () => {
    const nav = read(NAVIGATION);
    expect(nav).toContain("http:");
    expect(nav).toContain("https:");
    // browserHost 导航必须先归一化/校验，不能直接 loadURL 原始输入
    expect(read(BROWSER_HOST)).toMatch(/normalizeNavigateUrl/);
    expect(read(BROWSER_TOOLS)).toMatch(/normalizeNavigateUrl|navigate\(/);
  });
});
