/**
 * BrowserHost（多标签）：懒创建 / URL 白名单 / 标签切换 / 浮层遮挡 / 布局同步（假 View，无 electron）。
 */
import { describe, expect, it } from "vitest";
import {
  BrowserHost,
  USER_TABS_SESSION,
  type BrowserHostDeps,
  type HostView,
} from "../../packages/shell/src/main/browserHost.ts";

interface FakeView extends HostView {
  bounds: { x: number; y: number; width: number; height: number } | null;
  navigated: string[];
  visible: boolean;
  closed: boolean;
  wcMuted: boolean;
  wcClosed: boolean;
}

function makeHost(size = { width: 1360, height: 860 }, extraDeps: Partial<BrowserHostDeps> = {}) {
  const created: FakeView[] = [];
  const host = new BrowserHost({
    createView: (): HostView => {
      const view: FakeView = {
        bounds: null,
        navigated: [],
        visible: true,
        closed: false,
        wcMuted: false,
        wcClosed: false,
        setBounds(b) {
          view.bounds = b;
        },
        setVisible(v) {
          view.visible = v;
        },
        webContents: {
          async loadURL(url: string) {
            view.navigated.push(url);
          },
          getURL: () => view.navigated[view.navigated.length - 1] ?? "",
          async capturePage() {
            return { toPNG: () => Buffer.from("png") };
          },
          async executeJavaScript(code: string) {
            if (code.includes("document.title")) return "示例页面";
            if (code.includes("location.href")) {
              return { url: "https://example.com/", title: "Example", text: "hi", elements: [] };
            }
            return 3;
          },
          on() {},
          setAudioMuted(muted: boolean) {
            view.wcMuted = muted;
          },
          close() {
            view.wcClosed = true;
          },
        },
      };
      created.push(view);
      return view;
    },
    attachView: () => {},
    detachView: (view) => {
      (view as FakeView).closed = true;
    },
    getWindowSize: () => size,
    ...extraDeps,
  });
  return { host, created };
}

describe("BrowserHost（多标签）", () => {
  it("懒创建：未导航前没有标签", async () => {
    const { host, created } = makeHost();
    expect(host.hasAnyTab()).toBe(false);
    expect(created.length).toBe(0);
    expect(await host.snapshot()).toBeNull();
    expect(await host.screenshot()).toBeNull();
  });

  it("导航创建首个标签，并对齐布局区域（含标题栏/顶栏偏移与页框留白）", async () => {
    const { host, created } = makeHost();
    const result = await host.navigate("example.com");
    expect(result.ok).toBe(true);
    expect(host.hasAnyTab()).toBe(true);
    expect(host.listTabs().length).toBe(1);
    expect(host.listTabs()[0].active).toBe(true);
    expect(created[0].navigated[0]).toBe("https://example.com/");
    // 1360x860：x=8，y=40+48+8=96，width=1360-360-2-8-4=986，height=860-40-48-32-8-4=724
    expect(created[0].bounds).toEqual({ x: 8, y: 96, width: 986, height: 724 });
  });

  it("关闭标签会真正销毁 WebContents（音视频不再继续播放）", async () => {
    const { host, created } = makeHost();
    await host.navigate("https://example.com/");
    const tabId = host.listTabs()[0].id;
    expect(await host.closeTab(tabId)).toBe(true);
    expect(created[0].wcMuted).toBe(true);
    expect(created[0].wcClosed).toBe(true);
    expect(host.listTabs().length).toBe(0);
  });

  it("新建标签并切换：同一时刻只有一个活动标签可见", async () => {
    const { host, created } = makeHost();
    await host.navigate("https://a.example");
    const id2 = (await host.newTab("https://b.example")).tabId;
    expect(host.listTabs().length).toBe(2);
    expect(host.listTabs().find((t) => t.active)?.id).toBe(id2);
    expect(created.filter((v) => v.visible).length).toBe(1);
    const first = host.listTabs().find((t) => t.id !== id2)!.id;
    expect(host.selectTab(first)).toBe(true);
    expect(host.listTabs().find((t) => t.active)?.id).toBe(first);
    expect(created.filter((v) => v.visible).length).toBe(1);
  });

  it("网页 target=_blank 建页落在当前可见会话（搜索页里不会落进后台会话组）", async () => {
    const { host } = makeHost();
    await host.navigate("https://a.example");
    host.showUserTabs();
    const result = await host.newTabInVisibleSession("https://b.example");
    expect(result.ok).toBe(true);
    const visible = host.listTabs(USER_TABS_SESSION);
    expect(visible.length).toBe(1);
    expect(visible[0].url).toBe("https://b.example/");
    expect(visible[0].active).toBe(true);
    // 后台聊天会话组不应被塞入这个用户点击产生的新页。
    expect(host.listTabs("default").length).toBe(1);
  });

  it("后台会话首次动作不抢前台视图（只建 Agent 标签，不切 visibleSession）", async () => {
    const { host } = makeHost();
    await host.navigate("https://foreground.example");
    const before = host.visibleSessionId();
    const tab = await host.ensureAgentTab("background-session");
    expect(tab).toBeTruthy();
    expect(host.visibleSessionId()).toBe(before);
    expect(host.listTabs("background-session").some((t) => t.active)).toBe(true);
  });

  it("空白新标签不显示原生视图（避免透明视图吞掉新建页鼠标事件）", async () => {
    const { host, created } = makeHost();
    const r = await host.newTab();
    expect(r.ok).toBe(true);
    expect(host.listTabs().length).toBe(1);
    const first = created[0];
    expect(first.visible).toBe(false);
    await host.navigate("https://example.com", r.tabId);
    expect(created[0].visible).toBe(true);
  });

  it("危险协议导航被拒绝，且不创建标签", async () => {
    const { host, created } = makeHost();
    const result = await host.navigate("javascript:alert(1)");
    expect(result.ok).toBe(false);
    expect(created.length).toBe(0);
  });

  it("浮层打开时隐藏原生视图（修复网页遮挡应用弹窗）", async () => {
    const { host, created } = makeHost();
    await host.navigate("https://example.com");
    host.setOverlayOpen(true);
    expect(created[0].visible).toBe(false);
    host.setOverlayOpen(false);
    expect(created[0].visible).toBe(true);
  });

  it("关闭标签：视图被销毁，活动标签回落到剩余标签", async () => {
    const { host, created } = makeHost();
    await host.navigate("https://a.example");
    const id2 = (await host.newTab("https://b.example")).tabId;
    expect(await host.closeTab(id2)).toBe(true);
    expect(host.listTabs().length).toBe(1);
    expect(created.some((v) => v.closed)).toBe(true);
    expect(host.listTabs()[0].active).toBe(true);
  });

  it("快照/截图在有活动标签后可用", async () => {
    const { host } = makeHost();
    await host.navigate("https://example.com");
    expect(await host.snapshot()).not.toBeNull();
    expect(await host.screenshot()).toBeTruthy();
  });

  it("快照/脚本可按 tabId 定位；getTab 返回指定标签状态（Slice D 标签级绑定）", async () => {
    const { host } = makeHost();
    await host.navigate("https://a.example");
    const first = host.activeTabId()!;
    const second = (await host.newTab("https://b.example")).tabId;
    expect(host.activeTabId()).toBe(second);

    // 缺省 = 该会话的活动标签；显式 tabId = 指定标签，快照返回值带上 tabId
    expect((await host.snapshot())?.tabId).toBe(second);
    expect((await host.snapshot(undefined, first))?.tabId).toBe(first);
    expect(host.getTab()?.id).toBe(second);
    expect(host.getTab(undefined, first)?.id).toBe(first);
    expect(host.getTab(undefined, "tab-404")).toBeNull();
    // 指定标签执行脚本：不落在活动标签上也能跑
    expect(await host.executeScript("1+1", undefined, first)).toBe(3);

    const empty = makeHost();
    expect(await empty.host.snapshot()).toBeNull();
    expect(empty.host.getTab()).toBeNull();
    await expect(empty.host.executeScript("1+1", undefined, "tab-404")).rejects.toThrow(/没有打开的网页标签/);
  });

  it("窗口缩放 → syncBounds 重新对齐", async () => {
    const state = { width: 1360, height: 860 };
    const created: FakeView[] = [];
    const host = new BrowserHost({
      createView: () => {
        const view = {
          bounds: null as null | { x: number; y: number; width: number; height: number },
          setBounds(b: { x: number; y: number; width: number; height: number }) {
            view.bounds = b;
          },
          setVisible() {},
          webContents: {
            async loadURL() {},
            getURL: () => "",
            async capturePage() {
              return { toPNG: () => Buffer.from("") };
            },
            async executeJavaScript() {
              return 1;
            },
            on() {},
          },
        };
        created.push(view as unknown as FakeView);
        return view as unknown as HostView;
      },
      attachView: () => {},
      detachView: () => {},
      getWindowSize: () => ({ width: state.width, height: state.height }),
    });
    await host.navigate("https://example.com");
    state.width = 1000;
    state.height = 700;
    host.syncBounds();
    expect(created[0].bounds).toEqual({ x: 8, y: 96, width: 626, height: 564 });
  });
});

describe("BrowserHost（地址与网页强绑定）", () => {
  function makeHostWithEvents() {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const host = new BrowserHost({
      createView: () =>
        ({
          setBounds() {},
          setVisible() {},
          webContents: {
            async loadURL() {},
            getURL: () => "https://example.com/",
            async capturePage() {
              return { toPNG: () => Buffer.from("") };
            },
            async executeJavaScript(code: string) {
              return code.includes("document.title") ? "Example" : 1;
            },
            on(event: string, cb: (...args: unknown[]) => void) {
              handlers.set(event, cb);
            },
          },
        }) as unknown as HostView,
      attachView: () => {},
      detachView: () => {},
      getWindowSize: () => ({ width: 1360, height: 860 }),
    });
    return { host, handlers };
  }

  it("网页内点击链接（did-navigate）→ 标签 URL/历史/地址同步数据更新", async () => {
    const { host, handlers } = makeHostWithEvents();
    await host.navigate("https://example.com/");
    // Electron 签名：(event, url, ...)
    handlers.get("did-navigate")?.({}, "https://example.com/next");
    const tab = host.listTabs()[0];
    expect(tab.url).toBe("https://example.com/next");
    expect(tab.canBack).toBe(true);
  });

  it("页面标题变化（page-title-updated）→ 标签标题同步", async () => {
    const { host, handlers } = makeHostWithEvents();
    await host.navigate("https://example.com/");
    // Electron 签名：(event, title, explicitSet)
    handlers.get("page-title-updated")?.({}, "新标题 - 站点");
    expect(host.listTabs()[0].title).toBe("新标题 - 站点");
  });
});

describe("BrowserHost（底部让位：全宽终端面板）", () => {
  it("setBottomInset 只缩短高度，不动 x/y/宽度", async () => {
    const { host, created } = makeHost();
    await host.navigate("https://example.com");
    expect(created[0].bounds).toEqual({ x: 8, y: 96, width: 986, height: 724 });
    host.setBottomInset(260);
    // 860 - 40(Title) - 48(Top) - 32(Status) - 16(页框留白) - 260(终端) = 464
    expect(created[0].bounds).toEqual({ x: 8, y: 96, width: 986, height: 464 });
  });

  it("与侧栏宽度组合：宽度和高度同时让位（互不干扰）", async () => {
    const { host, created } = makeHost();
    await host.navigate("https://example.com");
    host.setSidebarWidth(542);
    host.setBottomInset(260);
    // 宽 1360-542-2-8-4=804；高 860-136-260=464
    expect(created[0].bounds).toEqual({ x: 8, y: 96, width: 804, height: 464 });
  });

  it("debugBounds 反映 sidebarWidth/bottomInset（E2E 可据此核对让位是否生效）", async () => {
    const { host } = makeHost();
    await host.navigate("https://example.com");
    host.setSidebarWidth(542);
    host.setBottomInset(260);
    expect(host.debugBounds()).toMatchObject({
      window: { width: 1360, height: 860 },
      bounds: { x: 8, y: 96, width: 804, height: 464 },
      sidebarWidth: 542,
      bottomInset: 260,
    });
  });

  it("夹取：负数归零、超 2000 封顶、窗口不足时高度为 0（不产生负尺寸）", async () => {
    const { host, created } = makeHost();
    await host.navigate("https://example.com");
    host.setBottomInset(-100);
    expect(host.getBottomInset()).toBe(0);
    expect(created[0].bounds).toEqual({ x: 8, y: 96, width: 986, height: 724 });
    host.setBottomInset(5000);
    expect(host.getBottomInset()).toBe(2000);
    // 高度不允许为负：max(0, 860-136-2000) = 0
    expect(created[0].bounds).toEqual({ x: 8, y: 96, width: 986, height: 0 });
  });

  it("无标签时设置也记住，后续导航直接生效；inset=0 恢复整块高度（终端关闭）", async () => {
    const { host, created } = makeHost();
    host.setBottomInset(300);
    await host.navigate("https://example.com");
    expect(created[0].bounds).toEqual({ x: 8, y: 96, width: 986, height: 424 });
    host.setBottomInset(0);
    expect(created[0].bounds).toEqual({ x: 8, y: 96, width: 986, height: 724 });
  });
});

describe("BrowserHost（侧栏宽度：主进程不做逐帧动画）", () => {
  it("拖拽与展开都立即生效，不创建定时器", async () => {
    const { host, created } = makeHost();
    await host.navigate("https://example.com");
    expect(created[0].bounds).toEqual({ x: 8, y: 96, width: 986, height: 724 });
    host.setSidebarWidth(542);
    expect(host.getSidebarWidth()).toBe(542);
    expect(created[0].bounds).toEqual({ x: 8, y: 96, width: 804, height: 724 });
    // animate=true 是旧 IPC 的兼容参数：不再启动主进程动画，仍然立即落位。
    host.setSidebarWidth(360, true);
    expect(host.getSidebarWidth()).toBe(360);
    expect(created[0].bounds).toEqual({ x: 8, y: 96, width: 986, height: 724 });
  });

  it("收起态 48 不沿用拖拽最小值 240（否则左侧铺不满）", async () => {
    const { host, created } = makeHost();
    await host.navigate("https://example.com");
    host.setSidebarWidth(48, true);
    // 收起态：无分隔条让位（1360-48-16=1300）
    expect(created[0].bounds).toEqual({ x: 8, y: 96, width: 1300, height: 724 });
    expect(host.getSidebarWidth()).toBe(48);
  });

  it("无标签时也可预设宽度：后续导航直接落在最终几何", async () => {
    const { host, created } = makeHost();
    host.setSidebarWidth(48, true);
    await host.navigate("https://example.com");
    expect(created[0].bounds).toEqual({ x: 8, y: 96, width: 1300, height: 724 });
  });

  it("目标与当前相同也不会产生额外重排", async () => {
    const { host } = makeHost();
    await host.navigate("https://example.com");
    host.setSidebarWidth(360, true);
    expect(host.getSidebarWidth()).toBe(360);
  });
});

describe("BrowserHost（工作区 > 会话 > 网页）", () => {
  it("删除会话时关闭该会话名下的全部网页（一个会话可以有多张网页）", async () => {
    const { host, created } = makeHost();
    await host.navigate("https://a.example");
    await host.newTab("https://b.example");
    expect(host.listTabs().length).toBe(2);
    const closed = await host.closeSessionTabs("default");
    expect(closed).toBe(2);
    expect(host.listTabs().length).toBe(0);
    expect(created.filter((view) => view.wcClosed).length).toBe(2);
  });

  it("关闭网页不会删除会话：关完最后一张网页后会话组仍可继续新建网页", async () => {
    const { host } = makeHost();
    await host.navigate("https://a.example");
    const tabId = host.listTabs()[0].id;
    expect(await host.closeTab(tabId)).toBe(true);
    expect(host.listTabs().length).toBe(0);
    // 会话（组）还在：同一会话下还能新建网页
    const again = await host.newTab("https://c.example");
    expect(again.ok).toBe(true);
    expect(host.listTabs().length).toBe(1);
  });
});
