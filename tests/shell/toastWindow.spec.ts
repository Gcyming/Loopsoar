/**
 * 应用级 Toast 的纯逻辑：位置必须「下方居中」、文案必须转义、样式必须是中心实四周渐隐。
 * 这些是用户反复提过的两条硬要求（不被网页盖住 / 不许出现框），用单测钉住，避免以后回退。
 */
import { describe, expect, it } from "vitest";
import { buildToastHtml, computeToastBounds, toastWidthFor, TOAST_BOTTOM_GAP, TOAST_HEIGHT } from "../../packages/shell/src/main/toastWindow.ts";

describe("Toast 窗口定位与渲染", () => {
  it("水平居中、贴底留固定间距", () => {
    const anchor = { x: 100, y: 50, width: 1000, height: 800 };
    const bounds = computeToastBounds(anchor, "已切换到 Build 模式");
    expect(bounds.width).toBe(toastWidthFor("已切换到 Build 模式"));
    expect(bounds.x).toBe(anchor.x + Math.round((anchor.width - bounds.width) / 2));
    expect(bounds.y).toBe(anchor.y + anchor.height - TOAST_HEIGHT - TOAST_BOTTOM_GAP);
  });

  it("宽度夹在可读区间内（短文案不塌、长文案不铺满）", () => {
    expect(toastWidthFor("好")).toBe(260);
    expect(toastWidthFor("长".repeat(200))).toBe(720);
  });

  it("HTML 转义且无边框/无底板：只有径向渐变", () => {
    const html = decodeURIComponent(buildToastHtml("<script>x</script> & \"q\"").split(",")[1]);
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).toContain("&amp;");
    expect(html).not.toContain('border:1px');
    expect(html).toContain("radial-gradient");
    // 胶囊形：必须有圆角，否则径向渐变会在四角留下方形底（用户 m02086 实测）。
    expect(html).toContain("border-radius:999px");
  });
});
