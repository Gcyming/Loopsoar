/**
 * 布局契约（computeBrowserViewBounds）新增选项的单一产地测试：
 *   · bottomInset：底部 DOM 面板（全宽终端）占用的高度，原生网页视图必须让出；
 *   · sidebarWidth：侧栏实际宽度（收起态 48 / 浮动卡片 / 用户拖拽值）覆盖 layout 默认值；
 *   · 圆角面板：四边内缩 BROWSER_VIEW_INSET，与 DOM 页框共用；
 *   · 夹取语义：负数归零、inset 不超过窗口高、宽高都不允许为负；
 *   · 组合/自定义 layout/省略 layout 参数的行为。
 *
 * 为什么单独一个文件：这两个参数直接决定「原生视图会不会盖住 DOM 面板 / 是否被面板盖住」，
 * 一旦算错，用户看到的是终端面板被网页盖住或网页被迫缩小到看不见，属高频回归点。
 * 基础几何（默认布局）仍由既有 tests/contracts/layout-nav.spec.ts 锚定，这里只做一次回归对齐。
 */
import { describe, expect, it } from "vitest";
import { LAYOUT, computeBrowserViewBounds } from "../../packages/contracts/src/layout.ts";

/** 常规窗口：默认布局下 宽=1280-360-2-16=902，高=800-40-48-32-16=664。 */
const BASE = { width: 1280, height: 800 };
/** 顶部让位：40(Title，含标签页)+48(Top)+8(网页面板留白)，与窗口大小无关。 */
const TOP_OFFSET = 96;

describe("computeBrowserViewBounds：基础回归", () => {
  it("不传 options 时与旧行为一致（既有 UI/shell 无需改动）", () => {
    expect(computeBrowserViewBounds(BASE)).toEqual({
      x: 8,
      y: TOP_OFFSET,
      width: 902,
      height: 664,
    });
  });
});

describe("computeBrowserViewBounds：bottomInset（全宽终端让位）", () => {
  it("只从高度中扣除 bottomInset，x/y/宽度不变", () => {
    expect(computeBrowserViewBounds(BASE, LAYOUT, { bottomInset: 260 })).toEqual({
      x: 8,
      y: TOP_OFFSET,
      width: 902,
      height: 404,
    });
  });

  it("bottomInset=0 与不传等价（终端关闭后恢复整块高度）", () => {
    expect(computeBrowserViewBounds(BASE, LAYOUT, { bottomInset: 0 })).toEqual(
      computeBrowserViewBounds(BASE),
    );
  });

  it("边界：inset 恰好等于可用高度 → 高度 0；少 1px → 高度 1（不会负值）", () => {
    expect(computeBrowserViewBounds(BASE, LAYOUT, { bottomInset: 664 }).height).toBe(0);
    expect(computeBrowserViewBounds(BASE, LAYOUT, { bottomInset: 663 }).height).toBe(1);
  });

  it("超限：inset > 窗口高 → 先按窗口高夹取，高度仍为 0（不产生负数）", () => {
    const bounds = computeBrowserViewBounds(BASE, LAYOUT, { bottomInset: 5000 });
    expect(bounds.height).toBe(0);
    expect(bounds.width).toBe(902);
  });

  it("负数 inset 按 0 处理（防止 UI 传负值把视图撑大）", () => {
    expect(computeBrowserViewBounds(BASE, LAYOUT, { bottomInset: -100 }).height).toBe(664);
  });
});

describe("computeBrowserViewBounds：sidebarWidth（侧栏实际宽度）", () => {
  it("收起态 48 不扣分隔条（rail 无 splitter）／拖拽值 542 扣 2px", () => {
    expect(computeBrowserViewBounds(BASE, LAYOUT, { sidebarWidth: 48 }).width).toBe(1280 - 48 - 16);
    expect(computeBrowserViewBounds(BASE, LAYOUT, { sidebarWidth: 542 }).width).toBe(
      1280 - 542 - 2 - 16,
    );
    // 高度不受侧栏影响
    expect(computeBrowserViewBounds(BASE, LAYOUT, { sidebarWidth: 542 }).height).toBe(664);
  });

  it("负数归零（无侧栏/无分隔条，网页铺满并保留页框留白）；大于窗口宽 → 宽度夹到 0", () => {
    expect(computeBrowserViewBounds(BASE, LAYOUT, { sidebarWidth: -10 }).width).toBe(1280 - 16);
    expect(computeBrowserViewBounds(BASE, LAYOUT, { sidebarWidth: 2000 }).width).toBe(0);
  });

  it("自定义 layout 的 SIDEBAR_WIDTH 可被 options.sidebarWidth 覆盖", () => {
    const layout = { ...LAYOUT, SIDEBAR_WIDTH: 500 };
    expect(computeBrowserViewBounds(BASE, layout).width).toBe(1280 - 500 - 2 - 16);
    expect(computeBrowserViewBounds(BASE, layout, { sidebarWidth: 600 }).width).toBe(
      1280 - 600 - 2 - 16,
    );
  });

  it("省略 layout 参数（undefined）时使用默认布局，options 仍生效", () => {
    expect(computeBrowserViewBounds(BASE, undefined, { sidebarWidth: 48, bottomInset: 100 })).toEqual({
      x: 8,
      y: TOP_OFFSET,
      width: 1280 - 48 - 16,
      height: 664 - 100,
    });
  });
});

describe("computeBrowserViewBounds：组合与夹取", () => {
  it("sidebarWidth + bottomInset 同时生效（终端全宽 + 侧栏收起/浮动的常见组合）", () => {
    expect(computeBrowserViewBounds(BASE, LAYOUT, { sidebarWidth: 542, bottomInset: 260 })).toEqual({
      x: 8,
      y: TOP_OFFSET,
      width: 1280 - 542 - 2 - 16,
      height: 664 - 260,
    });
  });

  it("小窗口 + 大 inset：宽高都夹到 0，只保留页框留白与顶部偏移", () => {
    expect(computeBrowserViewBounds({ width: 100, height: 40 }, LAYOUT, { bottomInset: 100 })).toEqual({
      x: 8,
      y: TOP_OFFSET,
      width: 0,
      height: 0,
    });
  });

  it("x/y 恒定：任何 options 都不改变视图起点（只改宽高）", () => {
    for (const bottomInset of [0, 120, 260, 664, 2000]) {
      const bounds = computeBrowserViewBounds(BASE, LAYOUT, { sidebarWidth: 48, bottomInset });
      expect(bounds.x).toBe(8);
      expect(bounds.y).toBe(TOP_OFFSET);
    }
  });

  it("契约层不取整（取整在 IPC 校验与宿主层）：小数 inset 精确扣减", () => {
    expect(computeBrowserViewBounds(BASE, LAYOUT, { bottomInset: 260.5 }).height).toBe(403.5);
  });
});
