/**
 * E2E 深链钩子（从 App 抽出，只在 URL 带 `?e2e=…` 时生效，生产路径零副作用）。
 *
 * 覆盖：
 *   1. `scrollTimeline=1` 恢复会话后把最后一条时间线滚到可视区（只做一次）；
 *   2. `e2e=chat` 自动发一条消息（配合 scripts/mock-openai-server.mjs 验证真流式链路）；
 *   3. `e2e=model-menu / perm-menu / menus-overlap / set-effort / steer-choice / session-switch /
 *      session-tabs / workspace` 自动展开弹层或跑会话切换脚本；
 *   4. `e2e=settings&section=xxx` 直接打开对应设置分区。
 *
 * 依赖数组与原内联 effect 保持一致（切换回调来自 useCallback，引用变化时重排定时器）。
 */
import * as React from "react";
import type { ChromePageKind, LoopsoarAPI } from "./types.js";

/** 最小 ref 形状。 */
interface MutableRef<T> {
  current: T;
}

/** 恢复会话后滚动到最后一条时间线（只做一次）。 */
export function useE2eRestoredScroll(messageCount: number, busy: boolean): void {
  const doneRef = React.useRef(false);
  React.useEffect(() => {
    if (doneRef.current || messageCount === 0 || busy) return;
    if (new URLSearchParams(location.search).get("scrollTimeline") !== "1") return;
    const timer = setTimeout(() => {
      const cards = document.querySelectorAll(".chat-scroll .think-card");
      const last = cards[cards.length - 1] as HTMLElement | undefined;
      if (last) {
        doneRef.current = true;
        last.scrollIntoView({ block: "start" });
      }
    }, 800);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageCount, busy]);
}

/** `?e2e=chat`：挂载后延迟自动发送一条消息。 */
export function useE2eChatAutoSend(api: LoopsoarAPI | null, sendText: (text: string) => void): void {
  React.useEffect(() => {
    if (!api || typeof location === "undefined") return;
    if (new URLSearchParams(location.search).get("e2e") !== "chat") return;
    const message = new URLSearchParams(location.search).get("chatText") || "你好，请简单介绍一下你自己";
    const delay = Number(new URLSearchParams(location.search).get("chatDelay") ?? "900");
    if (Number.isFinite(delay) && delay < 0) return;
    const timer = setTimeout(() => {
      sendText(message);
    }, Number.isFinite(delay) && delay >= 0 ? delay : 900);
    return () => clearTimeout(timer);
  }, [api, sendText]);
}

export interface E2eMenuDeepLinkOptions {
  api: LoopsoarAPI | null;
  sessionIdRef: MutableRef<string>;
  openModelMenu: () => void;
  newSession: () => void;
  sendText: (text: string) => void;
  switchSession: (sessionId: string) => void;
  setInput: (value: string) => void;
  setWorkspacePanelOpen: (open: boolean) => void;
}

/** `?e2e=model-menu / perm-menu / menus-overlap / set-effort / steer-choice / session-* / workspace`。 */
export function useE2eMenuDeepLinks(options: E2eMenuDeepLinkOptions): void {
  const { api, sessionIdRef, openModelMenu, newSession, sendText, switchSession, setInput, setWorkspacePanelOpen } = options;
  React.useEffect(() => {
    if (!api || typeof location === "undefined") return;
    const mode = new URLSearchParams(location.search).get("e2e");
    if (
      mode !== "model-menu" &&
      mode !== "perm-menu" &&
      mode !== "menus-overlap" &&
      mode !== "set-effort" &&
      mode !== "steer-choice" &&
      mode !== "session-switch" &&
      mode !== "session-tabs" &&
      mode !== "workspace"
    ) {
      return;
    }
    const clickPermissionChip = (): void => {
      // 权限菜单的开关属于 Composer：深链只负责点击它的触发 chip（避免 App 再维护一份状态）。
      const chips = Array.from(document.querySelectorAll<HTMLElement>(".chip"));
      chips.find((chip) => (chip.textContent ?? "").includes("权限"))?.click();
    };
    const timer = setTimeout(() => {
      if (mode === "model-menu") {
        openModelMenu();
        return;
      }
      if (mode === "workspace") {
        // E2E：打开工作区面板（挂载项目 / Git 状态 / 当前会话 worktree）
        setWorkspacePanelOpen(true);
        return;
      }
      if (mode === "session-tabs") {
        // E2E：A 会话打开页面 → 新建 B（空）→ 切回 A，左侧应恢复 A 的页面；
        // 再次启动（不带此模式）应恢复上次退出时的页面（会话即文件夹）。
        const begin = (): void => {
          const origin = sessionIdRef.current;
          if (!origin) {
            window.setTimeout(begin, 150);
            return;
          }
          void api.browser.navigate({ url: "http://127.0.0.1:19443/?session=a" }).catch(() => undefined);
          window.setTimeout(() => void newSession(), 1500);
          window.setTimeout(() => switchSession(origin), 3200);
        };
        begin();
        return;
      }
      if (mode === "session-switch") {
        // E2E：长流式期间切到新会话再切回，验证不串台/不丢流/停止可用。
        // 等会话 ID 就绪再开始（否则启动恢复尚未完成，origin 为空导致切不回来）。
        const begin = (): void => {
          const origin = sessionIdRef.current;
          if (!origin) {
            window.setTimeout(begin, 200);
            return;
          }
          sendText("请做一次较长的回答，用于验证切换会话后流仍可恢复");
          window.setTimeout(() => void newSession(), 1200);
          window.setTimeout(() => switchSession(origin), 3200);
        };
        begin();
        return;
      }
      if (mode === "steer-choice") {
        // E2E：先发起一轮长回复，再在运行中输入并发送 → 应弹出「编辑 / 直接引导 / 取消」选择
        sendText("你好，请简单介绍一下你自己");
        window.setTimeout(() => setInput("补充：只看最近一周的情报"), 700);
        window.setTimeout(() => {
          document.querySelector<HTMLButtonElement>(".send-btn")?.click();
        }, 1100);
        return;
      }
      if (mode === "set-effort") {
        // E2E：展开模型菜单并点击「高」推理等级，用于验证偏好持久化（重启后仍为高）。
        openModelMenu();
        window.setTimeout(() => {
          const buttons = Array.from(document.querySelectorAll<HTMLElement>("[data-popover] .chip"));
          buttons.find((button) => (button.textContent ?? "").trim() === "高")?.click();
        }, 700);
        return;
      }
      if (mode === "menus-overlap") {
        // 先开模型菜单，再点权限 chip：验证全局互斥（最终只应保留权限菜单）。
        openModelMenu();
        window.setTimeout(clickPermissionChip, 400);
        return;
      }
      clickPermissionChip();
    }, 900);
    return () => clearTimeout(timer);
  }, [api, newSession, openModelMenu, sendText, switchSession, setInput, setWorkspacePanelOpen, sessionIdRef]);
}

/** `?e2e=settings&section=xxx`：直接打开对应设置分区。 */
export function useE2eSettingsDeepLink(
  setSettingsOpen: (open: boolean) => void,
  setSettingsSection: (section: string) => void,
): void {
  React.useEffect(() => {
    if (typeof location === "undefined") return;
    const params = new URLSearchParams(location.search);
    if (params.get("e2e") !== "settings") return;
    setSettingsOpen(true);
    const wanted = params.get("section");
    if (wanted) setSettingsSection(wanted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** `?e2e=chromepage&kind=history|downloads|bookmarks|settings`：直接打开浏览器管理整页（E2E 专用）。 */
export function useE2eChromePageDeepLink(open: (kind: ChromePageKind) => void): void {
  React.useEffect(() => {
    if (typeof location === "undefined") return;
    const params = new URLSearchParams(location.search);
    if (params.get("e2e") !== "chromepage") return;
    const kind = params.get("kind");
    if (kind !== "history" && kind !== "downloads" && kind !== "bookmarks" && kind !== "settings") return;
    const timer = window.setTimeout(() => open(kind), 900);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
