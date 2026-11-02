/**
 * webview 兼容后端（BrowserAdapter 占位实现）用例（ADR-0003）：
 *   - 工厂可创建，导出接口的 9 个方法齐全；
 *   - 每个方法都必须抛「未实现」可读错误（不能静默返回 undefined，否则调用方会误判成功）；
 *   - 每次调用都失败（不是首次才失败），且错误信息带上方法名便于定位。
 *
 * 为什么要这条用例：webview 只承诺「接口兼容」，不承诺功能；一旦有人误把它接进主链路，
 * 必须立刻报错而不是让 Agent 挂着空结果继续跑。
 */
import { describe, expect, it } from "vitest";
import { createWebviewCompatAdapter } from "../../packages/shell/src/browserAdapter/backends/webview.ts";

const METHOD_NAMES = [
  "navigate",
  "snapshot",
  "click",
  "type",
  "scroll",
  "screenshot",
  "wait",
  "executeJs",
  "close",
] as const;

type LooseAdapter = Record<string, (...args: unknown[]) => unknown>;

function looseAdapter(): LooseAdapter {
  return createWebviewCompatAdapter() as unknown as LooseAdapter;
}

describe("webview 兼容后端（占位实现）", () => {
  it("工厂可创建，接口方法齐全（9 个）", () => {
    const adapter = createWebviewCompatAdapter();
    expect(adapter).toBeTruthy();
    const loose = adapter as unknown as LooseAdapter;
    expect(Object.keys(loose).sort()).toEqual([...METHOD_NAMES].sort());
    for (const name of METHOD_NAMES) {
      expect(typeof loose[name], `${name} 应为函数`).toBe("function");
    }
  });

  it("每个方法都抛「未实现」且错误信息包含方法名", () => {
    const adapter = looseAdapter();
    for (const name of METHOD_NAMES) {
      expect(() => adapter[name](), `${name} 应抛错`).toThrow(/未实现/);
      expect(() => adapter[name]()).toThrow(new RegExp(name));
    }
  });

  it("重复调用仍抛错（不会因状态变化静默变成可用）", () => {
    const adapter = looseAdapter();
    for (let round = 0; round < 3; round += 1) {
      expect(() => adapter.navigate("https://example.com/")).toThrow(/未实现/);
      expect(() => adapter.close()).toThrow(/未实现/);
    }
  });
});
