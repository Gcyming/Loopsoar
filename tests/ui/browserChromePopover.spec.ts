/**
 * 浏览器工具栏浮层交互守卫（用户 m01845）：
 *   ① 悬停自动展开延迟放慢（600ms），且「已展开时点击一次即收起」，不再关→开连闪；
 *   ② 点击原生网页视图（DOM 收不到 pointerdown）也要收起按钮展开的列表；
 *   ③ 所有按钮展开的列表/菜单，点击列表外区域直接收起（全局规则）。
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("工具栏浮层：悬停延迟 + 点击收起不闪烁", () => {
  const chrome = read("packages/ui/src/BrowserChrome.tsx");

  it("悬停展开延迟 = 600ms（原来 250ms 太急）", () => {
    expect(chrome).toContain("const HOVER_DELAY_MS = 600;");
  });

  it("已展开时点击触发按钮 = 收起（toggle），并抑制 hover 重开", () => {
    expect(chrome).toContain("togglePopover");
    expect(chrome).toContain("suppressHoverRef");
    const more = chrome.slice(chrome.indexOf("ref={moreButtonRef}"), chrome.indexOf("ref={moreButtonRef}") + 800);
    expect(more).toContain('togglePopover("more"');
    expect(more).not.toContain('openPopover("more"');
    // 点击走主进程原子 toggle（不能依赖渲染层状态：子窗口失焦会先关闭，判断会变成关→开连闪）
    expect(chrome).toContain(".togglePopover({");
    const index = read("packages/shell/src/main/index.ts");
    expect(index).toContain('onClosed: () => pushToRenderer("chrome:popoverClosed"');
  });

  it("浮层关闭时主进程广播 chrome:popoverClosed（供渲染层同步）", () => {
    const main = read("packages/shell/src/main/chromePopover.ts");
    expect(main).toContain("deps.onClosed?.()");
    const index = read("packages/shell/src/main/index.ts");
    expect(index).toContain('onClosed: () => pushToRenderer("chrome:popoverClosed"');
    const events = read("packages/contracts/src/events.ts");
    expect(events).toContain('"chrome:popoverClosed"');
    expect(events).toContain('"chrome:dismissPopovers"');
  });
});

describe("标签页右键菜单（独立浮层，不隐藏网页）", () => {
  it("右键只请求 tabmenu 浮层，主窗口不再挂 DOM 菜单/不再触发网页让位", () => {
    const tabs = read("packages/ui/src/BrowserTabs.tsx");
    const hook = read("packages/ui/src/useBrowserTabs.ts");
    expect(tabs).toContain("onOpenTabMenu");
    expect(tabs).not.toContain("data-popover");
    expect(tabs).not.toContain("tab-context-menu");
    expect(hook).toContain('kind: "tabmenu"');
    expect(hook).toContain("tabId");
  });

  it("页面检查元素统一进入应用底部 DevTools 面板，不另开侧栏", () => {
    const browser = read("packages/shell/src/main/electronBrowser.ts");
    const menu = read("packages/shell/src/main/browserPageContextMenu.ts");
    expect(browser).toContain("setDevToolsWebContents(view.webContents)");
    expect(browser).toMatch(/onInspectElement:[\s\S]{0,180}devToolsPanel\.inspect\(/);
    expect(menu).toContain("if (options.onInspectElement) options.onInspectElement");
  });
});

describe("点击列表外区域收起（含原生网页区域）", () => {
  it("点原生网页视图获得焦点 → 主进程通知渲染层 dismissAllPopovers", () => {
    const browser = read("packages/shell/src/main/electronBrowser.ts");
    expect(browser).toContain("onViewFocused");
    expect(browser).toContain('view.webContents.on("focus"');
    const index = read("packages/shell/src/main/index.ts");
    expect(index).toContain("onViewFocused: () => {");
    expect(index).toContain("chromePopover.close()");
    expect(index).toContain('pushToRenderer("chrome:dismissPopovers"');
    const app = read("packages/ui/src/useSessionActions.ts");
    expect(app).toContain('api.on("chrome:dismissPopovers"');
    expect(app).toMatch(/chrome:dismissPopovers[\s\S]{0,220}dismissAllPopovers\(\)/);
    expect(app).toMatch(/chrome:dismissPopovers[\s\S]{0,260}closePopover\(\)/);
  });

  it("所有内联浮层走 usePopover（点击外部 / Esc / 互斥）", () => {
    const composer = read("packages/ui/src/Composer.tsx");
    expect(composer).toContain('usePopover("composer-model"');
    expect(composer).toContain('usePopover("composer-perm"');
    const sidebar = read("packages/ui/src/AgentSidebar.tsx");
    expect(sidebar).toContain('usePopover("app-session"');
    const popover = read("packages/ui/src/popover.ts");
    expect(popover).toContain('closest("[data-popover],[data-popover-trigger]")');
  });
});
