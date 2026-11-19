/**
 * 浏览器后端端口（P1-3 第一步）。
 *
 * 工具层只依赖这个接口，不再依赖 Electron 的 BrowserHost 具体类；
 * 当前有两个实现：BrowserHost（Electron WebContentsView，主窗口）与
 * CdpBrowserBackend（Node 原生 WebSocket/CDP，远端/无头自动化）。
 * 浏览器工具不用改即可切换后端。
 *
 * 注意：这不是完整引擎替换——会话生命周期、原生视图布局仍在 shell 的 BrowserHost 里。
 * 但工具面（导航/快照/点击/输入/截图/标签）已经收口到端口，避免继续扩散 Electron 依赖。
 */
import type { BrowserSnapshot } from "../browserAdapter/types.js";
import type { NavigateOutcome, TabState } from "./browserHost.js";

export interface BrowserBackend {
  listTabs(sessionId?: string): TabState[];
  activeTabId(sessionId?: string): string | null;
  navigate(
    rawUrl: string,
    tabId?: string,
    sessionId?: string,
    origin?: "agent" | "user",
  ): Promise<NavigateOutcome>;
  newTab(
    rawUrl?: string,
    sessionId?: string,
    origin?: "agent" | "user",
  ): Promise<{ tabId: string; url?: string; ok: boolean; error?: string }>;
  selectTab(tabId: string, sessionId?: string): boolean;
  closeTab(tabId: string, sessionId?: string): Promise<boolean>;
  goBack(tabId?: string, sessionId?: string): Promise<{ ok: boolean; url?: string; error?: string }>;
  goForward(tabId?: string, sessionId?: string): Promise<{ ok: boolean; url?: string; error?: string }>;
  reload(tabId?: string, sessionId?: string): Promise<{ ok: boolean; url?: string; error?: string }>;
  screenshot(sessionId?: string): Promise<string | null>;
  snapshot(sessionId?: string, tabId?: string): Promise<BrowserSnapshot | null>;
  agentClick(sessionId: string | undefined, tabId: string | undefined, point: { x: number; y: number }): Promise<boolean>;
  agentType(
    sessionId: string | undefined,
    tabId: string | undefined,
    text: string,
    options?: { multiline?: boolean },
  ): Promise<boolean>;
  agentHover(sessionId: string | undefined, tabId: string | undefined, point: { x: number; y: number }): Promise<boolean>;
  getViewportCenter(sessionId: string | undefined, tabId: string | undefined): Promise<{ x: number; y: number } | null>;
  agentDrag(
    sessionId: string | undefined,
    tabId: string | undefined,
    from: { x: number; y: number },
    to: { x: number; y: number },
    steps?: number,
  ): Promise<boolean>;
  agentWheel(sessionId: string | undefined, tabId: string | undefined, deltaY: number): Promise<boolean>;
  agentKey(sessionId: string | undefined, tabId: string | undefined, key: string): Promise<boolean>;
  executeScript(script: string, sessionId?: string, tabId?: string): Promise<unknown>;
  getPageZoom(sessionId?: string, tabId?: string): number;
  isSessionVisible(sessionId?: string): boolean;
  ensureAgentTab(sessionId?: string, opts?: { blank?: boolean }): Promise<string | null>;
}
