/**
 * 列表/浮层「点击列表外收起 + 再次点击按钮收起」的全局回归（用户 2026-11-10 m02263）。
 *
 * 根因（已修）：
 *   ① `PopoverApp.tsx` 在**模块加载时无条件**给 `<html>` 打 `data-popover`；主窗口也静态 import 该模块，
 *      导致整页命中 `[data-popover]`，`usePopover` 把任何点击都当成「点在浮层内部」→ 所有菜单点外面都收不起来；
 *   ② 工具栏浮层是独立子窗口：点击触发按钮时子窗口先失焦关闭，渲染层 click 回调再判断「是否打开」时
 *      状态已被清掉 → 关→开连闪；改为主进程原子 `ui:togglePopover`。
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("点击列表外收起（全局）", () => {
  const popoverApp = read("packages/ui/src/PopoverApp.tsx");

  it("主窗口不得被打上 data-popover（浮层标记只能在 ?popover= 窗口打）", () => {
    expect(popoverApp).toContain('SEARCH_PARAMS.has("popover")');
    // 旧写法：无条件打标 → 主窗口整页被当成浮层内部
    expect(popoverApp).not.toMatch(/if \(typeof document !== "undefined"\) \{\s*document\.documentElement\.dataset\.popover/);
  });

  it("usePopover 的点击外检测忽略 html/body 误标，并对 mousedown 兜底", () => {
    const popover = read("packages/ui/src/popover.ts");
    expect(popover).toContain("inside !== document.documentElement");
    expect(popover).toContain('"mousedown"');
    expect(popover).toContain("setOpen(false)");
  });

  it("内联菜单都走 usePopover：模型/权限/会话下拉", () => {
    const composer = read("packages/ui/src/Composer.tsx");
    expect(composer).toContain('usePopover("composer-model"');
    expect(composer).toContain('usePopover("composer-perm"');
    const sidebar = read("packages/ui/src/AgentSidebar.tsx");
    expect(sidebar).toContain('usePopover("app-session"');
  });
});

describe("工具栏浮层：再次点击按钮 = 收起（原子 toggle，不连闪）", () => {
  it("协议层提供 ui:togglePopover 且主进程按 isOpen() 原子切换", () => {
    const contracts = read("packages/contracts/src/schemas.ts");
    expect(contracts).toContain('"ui:togglePopover"');
    const domain = read("packages/shell/src/main/domains/chromePopover.ts");
    expect(domain).toContain("ui:togglePopover");
    expect(domain).toContain("manager.isOpen()");
  });

  it("渲染层点击走 togglePopover；浮层外点击（主窗口）走 closePopover", () => {
    const chrome = read("packages/ui/src/BrowserChrome.tsx");
    expect(chrome).toContain(".togglePopover({");
    expect(chrome).toContain("data-chrome-popover-trigger");
    const app = read("packages/ui/src/useSessionActions.ts");
    expect(app).toContain("ui.closePopover");
    expect(app).toContain("data-chrome-popover-trigger");
  });
});
