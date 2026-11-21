/**
 * E2E / 验收钩子（P2-3 从 main/index.ts 拆出）。
 *
 * 仅在 LOOPSOAR_E2E_* 环境变量显式启用时产生副作用；生产路径直接返回。
 * 依赖通过 context 注入，避免模块反向持有 main 入口的可变全局。
 */
import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, screen } from "electron";
import type { AgentWindowManager } from "./agentWindow.js";
import type { BrowserHost } from "./browserHost.js";
import type { BrowserExtensionHost } from "./browserExtensions.js";

export interface E2eHooksContext {
  getBrowserHost(): BrowserHost | null;
  getBrowserExtensionsHost(): BrowserExtensionHost | null;
  getAgentWindow(): AgentWindowManager | null;
  getMainWindow(): BrowserWindow | null;
  pushToRenderer(event: string, payload: unknown): void;
}

export interface E2eHooks {
  scheduleE2EScreenshot(win: BrowserWindow): void;
  scheduleE2EDemoChat(win: BrowserWindow): void;
  scheduleE2ESidebarRailHover(win: BrowserWindow): void;
  scheduleE2ERailHover(win: BrowserWindow): void;
  scheduleE2ELiveTool(win: BrowserWindow): void;
  scheduleE2EPlanDemo(win: BrowserWindow): void;
  scheduleE2ESteerDemo(win: BrowserWindow): void;
  scheduleE2ESearchDemo(win: BrowserWindow): void;
  scheduleE2EConfirmShot(win: BrowserWindow): void;
}

/** 打包态的空实现：安装包里不安装任何 E2E 钩子（环境变量不能成为执行入口）。 */
const NOOP_E2E_HOOKS: E2eHooks = {
  scheduleE2EScreenshot: () => undefined,
  scheduleE2EDemoChat: () => undefined,
  scheduleE2ESidebarRailHover: () => undefined,
  scheduleE2ERailHover: () => undefined,
  scheduleE2ELiveTool: () => undefined,
  scheduleE2EPlanDemo: () => undefined,
  scheduleE2ESteerDemo: () => undefined,
  scheduleE2ESearchDemo: () => undefined,
  scheduleE2EConfirmShot: () => undefined,
};

export function createE2eHooks(ctx: E2eHooksContext): E2eHooks {
  // 安全门：E2E 钩子能执行任意 JS / 截图 / 改窗口，只允许在开发态启用。
  if (app.isPackaged) return NOOP_E2E_HOOKS;
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
            const outcome = await ctx.getBrowserHost()?.navigate(navUrl);
            console.log("E2E_NAV", JSON.stringify(outcome));
            await new Promise((r) => setTimeout(r, Number(process.env.LOOPSOAR_E2E_NAV_WAIT_MS ?? 2500))); // 等真实页面渲染完成
            if (process.env.LOOPSOAR_E2E_BROWSER_EVAL) {
              try {
                const result = await ctx.getBrowserHost()?.executeInActiveTab(process.env.LOOPSOAR_E2E_BROWSER_EVAL);
                console.log("E2E_BROWSER_EVAL", JSON.stringify(result ?? null));
              } catch (err) {
                console.log("E2E_BROWSER_EVAL", JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
              }
            }
            if (process.env.LOOPSOAR_E2E_STORE_INSTALL) {
              try {
                const extension = await ctx.getBrowserExtensionsHost()?.installFromStore(process.env.LOOPSOAR_E2E_STORE_INSTALL);
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
                      browser: ctx.getBrowserHost()?.debugBounds() ?? null,
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
            const host = ctx.getBrowserHost();
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
          // LOOPSOAR_E2E_EVAL_FILE：从文件读取脚本（30 任务评测脚本超过 Windows 环境变量长度上限）。
          const evalSource =
            process.env.LOOPSOAR_E2E_EVAL ??
            (process.env.LOOPSOAR_E2E_EVAL_FILE
              ? fs.readFileSync(process.env.LOOPSOAR_E2E_EVAL_FILE, "utf8")
              : "");
          if (evalSource) {
            const result = await win.webContents
              .executeJavaScript(evalSource, true)
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
                // 透明覆盖窗口在 Windows 上若隐藏/被遮挡，就没有合成帧，capturePage 会永久挂起。
                // 先 showInactive + moveTop 触发合成；若仍失败，再用真正 show() 抢到前台重试一次。
                pointerWin.showInactive();
                pointerWin.moveTop?.();
                await new Promise((r) => setTimeout(r, 150));
                const captureOnce = async (): Promise<Buffer> => {
                  const img = await Promise.race([
                    pointerWin.webContents.capturePage(undefined, { stayAwake: true }),
                    new Promise<never>((_, reject) => {
                      setTimeout(() => reject(new Error("pointer capturePage 超时 1500ms")), 1_500);
                    }),
                  ]);
                  if (img.isEmpty()) throw new Error("pointer capturePage 返回空图");
                  return img.toPNG();
                };
                let png: Buffer | undefined;
                for (let attempt = 1; attempt <= 2 && !png; attempt += 1) {
                  try {
                    png = await captureOnce();
                  } catch (err) {
                    if (attempt === 2) throw err;
                    console.warn(
                      "POINTER_CAPTURE_RETRY",
                      err instanceof Error ? err.message : String(err),
                    );
                    pointerWin.show();
                    pointerWin.moveTop?.();
                    await new Promise((r) => setTimeout(r, 150));
                  }
                }
                if (!png) throw new Error("pointer capturePage 重试后仍为空");
                fs.writeFileSync(process.env.LOOPSOAR_E2E_POINTER_SHOT, png);
                console.log("POINTER_SHOT_SAVED", process.env.LOOPSOAR_E2E_POINTER_SHOT);
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
              ctx.getMainWindow()?.show();
              ctx.getMainWindow()?.moveTop();
              ctx.getMainWindow()?.focus();
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
              JSON.stringify({ contentSize: win.getContentSize(), browser: ctx.getBrowserHost()?.debugBounds() ?? null }),
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
                    console.log("E2E_AGENT_ICONWIN_CLICK", JSON.stringify({ iconMode: ctx.getAgentWindow()?.isIconMode() ?? null, agentVisible: agentWin.isVisible(), iconVisible: iconWindow.isVisible() }));
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
                    JSON.stringify({ restored, browser: ctx.getBrowserHost()?.debugBounds() ?? null }),
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
          const browser = ctx.getBrowserHost();
          if (navUrl && browser) {
            try {
              const base64 = await Promise.race([
                browser.screenshot(),
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
          ctx.pushToRenderer("chat:stream:chunk", { sessionId: "e2e-demo", content: chunk });
        }, index * 150);
      });
      setTimeout(() => {
        ctx.pushToRenderer("chat:stream:heartbeat", { sessionId: "e2e-demo" });
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
    const push = (channel: string, payload: unknown): void => ctx.pushToRenderer(channel, payload);
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
    const push = (channel: string, payload: unknown): void => ctx.pushToRenderer(channel, payload);
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
      // 演示：计划推进（触发「已完成 / 开始」播报）
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


  return {
    scheduleE2EScreenshot,
    scheduleE2EDemoChat,
    scheduleE2ESidebarRailHover,
    scheduleE2ERailHover,
    scheduleE2ELiveTool,
    scheduleE2EPlanDemo,
    scheduleE2ESteerDemo,
    scheduleE2ESearchDemo,
    scheduleE2EConfirmShot,
  };
}
