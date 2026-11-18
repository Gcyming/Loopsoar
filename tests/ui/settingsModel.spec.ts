import { describe, expect, it } from "vitest";
import {
  formatHeaderLines,
  formatWhen,
  localized,
  loopKindOf,
  parseHeaderLines,
  type TFunc,
} from "../../packages/ui/src/settingsModel.ts";
import type { LoopInfo } from "../../packages/ui/src/types.ts";

const tr: TFunc = (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key);

describe("设置面板纯模型（P2-1）", () => {
  it("请求头文本 ⇄ 对象，保留值里的冒号", () => {
    const headers = parseHeaderLines("Accept: */*\nX-Test: a:b\n\n", tr);
    expect(headers).toEqual({ Accept: "*/*", "X-Test": "a:b" });
    expect(formatHeaderLines(headers)).toBe("Accept: */*\nX-Test: a:b");
    expect(formatHeaderLines(undefined)).toBe("");
  });

  it("非法行/未知模板变量给出可读错误", () => {
    expect(() => parseHeaderLines("No colon", tr)).toThrow(/headerFormatError/);
    expect(() => parseHeaderLines("Bad Key: value", tr)).toThrow(/headerKeyError/);
    expect(() => parseHeaderLines("X-Test: {{unknownVar}}", tr)).toThrow(/headerUnknownVars/);
  });

  it("Loop 类型推导优先用 backend kind，其次 id 约定", () => {
    expect(loopKindOf({ id: "anything", builtin: true } as LoopInfo)).toBe("builtin");
    expect(loopKindOf({ id: "my-loop", kind: "declarative" } as LoopInfo)).toBe("declarative");
    expect(loopKindOf({ id: "my-script", kind: "script" } as LoopInfo)).toBe("script");
    expect(loopKindOf({ id: "declarative-demo" } as LoopInfo)).toBe("declarative");
    expect(loopKindOf({ id: "script-runner" } as LoopInfo)).toBe("script");
    expect(loopKindOf({ id: "custom" } as LoopInfo)).toBe("custom");
  });

  it("翻译缺失回退原文；非法时间显示占位", () => {
    expect(localized((key) => key, "k", "fallback")).toBe("fallback");
    expect(localized((key) => `t:${key}`, "k", "fallback")).toBe("t:k");
    expect(formatWhen(0, tr)).toBe("settings.timeUnknown");
  });
});
