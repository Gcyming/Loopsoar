/**
 * 品牌 wordmark 渲染守卫：视觉小写 loopsoar，loop 用亚麻白、soar 用赭石。
 * 用 react-dom/server 真实渲染，避免只扫描源码却漏掉颜色/文字拆分错误。
 */
import { describe, expect, it } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import BrandWordmark from "../../packages/ui/src/BrandWordmark.tsx";
import { BRAND } from "../../packages/ui/src/theme.ts";

function render(props: React.ComponentProps<typeof BrandWordmark> = {}): string {
  return renderToStaticMarkup(React.createElement(BrandWordmark, props));
}

describe("BrandWordmark 官方双色字标", () => {
  it("拆成小写 loop + soar，并分别使用亚麻白/赭石", () => {
    const html = render();
    expect(html).toContain(">loop</span>");
    expect(html).toContain(">soar</span>");
    expect(html).toContain(BRAND.linen);
    expect(html).toContain(BRAND.ochre);
  });

  it("屏幕阅读器仍读作 Loopsoar（aria-label 保留大小写）", () => {
    const html = render();
    expect(html).toContain('aria-label="Loopsoar"');
  });

  it("size/weight 可覆盖，但不改变两段文字", () => {
    const html = render({ size: 12, weight: 700 });
    expect(html).toContain("font-size:12px");
    expect(html).toContain("font-weight:700");
    expect(html).toContain(">loop</span>");
    expect(html).toContain(">soar</span>");
  });
});
