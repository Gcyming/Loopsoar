/**
 * 供应商编辑界面（大弹窗）守卫：用户 m03529 反馈
 *   · 点「编辑」整页跳到最下面、保存成功提示在最下面找不到；
 *   · 表单/表格文字挤压、截断，界面安排不合理。
 *
 * 本次修复契约（ADR-0050）：
 *   1. 编辑区改为独立大弹窗（遮罩 + role=dialog + 滚动 body + 固定底部操作栏）；
 *   2. 打开弹窗时滚动位置复位到顶部，不再依赖页面滚动；
 *   3. 保存/密钥/拉列表的反馈走右上角浮动 toast（providerToast），失败常驻、成功自动消失；
 *   4. 表格/表单给足宽度，长文本可换行，不允许挤压截断。
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { SETTINGS_I18N } from "../../packages/ui/src/i18nSettings.ts";

const ROOT = process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("供应商编辑大弹窗（避免跳页、提示可见、无挤压截断）", () => {
  const source = read("packages/ui/src/Settings.tsx") + "\n" + read("packages/ui/src/settingsUi.tsx");

  it("编辑区使用弹窗容器（遮罩 + dialog + 固定底部操作栏）而不是列表末尾内联卡片", () => {
    expect(source).toContain("S.modalBackdrop");
    expect(source).toContain("role=\"dialog\"");
    expect(source).toContain("aria-modal=\"true\"");
    expect(source).toContain("S.modalBody");
    expect(source).toContain("S.modalFoot");
    expect(source).toContain("editBodyRef");
    // 通过 Portal 挂到 document.body：设置内容区有 transform/overflow，直接内联 fixed 会被当成"页面内"元素随滚动位移
    expect(source).toContain("createPortal(");
    expect(source).toContain("document.body");
    // 打开编辑时把弹窗 body 滚动复位到顶部（不再整页跳到末尾）
    expect(source).toMatch(/editBodyRef\.current\?\.scrollTo\(\{\s*top:\s*0\s*\}\)/);
    // Esc 关闭弹窗（与遮罩/取消按钮一致）
    expect(source).toMatch(/event\.key === "Escape"/);
  });

  it("供应商操作反馈走右上角浮动 toast（成功自动消失、错误常驻），不再依赖页面底部 notice", () => {
    expect(source).toContain("providerToast");
    expect(source).toContain("providerOk");
    expect(source).toContain("providerBad");
    expect(source).toContain('role="status"');
    expect(source).toMatch(/providerOk\(tr\("settings\.providers\.saved"\)\)/);
    // 成功 toast 3.2s 自动消失
    expect(source).toMatch(/setTimeout\(\(\) => setProviderToast\(null\), 3200\)/);
  });

  it("弹窗宽度/表格最小宽度/长提示换行写入样式，保证文字不挤压", () => {
    expect(source).toMatch(/width:\s*"min\(1160px,\s*96vw\)"/);
    expect(source).toMatch(/minWidth:\s*1080/);
    expect(source).toMatch(/wordBreak:\s*"break-all"/);
    expect(source).toMatch(/overflowWrap:\s*"anywhere"/);
  });

  it("弹窗底部状态栏与操作按钮的 i18n 文案 zh/en 齐全", () => {
    for (const key of ["settings.providers.modalHint", "settings.providers.fetchSummary"]) {
      const entry = SETTINGS_I18N[key];
      expect(entry, `${key} 缺失`).toBeTruthy();
      expect(entry.zh.length).toBeGreaterThan(0);
      expect(entry.en.length).toBeGreaterThan(0);
    }
  });
});
