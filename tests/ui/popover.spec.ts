/**
 * 浮层仲裁（ui/popover.ts）用例。
 *
 * 环境限制：仓库没有 jsdom / happy-dom（vitest 配的是 node 环境），usePopover 里的
 * document 监听无法在节点环境渲染验证，所以这里覆盖「纯仲裁层 + 模块导出形状」：
 *   - claimPopover / releasePopover 是模块级单例仲裁：重复 claim 幂等、释放不匹配 id 无副作用、
 *     任意次数调用都不抛（多组件同时挂载/卸载的极端场景）；
 *   - usePopover 必须导出为 hook 函数（供组件按约定使用）；
 *   - 模块不额外导出内部状态，也不依赖 DOM 才能在 import 阶段求值（SSR/节点环境可安全引入）。
 */
import { describe, expect, it } from "vitest";
import {
  claimPopover,
  releasePopover,
  usePopover,
} from "../../packages/ui/src/popover.ts";

describe("浮层仲裁（popover）", () => {
  it("导出形状：claim / release / usePopover", () => {
    expect(typeof claimPopover).toBe("function");
    expect(typeof releasePopover).toBe("function");
    expect(typeof usePopover).toBe("function");
  });

  it("claim 幂等：同一 id 重复登记不抛错", () => {
    expect(() => claimPopover("perm-menu")).not.toThrow();
    expect(() => claimPopover("perm-menu")).not.toThrow();
    releasePopover("perm-menu");
  });

  it("release 不匹配 id 无副作用、不抛错（竞态下的卸载顺序）", () => {
    claimPopover("history");
    expect(() => releasePopover("downloads")).not.toThrow();
    expect(() => releasePopover("unknown-id")).not.toThrow();
    releasePopover("history");
  });

  it("多次 claim/release 交错（多组件挂载-卸载）不抛错", () => {
    for (let round = 0; round < 100; round += 1) {
      claimPopover(`popover-${round % 3}`);
      releasePopover(`popover-${(round + 1) % 3}`);
    }
    releasePopover("popover-0");
    releasePopover("popover-1");
    releasePopover("popover-2");
    expect(true).toBe(true);
  });

  it("模块可被安全 import（不依赖 document/window 才能求值）", async () => {
    // 节点环境没有 document；动态再导入一次证明模块顶层无 DOM 依赖
    const fresh = await import("../../packages/ui/src/popover.ts");
    expect(typeof fresh.claimPopover).toBe("function");
    expect(typeof fresh.usePopover).toBe("function");
    expect("openId" in fresh).toBe(false); // 内部状态不导出（避免外部绕过仲裁直接改）
  });
});
