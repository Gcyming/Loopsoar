import fs from "node:fs";

/**
 * 应用级 Toast 浮窗（独立透明子窗口）。
 *
 * 为什么不是 DOM：右侧网页是原生 WebContentsView，永远绘制在 DOM 之上，
 * 任何「窗口内的提示」都会被网页盖住（用户实测：提示只在没有网页时可见）。
 * 独立子窗口是唯一能稳定压在网页之上、又不打断页面渲染的做法。
 *
 * 为什么注入窗口工厂而不是 import electron：壳层只有 index.ts / electronBrowser.ts 允许碰 electron，
 * 这里保持可单测的纯逻辑（位置计算 + HTML + 生命周期）。
 */

export interface ToastWindowLike {
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
  loadURL(url: string): Promise<void> | void;
  showInactive(): void;
  hide(): void;
  setIgnoreMouseEvents(ignore: boolean): void;
  moveTop?(): void;
  capturePage?(): Promise<{ toPNG(): Buffer } | null>;
  isDestroyed?(): boolean;
  destroy(): void;
}

export interface ToastAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ToastWindowDeps {
  /** 由装配层注入：new BrowserWindow({ ...options, parent: mainWindow, … })。 */
  createWindow(options: Record<string, unknown>): ToastWindowLike;
  /** 主窗口内容区（屏幕坐标）：Toast 以它为基准做「下方居中」。 */
  getAnchor(): ToastAnchor | null;
  /** 提示持续时长（毫秒）；缺省 4500。 */
  durationMs?: number;
  /** 定时器（测试注入假实现）。 */
  setTimeoutFn?: (callback: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export interface ToastWindowController {
  show(text: string, sticky?: boolean): void;
  hide(): void;
  destroy(): void;
}

/** Toast 窗口高度（CSS 像素）：与 HTML 里的 min-height 对齐。 */
export const TOAST_HEIGHT = 72;
/** 距离主窗口底部的距离：避开状态栏，视觉上落在「下方居中」。 */
export const TOAST_BOTTOM_GAP = 84;

/** 按文案长度估算宽度（CJK/英文混排取平均字宽），并夹在可读区间内。 */
export function toastWidthFor(text: string): number {
  const chars = Array.from(text).length;
  return Math.max(260, Math.min(720, Math.round(72 + chars * 13.5)));
}

/**
 * 计算窗口位置：以主窗口内容区为基准水平居中、贴底（留 TOAST_BOTTOM_GAP）。
 * 抽成纯函数便于单测（用户反馈过「提示没有居中」，这条不能再靠肉眼）。
 */
export function computeToastBounds(anchor: ToastAnchor, text: string): { x: number; y: number; width: number; height: number } {
  const width = toastWidthFor(text);
  const height = TOAST_HEIGHT;
  const x = Math.round(anchor.x + (anchor.width - width) / 2);
  const y = Math.round(anchor.y + anchor.height - height - TOAST_BOTTOM_GAP);
  return { x, y, width, height };
}

/** 无边框、无底板、中心最实四周渐隐的提示样式（用户 m01968 指定的渲染样式）。 */
export function buildToastHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent;overflow:hidden;}
    body{display:flex;align-items:center;justify-content:center;height:100vh;
      font:500 13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;color:#f7f2e8;opacity:0;
      animation:in 180ms ease-out forwards;}
    /* 胶囊形：形状交给 border-radius（平顶平底 + 半圆端头），
       渐隐交给 mask —— 只用径向背景会得到椭圆而不是胶囊（用户 m02086 实测方边、m02086 后仍像椭圆）。 */
    .toast{max-width:calc(100% - 16px);padding:15px 34px;text-align:center;white-space:nowrap;
      overflow:hidden;text-overflow:ellipsis;border-radius:999px;
      background:rgba(12,14,20,.93);border:0;box-shadow:none;
      -webkit-mask-image:radial-gradient(ellipse 100% 190% at 50% 50%,#000 58%,rgba(0,0,0,0) 100%);
      mask-image:radial-gradient(ellipse 100% 190% at 50% 50%,#000 58%,rgba(0,0,0,0) 100%);}
    @keyframes in{to{opacity:1;}}
  </style></head><body><div class="toast">${escaped}</div></body></html>`;
  return "data:text/html;charset=utf-8," + encodeURIComponent(html);
}

export function createToastWindow(deps: ToastWindowDeps): ToastWindowController {
  let win: ToastWindowLike | null = null;
  let timer: unknown = null;
  const duration = deps.durationMs ?? 4500;
  const schedule = deps.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
  const cancel = deps.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  const ensure = (): ToastWindowLike | null => {
    if (win && !(win.isDestroyed?.() ?? false)) return win;
    win = deps.createWindow({
      width: 320,
      height: TOAST_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      backgroundColor: "#00000000",
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: false },
    });
    win.setIgnoreMouseEvents(true);
    return win;
  };

  const hide = (): void => {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
    if (win && !(win.isDestroyed?.() ?? false)) win.hide();
  };

  return {
    show(text: string, sticky?: boolean): void {
      const clean = String(text ?? "").trim();
      if (!clean) return;
      const anchor = deps.getAnchor();
      if (!anchor) return;
      const target = ensure();
      if (!target) return;
      target.setBounds(computeToastBounds(anchor, clean));
      void Promise.resolve(target.loadURL(buildToastHtml(clean.slice(0, 300))))
        .then(() => {
          if (!win || (win.isDestroyed?.() ?? false)) return;
          win.showInactive();
          // 子窗口与原生 WebContentsView 的层级在部分 GPU 合成路径下会反过来：显式抬到最前。
          win.moveTop?.();
          // E2E：单独存一张浮窗自身截图（桌面截图会被用户其它窗口挡住，无法验证胶囊形状）。
          const shotPath = process.env.LOOPSOAR_E2E_TOAST_SHOT;
          if (shotPath) {
            void Promise.resolve(win.capturePage?.() ?? null)
              .then((image) => {
                if (!image) return;
                fs.writeFileSync(shotPath, image.toPNG());
                console.log("TOAST_SHOT_SAVED", shotPath);
              })
              .catch(() => undefined);
          }
        })
        .catch(() => undefined);
      if (timer !== null) cancel(timer);
      timer = schedule(() => {
        timer = null;
        hide();
      }, sticky ? 8000 : duration);
    },
    hide,
    destroy(): void {
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
      if (win && !(win.isDestroyed?.() ?? false)) win.destroy();
      win = null;
    },
  };
}
