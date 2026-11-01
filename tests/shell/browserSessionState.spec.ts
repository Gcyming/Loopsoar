/** 会话浏览器状态持久化格式的净化：只保留 http(s)、限制数量/历史、索引钳制。 */
import { describe, expect, it } from "vitest";
import {
  sanitizeBrowserState,
  MAX_PERSISTED_TABS,
} from "../../packages/shell/src/main/browserSessionState.ts";

describe("浏览器会话状态净化", () => {
  it("拒绝非对象/空标签，过滤非 http(s)", () => {
    expect(sanitizeBrowserState(null)).toBeNull();
    expect(sanitizeBrowserState({ tabs: [] })).toBeNull();
    expect(
      sanitizeBrowserState({
        tabs: [{ url: "file:///etc/passwd" }, { url: "javascript:alert(1)" }, { url: "https://ok.example/" }],
        activeIndex: 5,
      }),
    ).toEqual({
      tabs: [{ url: "https://ok.example/", history: ["https://ok.example/"], index: 0 }],
      activeIndex: 0,
    });
  });

  it("限制标签数量与历史长度，活性索引钳制", () => {
    const tabs = Array.from({ length: 20 }, (_, i) => ({
      url: `https://example.com/${i}`,
      history: Array.from({ length: 60 }, (_, j) => `https://example.com/${i}/${j}`),
      index: 999,
    }));
    const state = sanitizeBrowserState({ tabs, activeIndex: -3 });
    expect(state?.tabs.length).toBe(MAX_PERSISTED_TABS);
    expect(state?.activeIndex).toBe(0);
    expect(state?.tabs[0].history?.length).toBe(50);
    expect(state?.tabs[0].index).toBe(49);
  });

  it("保留标题并兜底活动索引", () => {
    const state = sanitizeBrowserState({
      tabs: [
        { url: "https://a.example/", title: "  A  " },
        { url: "https://b.example/", history: ["https://x.example/", "https://b.example/"], index: 1 },
      ],
      activeIndex: 1,
    });
    expect(state?.tabs[0].title).toBe("A");
    expect(state?.activeIndex).toBe(1);
    expect(state?.tabs[1].index).toBe(1);
  });
});
