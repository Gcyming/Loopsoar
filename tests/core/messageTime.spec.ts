/**
 * 模型可见墙钟时间（messageTime）纯函数测试。
 */
import { describe, expect, it } from "vitest";
import {
  MESSAGE_TIME_INSTRUCTION,
  MESSAGE_TIME_PREFIX_RE,
  currentWallClockLine,
  formatWallClock,
  withWallClockPrefix,
} from "../../packages/core/src/messageTime.ts";

describe("formatWallClock", () => {
  it("格式化为本地 `YYYY-MM-DD HH:mm`，补零", () => {
    const ts = new Date(2026, 0, 5, 7, 3, 59).getTime(); // 本地 2026-01-05 07:03
    expect(formatWallClock(ts)).toBe("2026-01-05 07:03");
  });

  it("非法输入返回 null（不产生 [undefined] 脏前缀）", () => {
    expect(formatWallClock(undefined)).toBeNull();
    expect(formatWallClock(null)).toBeNull();
    expect(formatWallClock(0)).toBeNull();
    expect(formatWallClock(-1)).toBeNull();
    expect(formatWallClock(Number.NaN)).toBeNull();
    expect(formatWallClock(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("withWallClockPrefix", () => {
  it("给正文加 `[YYYY-MM-DD HH:mm] ` 前缀", () => {
    const ts = new Date(2026, 10, 8, 14, 2).getTime();
    const out = withWallClockPrefix("测试模型连通性", ts);
    expect(out).toBe("[2026-11-08 14:02] 测试模型连通性");
    expect(MESSAGE_TIME_PREFIX_RE.test(out)).toBe(true);
  });

  it("幂等：已有前缀不重复加（同一历史消息每轮生成一致，KV 缓存稳定）", () => {
    const once = withWallClockPrefix("你好", new Date(2026, 10, 8, 14, 2).getTime());
    const twice = withWallClockPrefix(once, new Date(2026, 10, 8, 15, 30).getTime());
    expect(twice).toBe(once);
  });

  it("空正文 / 无有效时间戳：原样返回", () => {
    expect(withWallClockPrefix("", 123)).toBe("");
    expect(withWallClockPrefix("正文", undefined)).toBe("正文");
  });
});

describe("系统提示与当前时间", () => {
  it("格式说明是静态文本，包含可识别的 `[YYYY-MM-DD HH:mm]` 语义", () => {
    expect(MESSAGE_TIME_INSTRUCTION).toContain("[YYYY-MM-DD HH:mm]");
    expect(MESSAGE_TIME_INSTRUCTION).toContain("本地墙钟时间");
    // 不得含具体时间（否则 stable 段每轮变化，破坏 KV 前缀缓存）
    expect(MESSAGE_TIME_INSTRUCTION).not.toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  });

  it("当前时间行随时间变化（放 volatile 段）", () => {
    const line = currentWallClockLine(new Date(2026, 10, 8, 14, 2).getTime());
    expect(line).toBe("当前本地时间：2026-11-08 14:02");
  });
});
