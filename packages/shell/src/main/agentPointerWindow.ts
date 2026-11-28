/**
 * Agent 虚拟指针（应用级覆盖窗口）。
 *
 * 为什么不再把光标画进网页：用户 m02991 明确指出——网页就是「电脑屏幕」，
 * Agent 的鼠标应当像真实鼠标一样浮在**最上层**，由 Loopsoar 自己绘制和移动，
 * 而不是作为 DOM 节点注入页面（注入会随页面导航消失、被 CSP/重排影响，也不是用户看到的「系统光标」）。
 *
 * 实现：一个跟随网页视图几何的透明子窗口（parent = 主窗口），
 *   · focusable:false + setIgnoreMouseEvents(true)：真实用户点击直接穿透到网页，不抢焦点；
 *   · 主进程通过 executeJavaScript 推状态（位置/高亮/涟漪/键盘提示），页面只负责画；
 *   · 坐标使用「页面 CSS 像素」，窗口本身与网页视图同尺寸同位置，因此换算只有缩放系数。
 *
 * 与截图的关系：capturePage 只截网页 WebContents，覆盖窗口不会被拍进证据图，无需临时隐藏。
 */
import { LAYOUT } from "loopsoar-contracts/layout";

export interface PointerWindowLike {
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
  loadURL(url: string): Promise<void> | void;
  showInactive(): void;
  hide(): void;
  setIgnoreMouseEvents(ignore: boolean): void;
  moveTop?(): void;
  isDestroyed?(): boolean;
  destroy(): void;
  webContents: { executeJavaScript(code: string): Promise<unknown> };
}

export interface PointerRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PointerHighlight {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AgentPointerWindowDeps {
  /** 装配层注入：new BrowserWindow({ ...options, parent: mainWindow })。 */
  createWindow(options: Record<string, unknown>): PointerWindowLike;
  /** 空闲后自动隐藏（毫秒）：动作结束光标不该长期停在页面上。 */
  idleHideMs?: number;
  setTimeoutFn?: (callback: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export interface AgentPointerController {
  /** 网页视图的屏幕矩形；null = 当前没有可见网页（覆盖窗口跟着隐藏）。 */
  setArea(rect: PointerRect | null): void;
  /** 把光标移到页面坐标（CSS 像素）。 */
  moveTo(x: number, y: number): void;
  /** 目标高亮框（页面坐标）；null = 清除。 */
  highlight(rect: PointerHighlight | null): void;
  /** 点击涟漪（缺省用当前光标位置）。 */
  click(x?: number, y?: number): void;
  /** 光标旁的键盘/输入提示（胶囊，约 1 秒后淡出）。 */
  chip(text: string): void;
  /**
   * 「常驻」开关：Agent 一轮任务开始时 hold(true)——光标一直可见（即使没动作），
   * 轮次结束后 hold(false) 再按空闲时长隐藏。用户要求 Agent 只用虚拟光标，且要看得见。
   */
  hold(active: boolean): void;
  /** 立即隐藏（stop/会话切换）。 */
  hide(): void;
  destroy(): void;
}

/** 光标热点在 SVG 左上角：把图形往左上偏 2px，视觉上箭头尖就是坐标点。 */
const CURSOR_OFFSET = 2;
/** 光标尺寸（CSS 像素）。 */
const CURSOR_SIZE = 30;

/** 用户提供的素材（m02602）：导航=箭头；忙=竖形等待符号。内联 SVG，避免 CSP/破图。 */
const CURSOR_NAV_SVG =
  '<svg viewBox="0 0 1024 1024" width="' + CURSOR_SIZE + '" height="' + CURSOR_SIZE + '" aria-hidden="true"><path d="M146.928 122.768l327.52 764 140.848-294.816 295.504-141.824L146.928 122.768z m408.32 409.264L478.4 692.912 299.28 275.088l418.048 179.168-162.08 77.76z" fill="#f5efe6" stroke="#191b21" stroke-width="36" stroke-linejoin="round" paint-order="stroke"/></svg>';
const CURSOR_BUSY_SVG =
  '<svg viewBox="0 0 1024 1024" width="' + CURSOR_SIZE + '" height="' + CURSOR_SIZE + '" aria-hidden="true"><path d="M610.6112 174.08c47.4112 0 71.0656 0 89.088 17.7152a72.704 72.704 0 0 1 6.8608 8.0896c14.6432 20.48 11.3664 40.3456 5.12 79.872-10.24 64.2048-36.5568 144.0768-101.5808 199.168A43.8272 43.8272 0 0 0 593.92 512c0 12.8 6.3488 24.7808 16.1792 33.0752 65.024 55.0912 91.3408 134.9632 101.5808 199.0656 6.2464 39.6288 9.5232 59.4944-5.12 79.9744a72.3968 72.3968 0 0 1-6.8608 8.192c-18.0224 17.6128-41.6768 17.6128-89.088 17.6128H372.3264c-47.3088 0-71.0656 0-88.9856-17.7152a72.3968 72.3968 0 0 1-6.8608-8.0896c-14.6432-20.48-11.4688-40.3456-5.12-79.872 10.24-64.2048 36.5568-144.0768 101.5808-199.168A44.032 44.032 0 0 0 389.12 512a43.8272 43.8272 0 0 0-16.1792-33.0752C307.9168 423.936 281.6 344.064 271.36 279.8592c-6.3488-39.6288-9.5232-59.4944 5.12-79.9744a72.704 72.704 0 0 1 6.8608-8.192c17.92-17.6128 41.6768-17.6128 89.088-17.6128h238.1824z m-198.144 81.408c-27.9552 0.2048-41.984 0.3072-50.9952 10.6496a35.1232 35.1232 0 0 0-3.3792 4.608c-7.0656 11.8788-3.072 23.7568 4.5056 47.3088 20.1728 62.6688 62.2592 132.5056 129.024 132.5056 66.56 0 108.544-69.7344 128.8192-132.5056 7.5776-23.552 11.3664-35.4304 4.4032-47.3088a35.0208 35.0208 0 0 0-3.3792-4.608c-9.1136-10.3424-23.04-10.4448-50.9952-10.6496-50.688-0.4096-107.3152-0.4096-158.0032 0z" fill="#f5efe6" stroke="#191b21" stroke-width="36" stroke-linejoin="round" paint-order="stroke"/></svg>';

/** 覆盖窗口的文档：透明背景 + 光标 / 高亮框 / 涟漪 / 键盘胶囊。 */
/**
 * 覆盖层应占据的屏幕区域 = 主窗口内容区原点 + 网页视图矩形。
 * 单源：矩形与原生 WebContentsView 是同一份 bounds，这里只做平移，绝不另算一套几何。
 * 返回 null 表示没有可见网页（调用方把覆盖层收成 null）。
 */
export function pointerScreenArea(
  content: { x: number; y: number } | null,
  viewRect: { x: number; y: number; width: number; height: number } | null,
): { x: number; y: number; width: number; height: number } | null {
  if (!content || !viewRect) return null;
  return {
    x: content.x + viewRect.x,
    y: content.y + viewRect.y,
    width: viewRect.width,
    height: viewRect.height,
  };
}

/** 主窗口内容区 + 网页视图矩形 → 覆盖层屏幕区域；窗口已销毁/无视图返回 null。 */
export function pointerAreaForWindow(
  window: { getContentBounds(): { x: number; y: number }; isDestroyed(): boolean } | null,
  viewRect: { x: number; y: number; width: number; height: number } | null,
): { x: number; y: number; width: number; height: number } | null {
  if (!window || window.isDestroyed()) return null;
  return pointerScreenArea(window.getContentBounds(), viewRect);
}

export function buildPointerHtml(): string {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;width:100%;height:100%;background:transparent;overflow:hidden;
      user-select:none;-webkit-user-select:none;cursor:none;}
    /* 光标：位置用 transform（GPU 合成，不触发布局）；位移做 150ms 补间，像人手移动。 */
    #cursor{position:fixed;left:0;top:0;width:${CURSOR_SIZE}px;height:${CURSOR_SIZE}px;pointer-events:none;
      opacity:0;will-change:transform;
      /* 位移由脚本按距离做缓动（CSS transition 会在远距离时显得像瞬移/闪烁）。 */
      transition:opacity 120ms ease;
      filter:drop-shadow(0 0 1.5px rgba(255,255,255,.95)) drop-shadow(0 3px 6px rgba(0,0,0,.45));}
    /* 目标高亮：与页面内旧样式同源（品牌色描边 + 10% 填充），只画在覆盖层。 */
    #highlight{position:fixed;left:0;top:0;pointer-events:none;opacity:0;box-sizing:border-box;
      border:2px solid rgba(217,138,79,.85);border-radius:8px;background:rgba(217,138,79,.10);
      transition:opacity 140ms ease;}
    #ripple{position:fixed;left:0;top:0;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;
      border:2px solid rgba(217,138,79,.9);opacity:0;pointer-events:none;}
    /* 页框呼吸灯：画在原生覆盖层里（DOM 的呼吸灯在 WebContentsView 之下，四角会被页面直角盖住）。
       用户反馈「光晕不明显、希望往中心多渲染」：除贴边描边外，加一层向页面内部扩散的
       径向渐变 + 更深的 inset 阴影，让光从四边向中心铺开，但仍保持低透明度不挡内容。 */
    #glow{position:absolute;inset:0;border-radius:${LAYOUT.BROWSER_VIEW_RADIUS}px;pointer-events:none;opacity:0;overflow:hidden;
      border:2px solid rgba(217,138,79,.92);
      background:radial-gradient(ellipse at center, rgba(217,138,79,0) 52%, rgba(217,138,79,.10) 78%, rgba(217,138,79,.24) 100%);
      /* 只用 inset 阴影：outer box-shadow 会伸出页面矩形，被覆盖窗口的方边界裁成四角方块；
         用户要的是贴合网页圆角，所以光晕必须完全画在圆角内部。 */
      box-shadow:inset 0 0 92px rgba(217,138,79,.30),inset 0 0 34px rgba(217,138,79,.34);
      transition:opacity 180ms ease;}
    #glow.on{opacity:.9;animation:glowPulse 1.6s ease-in-out infinite;}
    @keyframes glowPulse{0%,100%{opacity:.45}50%{opacity:1}}
    /* 键盘提示与全局提示同一套胶囊：圆角 999 + 中灰微透 + 轻投影。 */
    #chip{position:fixed;left:0;top:0;max-width:240px;padding:7px 14px;border-radius:999px;
      background:rgba(64,68,76,.86);color:#f7f2e8;font:500 12px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;opacity:0;
      box-shadow:0 6px 18px rgba(0,0,0,.35);text-shadow:0 1px 2px rgba(0,0,0,.55);
      transition:opacity 120ms ease;}
  </style></head><body>
    <div id="glow"></div>
    <div id="highlight"></div>
    <div id="ripple"></div>
    <div id="cursor">${CURSOR_NAV_SVG}<span id="busy" style="display:none">${CURSOR_BUSY_SVG}</span></div>
    <div id="chip"></div>
    <script>
      (() => {
        const cursor = document.getElementById('cursor');
        const glow = document.getElementById('glow');
        const highlight = document.getElementById('highlight');
        const ripple = document.getElementById('ripple');
        const chip = document.getElementById('chip');
        let rippleSeq = 0;
        let chipSeq = 0;
        let chipTimer = 0;
        let animFrame = 0;
        let curX = null;
        let curY = null;
        const place = (node, x, y) => { node.style.left = x + 'px'; node.style.top = y + 'px'; };
        /**
         * 平滑移动：按距离取 180–420ms 的缓动（easeOutCubic），跨页长距离也不会「瞬移」。
         * 第一次定位直接落点（页面刚出现时不该从左上角飞过来）。
         */
        const glideTo = (targetX, targetY) => {
          const tx = targetX - ${CURSOR_OFFSET};
          const ty = targetY - ${CURSOR_OFFSET};
          if (curX === null || curY === null) {
            curX = tx; curY = ty;
            cursor.style.transform = 'translate3d(' + tx + 'px,' + ty + 'px,0)';
            return;
          }
          const fromX = curX;
          const fromY = curY;
          const dist = Math.hypot(tx - fromX, ty - fromY);
          if (dist < 1) { curX = tx; curY = ty; return; }
          if (animFrame) cancelAnimationFrame(animFrame);
          const duration = Math.min(260, Math.max(140, dist * 0.35));
          const startedAt = performance.now();
          const step = (now) => {
            const t = Math.min(1, (now - startedAt) / duration);
            const eased = 1 - Math.pow(1 - t, 3);
            curX = fromX + (tx - fromX) * eased;
            curY = fromY + (ty - fromY) * eased;
            cursor.style.transform = 'translate3d(' + curX + 'px,' + curY + 'px,0)';
            if (t < 1) animFrame = requestAnimationFrame(step);
            else { animFrame = 0; curX = tx; curY = ty; }
          };
          animFrame = requestAnimationFrame(step);
        };
        window.__lsPointer = (state) => {
          const s = state || {};
          if (glow) {
            // 关闭时写 inline opacity:0 会盖住 .on 的 opacity/动画；再次开启必须清掉 inline 值，
            // 否则光晕只出现第一次，之后一直不可见（用户反馈「控制时光晕不明显」的隐藏原因之一）。
            if (s.glow === true) {
              glow.style.opacity = '';
              glow.classList.add('on');
            } else {
              glow.classList.remove('on');
              glow.style.opacity = '0';
            }
          }
          // 光标：热点在左上角，所以整体左移/上移一个偏移量。
          if (typeof s.x === 'number' && typeof s.y === 'number') glideTo(s.x, s.y);
          cursor.style.opacity = s.visible === false ? '0' : '1';
          const nav = cursor.querySelector('svg');
          const busy = document.getElementById('busy');
          if (nav) nav.style.display = s.busy ? 'none' : 'block';
          if (busy) busy.style.display = s.busy ? 'block' : 'none';
          if (s.highlight) {
            place(highlight, s.highlight.x, s.highlight.y);
            highlight.style.width = Math.max(0, s.highlight.width) + 'px';
            highlight.style.height = Math.max(0, s.highlight.height) + 'px';
            highlight.style.opacity = '1';
          } else {
            highlight.style.opacity = '0';
          }
          if (typeof s.ripple === 'number' && s.ripple !== rippleSeq) {
            rippleSeq = s.ripple;
            place(ripple, s.x || 0, s.y || 0);
            try {
              ripple.animate(
                [{ width: '12px', height: '12px', margin: '-6px 0 0 -6px', opacity: 1 },
                 { width: '54px', height: '54px', margin: '-27px 0 0 -27px', opacity: 0 }],
                { duration: 460, easing: 'cubic-bezier(.2,0,.2,1)' },
              );
            } catch (err) {}
          }
          if (s.chip && s.chip.seq !== chipSeq) {
            chipSeq = s.chip.seq;
            chip.textContent = s.chip.text;
            place(chip, (s.x || 0) + 24, (s.y || 0) + 18);
            chip.style.opacity = '1';
            if (chipTimer) clearTimeout(chipTimer);
            chipTimer = setTimeout(() => { chip.style.opacity = '0'; }, 1000);
          }
        };
      })();
    </script>
  </body></html>`;
  return "data:text/html;charset=utf-8," + encodeURIComponent(html);
}

/**
 * 创建覆盖窗口控制器。
 *
 * 只在需要时创建窗口（用户不开网页、Agent 不操作就完全没开销）；
 * 状态用序号去重：位置没变不重复 executeJavaScript，涟漪/提示用 seq 触发一次性动画。
 */
export function createAgentPointerWindow(deps: AgentPointerWindowDeps): AgentPointerController {
  let win: PointerWindowLike | null = null;
  let ready = false;
  let pending: Record<string, unknown> | null = null;
  let area: PointerRect | null = null;
  let x = 0;
  let y = 0;
  let highlight: PointerHighlight | null = null;
  let ripple = 0;
  let chip: { text: string; seq: number } | null = null;
  let hideTimer: unknown = null;
  let held = false;
  let everMoved = false;
  /** 窗口当前是否可见 / 上次应用的几何：避免每次动作都 showInactive + setBounds（会闪）。 */
  let windowVisible = false;
  let appliedArea: PointerRect | null = null;
  const sameRect = (a: PointerRect, b: PointerRect): boolean =>
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  const idleHideMs = deps.idleHideMs ?? 1600;
  const schedule = deps.setTimeoutFn ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const cancel = deps.clearTimeoutFn ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  const alive = (): PointerWindowLike | null => {
    if (!win || (win.isDestroyed?.() ?? false)) return null;
    return win;
  };

  const flush = (): void => {
    const target = alive();
    if (!target) return;
    const state = {
      x,
      y,
      visible: area !== null,
      highlight,
      ripple,
      glow: held,
      ...(chip ? { chip } : {}),
    };
    if (!ready) {
      pending = state;
      return;
    }
    void target.webContents.executeJavaScript(`window.__lsPointer && window.__lsPointer(${JSON.stringify(state)})`).catch(() => undefined);
  };

  const ensure = (): PointerWindowLike | null => {
    const existing = alive();
    if (existing) return existing;
    win = deps.createWindow({
      width: Math.max(1, area?.width ?? 320),
      height: Math.max(1, area?.height ?? 240),
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    ready = false;
    const load = win.loadURL(buildPointerHtml());
    Promise.resolve(load)
      .catch(() => undefined)
      .then(() => {
        const target = alive();
        if (!target) return;
        ready = true;
        try {
          target.setIgnoreMouseEvents(true);
        } catch {
          // 平台不支持时忽略：覆盖窗口仍可工作，只是用户点击会被挡（Windows/macOS 均支持）。
        }
        if (area) target.showInactive();
        if (pending) {
          const state = pending;
          pending = null;
          void target.webContents.executeJavaScript(`window.__lsPointer && window.__lsPointer(${JSON.stringify(state)})`).catch(() => undefined);
        }
      });
    return win;
  };

  const show = (): void => {
    if (!area) return;
    const target = ensure();
    if (!target) return;
    if (hideTimer) {
      cancel(hideTimer);
      hideTimer = null;
    }
    if (!appliedArea || !sameRect(appliedArea, area)) {
      target.setBounds(area);
      appliedArea = { ...area };
    }
    if (!windowVisible) {
      target.setIgnoreMouseEvents(true);
      target.showInactive();
      windowVisible = true;
    }
    // 不再每次动作都 moveTop：子窗口本就压在父窗口之上，频繁调整 z 序在 Windows 上是
    // 额外的原生风险点（这次 electron.exe 崩溃排查中被列为次要嫌疑）。
  };

  const armHide = (): void => {
    // 任务进行中不自动隐藏：光标是「Agent 正在操作」的持续信号，不是一次性动画。
    if (held) return;
    if (!area) return;
    if (hideTimer) cancel(hideTimer);
    hideTimer = schedule(() => {
      hideTimer = null;
      alive()?.hide();
      windowVisible = false;
    }, idleHideMs);
  };

  return {
    setArea(rect: PointerRect | null): void {
      const next = rect
        ? {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.max(1, Math.round(rect.width)),
            height: Math.max(1, Math.round(rect.height)),
          }
        : null;
      const same =
        (!next && !area) ||
        (next && area && next.x === area.x && next.y === area.y && next.width === area.width && next.height === area.height);
      area = next;
      if (!area) {
        if (hideTimer) {
          cancel(hideTimer);
          hideTimer = null;
        }
        // 换会话/关网页：隐藏并把视觉状态清空，下一段会话出现时不会带上一段的残影。
        highlight = null;
        chip = null;
        alive()?.hide();
        windowVisible = false;
        return;
      }
      // setArea 只对齐几何，不创建窗口：真正的动作（moveTo/click/chip）才需要「鼠标」。
      if (!same) {
        const target = alive();
        if (target) {
          target.setBounds(area);
          appliedArea = { ...area };
          // 空闲隐藏后拖窗/缩放只更新几何，不能把光标重新显示出来（否则会留一个幽灵光标）。
          if (ready && (held || windowVisible)) {
            target.showInactive();
            windowVisible = true;
          }
        }
      }
      // 常驻期间页面才出现（加载完成/切到可见会话）：立刻把光标亮出来，不等下一次动作。
      if (held) {
        if (!everMoved) {
          x = Math.round(area.width / 2);
          y = Math.round(area.height / 2);
        }
        show();
        flush();
      }
    },

    moveTo(nextX: number, nextY: number): void {
      everMoved = true;
      x = Math.round(nextX);
      y = Math.round(nextY);
      show();
      flush();
      armHide();
    },

    highlight(next: PointerHighlight | null): void {
      highlight = next
        ? {
            x: Math.round(next.x),
            y: Math.round(next.y),
            width: Math.max(0, Math.round(next.width)),
            height: Math.max(0, Math.round(next.height)),
          }
        : null;
      // 只清高亮时不再强制显示窗口：否则空闲隐藏后 700ms 的「淡出」会把光标又亮出来。
      if (highlight) show();
      flush();
      armHide();
    },

    click(atX?: number, atY?: number): void {
      if (typeof atX === "number" && typeof atY === "number") {
        x = Math.round(atX);
        y = Math.round(atY);
      }
      ripple += 1;
      show();
      flush();
      armHide();
    },

    chip(text: string): void {
      chip = { text, seq: (chip?.seq ?? 0) + 1 };
      show();
      flush();
      armHide();
    },

    hold(active: boolean): void {
      held = active;
      if (active) {
        if (hideTimer) {
          cancel(hideTimer);
          hideTimer = null;
        }
        if (!area) return;
        if (!everMoved) {
          x = Math.round(area.width / 2);
          y = Math.round(area.height / 2);
        }
        show();
        flush();
        return;
      }
      armHide();
    },

    hide(): void {
      held = false;
      if (hideTimer) {
        cancel(hideTimer);
        hideTimer = null;
      }
      highlight = null;
      chip = null;
      alive()?.hide();
      windowVisible = false;
    },

    destroy(): void {
      if (hideTimer) {
        cancel(hideTimer);
        hideTimer = null;
      }
      try {
        win?.destroy();
      } catch {
        // 已销毁：忽略
      }
      win = null;
      ready = false;
      windowVisible = false;
      appliedArea = null;
    },
  };
}
