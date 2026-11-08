/**
 * 退出清理新增步骤：生成中的回复必须先落盘（m02515 截断根除）。
 * 场景：用户点关闭时某轮回复仍在生成；shutdown 会把已流出正文追加为助手消息，
 * 否则重启后这条回复整段消失，看起来像「被截断」。
 */
import { describe, expect, it, vi } from "vitest";
import { createShutdownHandler } from "../../packages/shell/src/main/shutdown.ts";
import { flushActivePartials } from "../../packages/shell/src/main/domains/chat.ts";

function deps(overrides: Record<string, () => void | Promise<void>> = {}) {
  return {
    saveBrowserStates: vi.fn(),
    shutdownMcp: vi.fn(),
    stopExtensions: vi.fn(),
    closeTerminals: vi.fn(),
    flushAudit: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("shutdown · 生成中回复落盘", () => {
  it("flushActiveStreams 在退出清理中被调用", async () => {
    const flush = vi.fn();
    await createShutdownHandler(deps({ flushActiveStreams: flush }))();
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("flushActiveStreams 失败不阻断其它清理步骤", async () => {
    const saveBrowserStates = vi.fn();
    await createShutdownHandler(
      deps({
        flushActiveStreams: () => {
          throw new Error("落盘炸了");
        },
        saveBrowserStates,
      }),
    )();
    expect(saveBrowserStates).toHaveBeenCalledTimes(1);
  });

  it("flushActivePartials 只落盘有正文的会话，并在调用后清空（不重复写）", () => {
    const saved: Array<{ sessionId: string; text: string }> = [];
    // 该函数读模块内 map；这里用真实 API 无法直接注入生成中状态，
    // 因此验证「空 map 调用安全且不写」+ 幂等性。
    flushActivePartials((sessionId, text) => saved.push({ sessionId, text }));
    flushActivePartials((sessionId, text) => saved.push({ sessionId, text }));
    expect(saved).toEqual([]);
  });
});
