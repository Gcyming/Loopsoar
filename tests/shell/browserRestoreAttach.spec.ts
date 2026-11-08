/**
 * 回归：启动恢复的网页视图必须能补挂到主窗口（用户实机 bug：重启后知乎页面变回起始页、刷新无效）。
 *
 * 崩溃现场（修复前）：
 *   index.ts 启动顺序 = 创建 BrowserHost → switchSession(初始会话, 持久化状态) 恢复标签页
 *   → 之后才 createMainWindow()。恢复路径里的 attachView 在窗口还不存在时执行，
 *   electronBrowser 的实现是 `win?.contentView.addChildView(...)`（可选链静默 no-op），
 *   而 applyLayout 只 setBounds/setVisible、从不重新挂载 → 恢复出来的 WebContentsView
 *   永远不在窗口里：DOM 起始页一直露着，刷新（navigateRecorded → emitTabs → applyLayout）
 *   也不会把它挂上去。
 *
 * 本文件在 BrowserHost 层固化修复契约：attachView 返回 false（窗口未就绪）后，
 * 下一次 syncBounds/applyLayout 必须补挂一次（且只补挂一次，幂等）。
 */
import { describe, expect, it } from "vitest";
import {
  BrowserHost,
  type BrowserHostDeps,
  type HostView,
  type PersistedBrowserState,
} from "../../packages/shell/src/main/browserHost.ts";
import { computeBrowserViewBounds, LAYOUT } from "../../packages/contracts/src/layout.ts";

const WINDOW_SIZE = { width: 1360, height: 860 };
/** 与 BrowseHost 默认侧栏宽度/底部让位一致（sidebarWidth=LAYOUT.SIDEBAR_WIDTH, bottomInset=0）。 */
const EXPECTED_BOUNDS = computeBrowserViewBounds(WINDOW_SIZE, LAYOUT);

const ZHIHU_URL = "https://cn.bing.com/search?q=%E7%9F%A5%E4%B9%8E";

interface FakeView extends HostView {
  bounds: { x: number; y: number; width: number; height: number } | null;
  visible: boolean;
  /** 模拟「已在窗口 contentView 里」：只有 attachView 真正成功时才置 true。 */
  attachedToWindow: boolean;
  navigated: string[];
}

function makeFixture(options: { failUrls?: string[] } = {}) {
  const created: FakeView[] = [];
  const attachCalls: FakeView[] = [];
  const failUrls = new Set(options.failUrls ?? []);
  /** 启动早期（恢复标签页时）主窗口还不存在 → attachView 返回 false（真机行为）。 */
  let windowReady = false;

  const host = new BrowserHost({
    createView: (): HostView => {
      const view: FakeView = {
        bounds: null,
        visible: false,
        attachedToWindow: false,
        navigated: [],
        setBounds(bounds) {
          view.bounds = bounds;
        },
        setVisible(visible) {
          view.visible = visible;
        },
        getBounds() {
          return view.bounds ?? { x: 0, y: 0, width: 0, height: 0 };
        },
        webContents: {
          async loadURL(url: string) {
            if (failUrls.has(url)) throw new Error(`net::ERR_CONNECTION_REFUSED (${url})`);
            view.navigated.push(url);
          },
          getURL: () => view.navigated[view.navigated.length - 1] ?? "",
          async capturePage() {
            return { toPNG: () => Buffer.from("png") };
          },
          async executeJavaScript(code: string) {
            if (code.includes("document.title")) return "知乎 - 搜索";
            return 0;
          },
          on() {},
        },
      };
      created.push(view);
      return view;
    },
    attachView: (view) => {
      const fake = view as FakeView;
      attachCalls.push(fake);
      // 真机 electronBrowser.attachView：没有窗口/已销毁 → false；挂载成功 → true
      if (!windowReady) return false;
      fake.attachedToWindow = true;
      return true;
    },
    detachView: () => {},
    getWindowSize: () => WINDOW_SIZE,
  } satisfies BrowserHostDeps);

  return {
    host,
    created,
    attachCalls,
    /** 模拟 createMainWindow() 完成后的时间点。 */
    markWindowReady(): void {
      windowReady = true;
    },
  };
}

const BOOT_ZHIHU: PersistedBrowserState = {
  tabs: [{ url: ZHIHU_URL, title: "知乎 - 搜索", history: [ZHIHU_URL], index: 0 }],
  activeIndex: 0,
};

describe("启动恢复：窗口创建后补挂原生视图（重启后页面变回起始页 bug）", () => {
  it("窗口未就绪时恢复的标签，在 createMainWindow 后 syncBounds 补挂一次并显示", async () => {
    const { host, created, attachCalls, markWindowReady } = makeFixture();

    // 启动顺序（index.ts）：恢复先于 createMainWindow，attachView 拿不到窗口
    await host.switchSession("sess-restore", BOOT_ZHIHU);

    expect(created).toHaveLength(1);
    expect(created[0].attachedToWindow).toBe(false);
    // 崩溃现场：状态/URL 都对（地址栏有、标签页在），但原生视图没有挂到窗口里
    expect(host.listTabs("sess-restore")[0]?.url).toBe(ZHIHU_URL);
    expect(host.debugBounds()).toMatchObject({ tabId: "tab-1", attached: false, bounds: EXPECTED_BOUNDS });
    const attemptsBeforeWindow = attachCalls.length;
    expect(attemptsBeforeWindow).toBeGreaterThanOrEqual(1);

    // index.ts: createMainWindow() 之后 browserHost.syncBounds()
    markWindowReady();
    host.syncBounds();

    expect(created[0].attachedToWindow).toBe(true);
    expect(attachCalls).toHaveLength(attemptsBeforeWindow + 1); // 窗口就绪后补挂一次
    expect(host.debugBounds().attached).toBe(true);
    // 补挂时同时应用了布局与可见性：页面真正可见、占满内容区
    expect(created[0].bounds).toEqual(EXPECTED_BOUNDS);
    expect(created[0].visible).toBe(true);

    // 幂等：后续每次布局（resize/导航/刷新）都不会重复 addChildView
    host.syncBounds();
    host.setOverlayOpen(true);
    host.setOverlayOpen(false);
    expect(attachCalls).toHaveLength(attemptsBeforeWindow + 1);
  });

  it("恢复多个标签：全部补挂，只有 activeIndex 对应标签可见（刷新不改变这一语义）", async () => {
    const { host, created, markWindowReady } = makeFixture();
    const boot: PersistedBrowserState = {
      tabs: [
        { url: "https://example.com/a", title: "A" },
        { url: "https://example.com/b", title: "B" },
        { url: "https://example.com/c", title: "C" },
      ],
      activeIndex: 1,
    };

    await host.switchSession("sess-restore", boot);
    markWindowReady();
    host.syncBounds();

    expect(created).toHaveLength(3);
    expect(created.map((view) => view.attachedToWindow)).toEqual([true, true, true]);
    // 后台标签也挂载（会话内切标签即显示），但只有活动标签可见
    expect(created.map((view) => view.visible)).toEqual([false, true, false]);
    expect(host.debugBounds().tabId).toBe("tab-2");

    // 「刷新无效」的另一面：刷新只重新导航，不改变挂载关系（修复前它永远补挂不上）
    await host.reload(undefined, "sess-restore");
    expect(created.map((view) => view.attachedToWindow)).toEqual([true, true, true]);
    expect(created.map((view) => view.visible)).toEqual([false, true, false]);
  });

  it("恢复时导航失败：标签保留 URL（显示错误页）而不是静默白屏，刷新可重试", async () => {
    const { host, created, markWindowReady } = makeFixture({ failUrls: [ZHIHU_URL] });

    await host.switchSession("sess-restore", BOOT_ZHIHU);
    markWindowReady();
    host.syncBounds();

    // 旧行为：catch 里留空 url → 标签不可见 + 白屏，用户以为页面丢了
    expect(host.listTabs("sess-restore")[0]?.url).toBe(ZHIHU_URL);
    expect(created[0].visible).toBe(true);
    // 刷新走 navigateRecorded，成功后 URL 不变、视图仍在
    const reloaded = await host.reload(undefined, "sess-restore");
    expect(reloaded).toMatchObject({ ok: false }); // 本用例 fake 仍然拒绝，但标签状态保留
    expect(host.listTabs("sess-restore")[0]?.url).toBe(ZHIHU_URL);
  });

  it("窗口就绪后恢复的标签直接挂上，不再等待下一次布局", async () => {
    const { host, created, attachCalls, markWindowReady } = makeFixture();
    markWindowReady();
    await host.switchSession("sess-live", BOOT_ZHIHU);
    expect(created).toHaveLength(1);
    expect(created[0].attachedToWindow).toBe(true);
    expect(attachCalls).toHaveLength(1);
    expect(host.debugBounds().attached).toBe(true);
  });
});
