/**
 * 全屏整页/模态覆盖层不得盖住标题栏与窗口按钮（用户 m02115：「右上角关闭键点多次退不出」）。
 *
 * 根因：Settings / ChromePage / 工作区 / 快照 / 向导 / 权限确认等整页层使用 position:fixed + inset:0，
 * 把自定义 TitleBar（含最小化/最大化/关闭）盖在下面，点击关闭实际点在覆盖层上。
 *
 * 修复契约：所有整页覆盖层从标题栏下方开始（top = LAYOUT.TITLE_BAR_HEIGHT = 40px），
 * 窗口按钮在任何界面都可见可点；关闭按钮 onClick 先 dismissAllPopovers() 再关窗（含 window.close 兜底）。
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** 内联样式的整页覆盖层组件：必须显式使用契约高度 LAYOUT.TITLE_BAR_HEIGHT。 */
const INLINE_OVERLAY_FILES = [
  "packages/ui/src/Settings.tsx",
  "packages/ui/src/WorkspacePanel.tsx",
  "packages/ui/src/PermissionDialog.tsx",
];

/** CSS 类形式的整页覆盖层：必须从 40px（= LAYOUT.TITLE_BAR_HEIGHT）开始。 */
const CSS_OVERLAY_CLASSES = [".ask-overlay", ".snapshot-overlay", ".onboarding-overlay"];

const TITLE_BAR_HEIGHT_PX = 40;

/** E2E 统一断言入口：每个整页层根节点都带 data-fullpage-overlay="<kind>"。 */
const MARKER_FILES: [string, string][] = [
  ["packages/ui/src/Settings.tsx", "settings"],
  ["packages/ui/src/ChromePage.tsx", "chrome-page"],
  ["packages/ui/src/WorkspacePanel.tsx", "workspace"],
  ["packages/ui/src/SnapshotPanel.tsx", "snapshot"],
  ["packages/ui/src/Onboarding.tsx", "onboarding"],
  ["packages/ui/src/PermissionDialog.tsx", "permission"],
  ["packages/ui/src/AskUserDialog.tsx", "ask"],
];

describe("全屏覆盖层从标题栏下方开始", () => {
  it("内联覆盖层使用 LAYOUT.TITLE_BAR_HEIGHT，且不再 inset:0 铺满整窗", () => {
    for (const file of INLINE_OVERLAY_FILES) {
      const text = read(file);
      expect(text, `${file} 未 import LAYOUT / 未使用 LAYOUT.TITLE_BAR_HEIGHT`).toContain("LAYOUT.TITLE_BAR_HEIGHT");
      expect(text, `${file} 仍有铺满整窗的 inset: 0`).not.toMatch(/inset:\s*0\b/);
    }
  });

  it("CSS 覆盖层（ask / snapshot / onboarding）从 40px 开始", () => {
    const css = read("packages/ui/index.html");
    for (const className of CSS_OVERLAY_CLASSES) {
      const index = css.indexOf(`${className} {`);
      expect(index, `index.html 找不到 ${className}`).toBeGreaterThan(-1);
      const block = css.slice(index, index + 500);
      expect(block, `${className} 未从标题栏下方开始（应 inset: ${TITLE_BAR_HEIGHT_PX}px 0 0 0）`).toMatch(
        new RegExp(`inset:\\s*${TITLE_BAR_HEIGHT_PX}px\\s+0\\s+0\\s+0`),
      );
    }
  });

  it("所有整页层都带 data-fullpage-overlay 标记（E2E 统一选择器）", () => {
    for (const [file, kind] of MARKER_FILES) {
      expect(read(file), `${file} 缺少 data-fullpage-overlay="${kind}"`).toContain(`data-fullpage-overlay=`);
      expect(read(file), `${file} 的 data-fullpage-overlay 不是 "${kind}"`).toMatch(
        new RegExp(`data-fullpage-overlay=(?:"${kind}"|\\{[^}]*"${kind}")`),
      );
    }
  });

  it("ChromePage 整页 top 对齐标题栏（历史实现，防回退）", () => {
    expect(read("packages/ui/src/ChromePage.tsx")).toContain("top: LAYOUT.TITLE_BAR_HEIGHT");
  });

  it("窗口关闭按钮：先 dismissAllPopovers()，再 IPC 关闭，并有 window.close() 兜底", () => {
    const text = read("packages/ui/src/TitleBar.tsx");
    expect(text).toContain("dismissAllPopovers()");
    expect(text).toMatch(/api\.window\s*\.?\s*close\(\)/);
    expect(text).toContain("window.close()");
    // 先 dismiss 再 close：断言源码顺序
    expect(text.indexOf("dismissAllPopovers()")).toBeLessThan(text.indexOf("api.window"));
  });
});
