/**
 * 全局收起浮层（用户 m02115）：「进入其它界面后，会话内展开的列表依旧存在」。
 *
 * 规则：任何展开中的列表/浮层，在用户进入设置/整页/工作区/快照、切会话、新建会话、
 * 切浏览器标签、窗口失焦时，都必须立刻自动收起。
 * 统一入口是 popover.ts 的 dismissAllPopovers()（App 在各个切换时机调用）。
 *
 * 两层守卫：
 *   1) 单元：dismissAllPopovers() 清空登记并广播 null；claim/release 语义不变；
 *   2) 静态：凡使用 AnchoredPopover / data-popover 的 UI 文件必须出现 usePopover 或
 *      dismissAllPopovers，防止未来新增列表回到「自维护 open 状态 + 自己的 document 监听」。
 */
import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  claimPopover,
  releasePopover,
  dismissAllPopovers,
  getOpenPopoverId,
  subscribePopovers,
} from "../../packages/ui/src/popover.ts";

const ROOT = process.cwd();
const UI_SRC = path.join(ROOT, "packages", "ui", "src");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

beforeEach(() => {
  dismissAllPopovers();
});

describe("dismissAllPopovers（全局收起入口）", () => {
  it("关闭当前已登记浮层并广播 null；没有打开时不重复广播", () => {
    const seen: (string | null)[] = [];
    const unsubscribe = subscribePopovers((id) => seen.push(id));
    claimPopover("composer-perm");
    expect(getOpenPopoverId()).toBe("composer-perm");
    dismissAllPopovers();
    expect(getOpenPopoverId()).toBeNull();
    expect(seen).toEqual(["composer-perm", null]);
    const count = seen.length;
    dismissAllPopovers();
    expect(seen.length).toBe(count);
    unsubscribe();
  });

  it("claim 新浮层自动挤掉旧浮层；release 只释放自己", () => {
    claimPopover("session-list");
    claimPopover("composer-model");
    expect(getOpenPopoverId()).toBe("composer-model");
    releasePopover("session-list");
    expect(getOpenPopoverId()).toBe("composer-model");
    releasePopover("composer-model");
    expect(getOpenPopoverId()).toBeNull();
  });

  it("所有使用浮层的 UI 文件都走统一入口", () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
      }
    };
    walk(UI_SRC);
    // 浮层原语自身（AnchoredPopover 渲染 data-popover；popover.ts 是协调器）不需要再调用 usePopover。
    // PopoverApp 是独立浮层窗口（主进程按失焦/关闭管理），不属于主窗口内的列表浮层。
    const primitive = new Set(["AnchoredPopover.tsx", "popover.ts", "PopoverApp.tsx"]);
    const offenders = files
      .filter((file) => {
        if (primitive.has(path.basename(file))) return false;
        const text = fs.readFileSync(file, "utf8");
        // 只看真实用法：import AnchoredPopover 组件，或给触发按钮加了 data-popover-trigger。
        const usesPopover = /from "\.\/AnchoredPopover\.js"/.test(text) || /data-popover-trigger=/.test(text);
        if (!usesPopover) return false;
        return !/usePopover\(|dismissAllPopovers\(/.test(text);
      })
      .map((file) => path.relative(ROOT, file).replace(/\\/g, "/"));
    expect(offenders, `这些文件用了浮层但没有 usePopover/dismissAllPopovers：\n${offenders.join("\n")}`).toEqual([]);
  });

  it("点击外部的处理不吞事件（不实际调用 preventDefault / stopPropagation）", () => {
    const text = read("packages/ui/src/popover.ts");
    expect(text).not.toMatch(/\.preventDefault\(/);
    expect(text).not.toMatch(/\.stopPropagation\(/);
  });

  it("所有 usePopover 列表打开时先判断是否压到网页，并抓静态底图后再让原生视图让位", () => {
    const app = read("packages/ui/src/App.tsx");
    expect(app).toContain("useAnyPopoverOpen()");
    expect(app).toContain("popoverOverPage");
    expect(app).toContain("browserPreview");
    expect(app).toContain("useBrowserPopoverOverlay");
    const hook = read("packages/ui/src/useBrowserPopoverOverlay.ts");
    expect(hook).toContain("screenshot({})");
    expect(hook).toContain("setPopoverOverPage(true)");
    expect(hook).toContain("getBoundingClientRect()");
    expect(app).toMatch(/popoverOverPage[\s\S]{0,200}setOverlay\(\{ open: overlay \}\)/);
    expect(app).not.toMatch(/anyPopoverOpen;\s*\n\s*void api\.browser\.setOverlay/);
    const popover = read("packages/ui/src/popover.ts");
    expect(popover).toContain("export function useAnyPopoverOpen");
  });

  it("浮层层级高于所有应用页面层级（新增页面不会再盖住列表）", () => {
    const popover = read("packages/ui/src/AnchoredPopover.tsx");
    const match = popover.match(/POPOVER_Z_INDEX\s*=\s*([\d_]+)/);
    expect(match?.[1]).toBeTruthy();
    const zIndex = Number((match?.[1] ?? "").replace(/_/g, ""));
    expect(zIndex).toBeGreaterThan(100_000);
    expect(popover).toContain("zIndex: POPOVER_Z_INDEX");
  });

  it("App 在切界面/切会话/新会话/切标签/失焦时调用 dismissAllPopovers", () => {
    const app = read("packages/ui/src/App.tsx");
    expect(app).toContain('window.addEventListener("blur"');
    expect((app.match(/dismissAllPopovers\(\)/g) ?? []).length).toBeGreaterThanOrEqual(6);
    expect(app).toMatch(/const openSettings[\s\S]{0,200}dismissAllPopovers\(\)/);
    expect(app).toMatch(/const selectTab[\s\S]{0,200}dismissAllPopovers\(\)/);
    // 新建会话/新标签统一走 createFreshSessionAndTab（内部先 dismissAllPopovers）
    expect(app).toMatch(/const createFreshSessionAndTab[\s\S]{0,400}dismissAllPopovers\(\)/);
    expect(app).toMatch(/const newSession[\s\S]{0,200}createFreshSessionAndTab/);
    expect(app).toMatch(/const switchSession[\s\S]{0,200}dismissAllPopovers\(\)/);
  });
});
