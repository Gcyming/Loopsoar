/**
 * placePopover 定位矩阵：四角 / 翻转 / 左右夹取 / 上下都放不下取大侧 + maxHeight /
 * 宽度超过视口 / 锚点滚出视口 / 极小视口 / 自定义 gap+margin / 属性测试（四边永不越界）。
 *
 * 为什么用纯函数测试而不是 DOM 测试：定位规则与 React/DOM 无关，
 * 矩阵化断言能覆盖“边缘截断”的所有几何边界，且不依赖 jsdom/真实浏览器。
 */
import { describe, expect, it } from "vitest";
import { placePopover, POPOVER_GAP, POPOVER_MARGIN } from "../../packages/ui/src/popoverPosition.ts";

const VIEWPORT = { width: 800, height: 600 };

function place(
  anchor: { x: number; y: number; width: number; height: number },
  size: { width: number; height: number },
  viewport = VIEWPORT,
  extra: { placement?: "bottom-start" | "bottom-end" | "top-start" | "top-end"; gap?: number; margin?: number } = {},
) {
  return placePopover({ anchor, size, viewport, ...extra });
}

/** 四边约束：返回的 top/left + 受 maxHeight/maxWidth 限制后的尺寸不得越出视口。 */
function expectInsideViewport(
  position: ReturnType<typeof placePopover>,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = POPOVER_MARGIN,
): void {
  const effectiveWidth = Math.min(size.width, position.maxWidth);
  const effectiveHeight = Math.min(size.height, position.maxHeight);
  expect(position.left).toBeGreaterThanOrEqual(margin - 1e-9);
  expect(position.top).toBeGreaterThanOrEqual(margin - 1e-9);
  expect(position.left + effectiveWidth).toBeLessThanOrEqual(viewport.width - margin + 1e-9);
  expect(position.top + effectiveHeight).toBeLessThanOrEqual(viewport.height - margin + 1e-9);
  expect(position.maxHeight).toBeGreaterThanOrEqual(0);
  expect(position.maxWidth).toBeGreaterThanOrEqual(0);
}

describe("placePopover · 默认下方 / 翻转", () => {
  it("空间充足：默认下方 start（左对齐锚点）", () => {
    const position = place({ x: 100, y: 100, width: 80, height: 24 }, { width: 200, height: 150 });
    expect(position.placement).toBe("bottom-start");
    expect(position.top).toBe(100 + 24 + POPOVER_GAP);
    expect(position.left).toBe(100);
    expect(position.maxWidth).toBe(VIEWPORT.width - POPOVER_MARGIN * 2);
    expectInsideViewport(position, { width: 200, height: 150 }, VIEWPORT);
  });

  it("下方空间不足 → 翻到上方（top-start）", () => {
    const viewport = { width: 1000, height: 800 };
    const size = { width: 200, height: 150 };
    const anchor = { x: 100, y: 700, width: 80, height: 24 };
    const position = place(anchor, size, viewport);
    expect(position.placement).toBe("top-start");
    expect(position.top).toBe(anchor.y - POPOVER_GAP - size.height);
    expect(position.left).toBe(100);
    expectInsideViewport(position, size, viewport);
  });

  it("期望 top-end 且上方够用 → top-end；上方不够翻下方并保持 end", () => {
    const size = { width: 100, height: 100 };
    const anchor = { x: 300, y: 400, width: 80, height: 20 };
    const top = place(anchor, size, VIEWPORT, { placement: "top-end" });
    expect(top.placement).toBe("top-end");
    expect(top.left).toBe(anchor.x + anchor.width - size.width);
    expect(top.top).toBe(anchor.y - POPOVER_GAP - size.height);

    const flipped = place({ x: 300, y: 60, width: 80, height: 20 }, size, VIEWPORT, { placement: "top-end" });
    expect(flipped.placement).toBe("bottom-end");
    expect(flipped.left).toBe(300 + 80 - 100);
    expect(flipped.top).toBe(60 + 20 + POPOVER_GAP);
  });
});

describe("placePopover · 上下都放不下：取大侧 + maxHeight", () => {
  it("下方更大 → 下方 + maxHeight=下方空间（贴底部但不越界）", () => {
    const viewport = { width: 400, height: 300 };
    const size = { width: 200, height: 400 };
    const anchor = { x: 100, y: 120, width: 60, height: 20 };
    const position = place(anchor, size, viewport);
    expect(position.placement).toBe("bottom-start");
    // 下方空间 = 300 - 8 - (140 + 8) = 144，比上方 104 大
    expect(position.maxHeight).toBe(144);
    expect(position.top).toBe(148);
    expectInsideViewport(position, size, viewport);
  });

  it("上方更大 → 上方 + maxHeight=上方空间（贴顶部但不越界）", () => {
    const viewport = { width: 400, height: 300 };
    const size = { width: 200, height: 400 };
    const anchor = { x: 100, y: 200, width: 60, height: 20 };
    const position = place(anchor, size, viewport);
    expect(position.placement).toBe("top-start");
    expect(position.maxHeight).toBe(184); // 200 - 8 - 8
    expect(position.top).toBe(8);
    expectInsideViewport(position, size, viewport);
  });
});

describe("placePopover · 左右夹取", () => {
  it("右边缘：start 放不下 → 换成 end 对齐", () => {
    const size = { width: 300, height: 100 };
    const anchor = { x: 700, y: 100, width: 40, height: 20 };
    const position = place(anchor, size);
    expect(position.placement).toBe("bottom-end");
    expect(position.left).toBe(anchor.x + anchor.width - size.width); // 440
    expectInsideViewport(position, size, VIEWPORT);
  });

  it("两侧都放不下 → clamp 到视口内（左/右各留 margin）", () => {
    const viewport = { width: 320, height: 400 };
    const size = { width: 300, height: 100 };
    const position = place({ x: 140, y: 60, width: 40, height: 20 }, size, viewport);
    expect(position.left).toBe(12); // clamp 到 320-8-300
    expectInsideViewport(position, size, viewport);
  });

  it("宽度超过视口 → maxWidth 收紧，左边界仍不越界", () => {
    const viewport = { width: 400, height: 600 };
    const size = { width: 2000, height: 100 };
    const position = place({ x: 50, y: 50, width: 30, height: 20 }, size, viewport);
    expect(position.maxWidth).toBe(viewport.width - POPOVER_MARGIN * 2); // 384
    expect(position.left).toBe(POPOVER_MARGIN);
    expectInsideViewport(position, size, viewport);
  });
});

describe("placePopover · 四角矩阵", () => {
  const viewport = { width: 800, height: 600 };
  const size = { width: 200, height: 120 };
  const cases: Array<[string, { x: number; y: number; width: number; height: number }, string, number, number]> = [
    ["左上", { x: 0, y: 0, width: 60, height: 20 }, "bottom-start", 28, 8],
    // 右上/右下：start 对齐会越出右边界（700+200 > 792），自动换 end（760-200=560）
    ["右上", { x: 700, y: 0, width: 60, height: 20 }, "bottom-end", 28, 560],
    ["左下", { x: 0, y: 570, width: 60, height: 20 }, "top-start", 442, 8],
    ["右下", { x: 700, y: 570, width: 60, height: 20 }, "top-end", 442, 560],
  ];
  for (const [label, anchor, expectedPlacement, expectedTop, expectedLeft] of cases) {
    it(`${label}角：${expectedPlacement}，四边不越界`, () => {
      const position = place(anchor, size, viewport);
      expect(position.placement).toBe(expectedPlacement);
      expect(position.top).toBe(expectedTop);
      expect(position.left).toBe(expectedLeft);
      expectInsideViewport(position, size, viewport);
    });
  }
});

describe("placePopover · 视口外锚点 / 极小视口 / 参数", () => {
  it("锚点滚到视口上方：仍贴在视口内（top=margin）", () => {
    const size = { width: 200, height: 100 };
    const position = place({ x: 400, y: -20, width: 40, height: 20 }, size, VIEWPORT);
    expect(position.top).toBe(POPOVER_MARGIN);
    expectInsideViewport(position, size, VIEWPORT);
  });

  it("锚点滚到视口下方：翻上方并 clamp 在视口内", () => {
    const size = { width: 200, height: 100 };
    const viewport = { width: 800, height: 600 };
    const position = place({ x: 400, y: 700, width: 40, height: 20 }, size, viewport);
    expect(position.top).toBe(viewport.height - POPOVER_MARGIN - size.height); // 492
    expectInsideViewport(position, size, viewport);
  });

  it("极小视口：margin 收紧到半屏，四边约束仍成立", () => {
    const viewport = { width: 10, height: 10 };
    const size = { width: 100, height: 100 };
    const position = place({ x: 5, y: 5, width: 2, height: 2 }, size, viewport);
    expect(position.top).toBe(5);
    expect(position.left).toBe(5);
    expect(position.maxWidth).toBe(0);
    expect(position.maxHeight).toBe(0);
    expectInsideViewport(position, size, viewport, 5);
  });

  it("自定义 gap / margin 生效", () => {
    const anchor = { x: 100, y: 300, width: 50, height: 20 };
    const size = { width: 100, height: 50 };
    const viewport = { width: 600, height: 400 };
    const position = place(anchor, size, viewport, { gap: 0, margin: 20 });
    expect(position.top).toBe(320); // anchorBottom + 0
    expect(position.left).toBe(100);
    expectInsideViewport(position, size, viewport, 20);
    expect(position.maxWidth).toBe(560);
  });

  it("畸形尺寸（NaN/负数）不产生 NaN 输出", () => {
    const position = place({ x: 10, y: 10, width: 20, height: 10 }, { width: Number.NaN, height: -5 }, VIEWPORT);
    for (const value of [position.top, position.left, position.maxHeight, position.maxWidth]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("placePopover · 属性测试（四边永不越界）", () => {
  it("锚点/尺寸/视口网格组合下，浮层始终在视口内（含 maxHeight/maxWidth 收紧）", () => {
    const viewports = [
      { width: 320, height: 240 },
      { width: 800, height: 600 },
      { width: 1440, height: 900 },
    ];
    const sizes = [
      { width: 120, height: 80 },
      { width: 300, height: 400 },
      { width: 2000, height: 2000 },
    ];
    for (const viewport of viewports) {
      for (const size of sizes) {
        for (const x of [0, 40, Math.floor(viewport.width / 2), viewport.width - 1, viewport.width + 30]) {
          for (const y of [0, 40, Math.floor(viewport.height / 2), viewport.height - 1, viewport.height + 30]) {
            const anchor = { x, y, width: 60, height: 20 };
            for (const placement of [undefined, "bottom-start", "bottom-end", "top-start", "top-end"] as const) {
              const position = place(anchor, size, viewport, placement ? { placement } : {});
              expect(["bottom-start", "bottom-end", "top-start", "top-end"]).toContain(position.placement);
              const effectiveWidth = Math.min(size.width, position.maxWidth);
              const effectiveHeight = Math.min(size.height, position.maxHeight);
              expect(position.left).toBeGreaterThanOrEqual(-1e-9);
              expect(position.top).toBeGreaterThanOrEqual(-1e-9);
              expect(position.left + effectiveWidth).toBeLessThanOrEqual(viewport.width + 1e-9);
              expect(position.top + effectiveHeight).toBeLessThanOrEqual(viewport.height + 1e-9);
            }
          }
        }
      }
    }
  });
});
