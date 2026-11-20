/**
 * Agent「像用户一样」的真实输入驱动（从 BrowserHost 拆出）。
 *
 * 为什么单独一层：点击/输入/悬停/拖拽/滚轮/按键这六个动作共享同一套危险前置——
 * 必须等视图真正可见（隐藏视图 sendInputEvent 会撞 Chromium 原生空指针，JS 接不住）、
 * 必须在每个 await 之后重新确认标签还活着、必须用 epoch 令牌让页面接管锁放行但又不误清后续输入。
 * 这四条规则原先散落在 6 个方法里各写一遍，任何一个漏写都是进程级崩溃。
 *
 * 现在：规则只在这里写一次（`alive` / `waitReady` / 驱动令牌），BrowserHost 只保留同名转发，
 * 外部调用点与测试完全不需要改。
 */
import { buildAgentDrivingScript } from "../browserAdapter/refs.js";

/** sendInputEvent/getZoomFactor 的最小面：真实 WebContents 满足，测试假件可选实现。 */
export interface AgentInputWebContents {
  sendInputEvent?: (event: Record<string, unknown>) => void;
  getZoomFactor?: () => number;
  /** 输入法式插入（CJK 等无法用单键字符表达的文字）；可信输入，会触发 beforeinput/input。 */
  insertText?: (text: string) => void;
  isDestroyed?: () => boolean;
}

/** 参与输入注入的标签项（结构类型，避免把宿主内部 TabEntry 暴露出去）。 */
export interface AgentInputTab {
  view: { webContents?: unknown };
  adapter: { executeJs(script: string): Promise<unknown> };
  /** undefined = 尚未 setVisible 过（视为「可能可见」，与旧实现一致）。 */
  lastVisible?: boolean;
}

export interface AgentInputHost {
  activeSessionId(): string;
  /** 解析目标标签（缺省=会话活动标签）；不存在返回 null。 */
  resolve(tabId: string | undefined, sessionId: string | undefined): [string, AgentInputTab] | null;
  /** 页面缩放（坐标换算用）。 */
  zoom(sessionId?: string, tabId?: string): number;
  /** 该 entry 是否仍属于指定会话/标签（标签可能已被关闭或替换）。 */
  owns(entry: AgentInputTab, sessionId: string | undefined, tabId: string): boolean;
}

/** 按键白名单里的命名键 → Electron keyCode（单字符直接用字符本身）。 */
const ELECTRON_KEY_CODES: Record<string, string> = {
  Enter: "Enter",
  Tab: "Tab",
  Escape: "Escape",
  Backspace: "Backspace",
  Delete: "Delete",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
};

/** 每次开始输入都递增的 epoch：旧的 120ms 释放定时器不能清掉新一次输入的放行。 */
export class AgentInputDriver {
  private drivingTokens = new Map<AgentInputTab, number>();

  constructor(private readonly host: AgentInputHost) {}

  /**
   * 输入注入前的最小存活检查：标签可能在我们 await 的几十毫秒里被关闭/导航销毁，
   * 对已销毁的 WebContents 调 sendInputEvent 会走到 Chromium 的空指针（进程级崩溃，无法 try/catch）。
   */
  private alive(entry: AgentInputTab, sessionId: string | undefined, tabId: string): boolean {
    const wc = entry.view.webContents as AgentInputWebContents | undefined;
    if (!wc || (typeof wc.isDestroyed === "function" && wc.isDestroyed())) return false;
    // 隐藏中的 WebContentsView 没有可接收输入的 RenderWidgetHostView：对隐藏视图 sendInputEvent
    // 会走到原生空指针（electron.exe 直接 AV，JS try/catch 接不住）。
    if (entry.lastVisible === false) return false;
    return this.host.owns(entry, sessionId, tabId);
  }

  /** 等页面真正可见再注入输入（刚克隆/正在加载时视图是隐藏的）。最多等 900ms。 */
  private async waitReady(entry: AgentInputTab, sessionId: string | undefined, tabId: string): Promise<boolean> {
    const deadline = Date.now() + 900;
    while (Date.now() < deadline) {
      if (this.alive(entry, sessionId, tabId) && entry.lastVisible === true) return true;
      if (!this.alive(entry, sessionId, tabId)) return false;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    return this.alive(entry, sessionId, tabId) && entry.lastVisible === true;
  }

  /** 置位「Agent 正在派发真实输入」并返回本次 epoch，页面接管锁据此放行。 */
  private async beginDriving(entry: AgentInputTab): Promise<number> {
    const token = (this.drivingTokens.get(entry) ?? 0) + 1;
    this.drivingTokens.set(entry, token);
    try {
      await entry.adapter.executeJs(buildAgentDrivingScript(true));
    } catch {
      // 页面正在导航/未就绪：锁同样不存在，无需放行
    }
    return token;
  }

  /** 只释放自己那次放行；事件异步派发，留 120ms 窗口，但不能把后续输入的一起清掉。 */
  private endDriving(entry: AgentInputTab, token: number): void {
    setTimeout(() => {
      if (this.drivingTokens.get(entry) !== token) return;
      this.drivingTokens.delete(entry);
      try {
        void entry.adapter.executeJs(buildAgentDrivingScript(false));
      } catch {
        // 页面已销毁/未就绪
      }
    }, 120);
  }

  /**
   * Agent 点击：按页面 CSS 坐标派发**真实鼠标事件**（mouseMove → mouseDown → mouseUp）。
   *
   * 为什么不用 el.click()：用户 m02991 要求 Agent 像人一样用鼠标——只有真实输入事件才会经过
   * Chromium 的命中测试、焦点、:active/hover 与页面自己的 pointer 事件链路；el.click() 只触发 click。
   * 返回 false = 视图不支持 sendInputEvent（测试假件/旧后端），调用方回退到脚本点击。
   */
  async click(
    sessionId: string | undefined,
    tabId: string | undefined,
    point: { x: number; y: number },
  ): Promise<boolean> {
    const resolved = this.host.resolve(tabId, sessionId);
    if (!resolved) return false;
    const [tid, entry] = resolved;
    const sid = sessionId ?? this.host.activeSessionId();
    const wc = entry.view.webContents as AgentInputWebContents | undefined;
    if (!wc || typeof wc.sendInputEvent !== "function") return false;
    const zoom = this.host.zoom(sessionId, tabId);
    const x = Math.round(point.x * zoom);
    const y = Math.round(point.y * zoom);
    if (!(await this.waitReady(entry, sid, tid))) return false;
    const drivingToken = await this.beginDriving(entry);
    try {
      if (!this.alive(entry, sid, tid)) return false;
      wc.sendInputEvent({ type: "mouseMove", x, y });
      wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
      // 真实按压有几十毫秒的停留：立刻 up 会让 :active 一闪而过，部分站点的手势识别也收不到。
      await new Promise((resolve) => setTimeout(resolve, 35));
      if (!this.alive(entry, sid, tid)) return false;
      wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
    } finally {
      this.endDriving(entry, drivingToken);
    }
    if (process.env.LOOPSOAR_DEBUG_BROWSER === "1") {
      console.log("[agent-click]", JSON.stringify({ zoom, x, y }));
    }
    return true;
  }

  /**
   * Agent 逐字输入：像用户一样先全选再一个字一个字敲。
   *
   * - 开始先用 Ctrl+A 选中已有内容（首字自然替换），空文本则 Backspace 清空；
   * - ASCII 可见字符逐字派发 keyDown/char/keyUp（真实键盘事件，React 受控组件、onKeyDown 都生效）；
   * - CJK 等非 ASCII 走 insertText（等价输入法上屏；单键事件无法表达汉字），成段插入后让出一次事件循环保证顺序；
   * - 多行（textarea/contenteditable）用 Enter 换行；单行 input 把换行折成空格（input 本身也不接受换行）。
   *
   * 返回 false = 视图不支持 sendInputEvent（测试假件/旧后端），调用方回退原生 setter。
   */
  async type(
    sessionId: string | undefined,
    tabId: string | undefined,
    text: string,
    options: { multiline?: boolean } = {},
  ): Promise<boolean> {
    const resolved = this.host.resolve(tabId, sessionId);
    if (!resolved) return false;
    const [tid, entry] = resolved;
    const sid = sessionId ?? this.host.activeSessionId();
    const wc = entry.view.webContents as AgentInputWebContents | undefined;
    if (!wc || typeof wc.sendInputEvent !== "function") return false;
    const multiline = options.multiline === true;
    const normalized = text.replace(/\r\n?/g, "\n");
    const body = multiline ? normalized : normalized.replace(/\n/g, " ");
    if (!(await this.waitReady(entry, sid, tid))) return false;
    const drivingToken = await this.beginDriving(entry);
    try {
      // 全选 + 退格 = 清空当前内容（和用户「点进来、全选、重输」完全一致）。
      // macOS 全选是 Command+A，Control+A 只会把光标移到行首。
      const selectAll = process.platform === "darwin" ? ["meta"] : ["control"];
      wc.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: selectAll });
      wc.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: selectAll });
      wc.sendInputEvent({ type: "keyDown", keyCode: "Backspace" });
      wc.sendInputEvent({ type: "keyUp", keyCode: "Backspace" });
      const chars = Array.from(body);
      let pendingText = "";
      const flushText = async (): Promise<void> => {
        if (!pendingText || !this.alive(entry, sid, tid)) return;
        const chunk = pendingText;
        pendingText = "";
        if (typeof wc.insertText === "function") {
          wc.insertText(chunk);
          // 让 IPC/渲染进程把这段文本上屏，避免后续按键插到它前面（顺序敏感）。
          await new Promise((resolve) => setTimeout(resolve, 0));
        } else {
          for (const ch of chunk) wc.sendInputEvent?.({ type: "char", keyCode: ch });
        }
      };
      for (const ch of chars) {
        if (!this.alive(entry, sid, tid)) return false;
        if (ch === "\n") {
          await flushText();
          wc.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
          wc.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
          continue;
        }
        const code = ch.codePointAt(0) ?? 0;
        if (code >= 0x20 && code <= 0x7e) {
          await flushText();
          wc.sendInputEvent({ type: "keyDown", keyCode: ch });
          wc.sendInputEvent({ type: "char", keyCode: ch });
          wc.sendInputEvent({ type: "keyUp", keyCode: ch });
        } else {
          pendingText += ch;
        }
      }
      await flushText();
    } finally {
      this.endDriving(entry, drivingToken);
    }
    return true;
  }

  /** 真实鼠标移动（悬停）：像用户把鼠标移过去停住，触发 CSS :hover / pointerover / mouseover。 */
  async hover(
    sessionId: string | undefined,
    tabId: string | undefined,
    point: { x: number; y: number },
  ): Promise<boolean> {
    const resolved = this.host.resolve(tabId, sessionId);
    if (!resolved) return false;
    const [tid, entry] = resolved;
    const sid = sessionId ?? this.host.activeSessionId();
    const wc = entry.view.webContents as AgentInputWebContents | undefined;
    if (!wc || typeof wc.sendInputEvent !== "function") return false;
    const zoom = this.host.zoom(sessionId, tabId);
    const x = Math.round(point.x * zoom);
    const y = Math.round(point.y * zoom);
    if (!(await this.waitReady(entry, sid, tid))) return false;
    const drivingToken = await this.beginDriving(entry);
    try {
      if (!this.alive(entry, sid, tid)) return false;
      wc.sendInputEvent({ type: "mouseMove", x, y });
    } finally {
      this.endDriving(entry, drivingToken);
    }
    return true;
  }

  /** 页面视口中心（CSS 像素）：滚动/悬停前把虚拟光标停到页面中间。 */
  async viewportCenter(
    sessionId: string | undefined,
    tabId: string | undefined,
  ): Promise<{ x: number; y: number } | null> {
    const entry = this.host.resolve(tabId, sessionId)?.[1] ?? null;
    if (!entry) return null;
    try {
      const size = (await entry.adapter.executeJs("({ w: window.innerWidth, h: window.innerHeight })")) as
        | { w?: number; h?: number }
        | null;
      const w = typeof size?.w === "number" && size.w > 0 ? size.w : 800;
      const h = typeof size?.h === "number" && size.h > 0 ? size.h : 600;
      return { x: Math.round(w / 2), y: Math.round(h / 2) };
    } catch {
      return { x: 400, y: 300 };
    }
  }

  /**
   * Agent 拖拽：真实按下 → 分帧移动（像人手拖动）→ 抬起。
   * 用于滑块、拖拽排序、画布/编辑器等需要按下-移动-抬起序列的场景。
   */
  async drag(
    sessionId: string | undefined,
    tabId: string | undefined,
    from: { x: number; y: number },
    to: { x: number; y: number },
    steps = 10,
  ): Promise<boolean> {
    const resolved = this.host.resolve(tabId, sessionId);
    if (!resolved) return false;
    const [tid, entry] = resolved;
    const sid = sessionId ?? this.host.activeSessionId();
    const wc = entry.view.webContents as AgentInputWebContents | undefined;
    if (!wc || typeof wc.sendInputEvent !== "function") return false;
    const zoom = this.host.zoom(sessionId, tabId);
    const fx = Math.round(from.x * zoom);
    const fy = Math.round(from.y * zoom);
    const tx = Math.round(to.x * zoom);
    const ty = Math.round(to.y * zoom);
    const frames = Math.max(3, Math.min(20, Math.round(steps)));
    if (!(await this.waitReady(entry, sid, tid))) return false;
    const drivingToken = await this.beginDriving(entry);
    try {
      if (!this.alive(entry, sid, tid)) return false;
      wc.sendInputEvent({ type: "mouseMove", x: fx, y: fy });
      wc.sendInputEvent({ type: "mouseDown", x: fx, y: fy, button: "left", clickCount: 1 });
      for (let i = 1; i <= frames; i += 1) {
        if (!this.alive(entry, sid, tid)) return false;
        const ratio = i / frames;
        const x = Math.round(fx + (tx - fx) * ratio);
        const y = Math.round(fy + (ty - fy) * ratio);
        wc.sendInputEvent({ type: "mouseMove", x, y });
        await new Promise((resolve) => setTimeout(resolve, 14));
      }
      if (!this.alive(entry, sid, tid)) return false;
      wc.sendInputEvent({ type: "mouseUp", x: tx, y: ty, button: "left", clickCount: 1 });
    } finally {
      this.endDriving(entry, drivingToken);
    }
    return true;
  }

  /**
   * 真实滚轮：按 notch（120px）把滚动量拆成多帧 mouseWheel 派发，页面收到的是可信滚轮事件，
   * 滚动动画、滚动监听、懒加载、吸顶效果都与用户操作一致（脚本 window.scrollBy 不具备这些）。
   * 返回 false = 视图不支持 sendInputEvent，调用方回退脚本滚动。
   */
  async scroll(
    sessionId: string | undefined,
    tabId: string | undefined,
    deltaY: number,
  ): Promise<boolean> {
    const resolved = this.host.resolve(tabId, sessionId);
    if (!resolved) return false;
    const [tid, entry] = resolved;
    const sid = sessionId ?? this.host.activeSessionId();
    const wc = entry.view.webContents as AgentInputWebContents | undefined;
    if (!wc || typeof wc.sendInputEvent !== "function") return false;
    const center = (await this.viewportCenter(sessionId, tabId)) ?? { x: 400, y: 300 };
    const zoom = this.host.zoom(sessionId, tabId);
    const x = Math.round(center.x * zoom);
    const y = Math.round(center.y * zoom);
    const total = Math.round(deltaY);
    if (!Number.isFinite(total) || total === 0) return false;
    const dir = total > 0 ? 1 : -1;
    const ticks = Math.min(42, Math.max(1, Math.ceil(Math.abs(total) / 120)));
    if (!(await this.waitReady(entry, sid, tid))) return false;
    const drivingToken = await this.beginDriving(entry);
    try {
      for (let i = 0; i < ticks; i += 1) {
        if (!this.alive(entry, sid, tid)) return false;
        wc.sendInputEvent({
          type: "mouseWheel",
          x,
          y,
          deltaX: 0,
          // 一律整数值：Chromium 的滚轮输入对非整数 delta / wheelTicks 存在原生边界，
          // 之前用 fractional step 是这次 electron.exe 崩溃的重点怀疑对象。
          deltaY: dir * 120,
          wheelTicksX: 0,
          wheelTicksY: dir,
          canScroll: true,
        });
        if (i < ticks - 1) await new Promise((resolve) => setTimeout(resolve, 12));
      }
    } finally {
      this.endDriving(entry, drivingToken);
    }
    return true;
  }

  /**
   * Agent 按键：sendInputEvent 派发真实键盘事件（Enter/Tab/Esc/方向键/单字符）。
   * 与点击同理——页面拿到的是可信事件，表单默认行为（提交/跳转/关闭）才会真的发生。
   */
  async pressKey(sessionId: string | undefined, tabId: string | undefined, key: string): Promise<boolean> {
    const resolved = this.host.resolve(tabId, sessionId);
    if (!resolved) return false;
    const [tid, entry] = resolved;
    const sid = sessionId ?? this.host.activeSessionId();
    const wc = entry.view.webContents as AgentInputWebContents | undefined;
    if (!wc || typeof wc.sendInputEvent !== "function") return false;
    const keyCode = ELECTRON_KEY_CODES[key] ?? (key.length === 1 ? key : null);
    if (!keyCode) return false;
    if (!(await this.waitReady(entry, sid, tid))) return false;
    const drivingToken = await this.beginDriving(entry);
    try {
      if (!this.alive(entry, sid, tid)) return false;
      wc.sendInputEvent({ type: "keyDown", keyCode });
      // Enter 的表单提交由 keypress/char 驱动，只发 keyDown/keyUp 在 Chromium 里不会触发默认行为。
      if (key.length === 1) wc.sendInputEvent({ type: "char", keyCode });
      else if (key === "Enter") wc.sendInputEvent({ type: "char", keyCode: "\r" });
      wc.sendInputEvent({ type: "keyUp", keyCode });
    } finally {
      this.endDriving(entry, drivingToken);
    }
    return true;
  }
}
