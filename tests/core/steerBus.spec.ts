/**
 * 转向总线：8 条上限 / 2000 字截断 / drain 清空。
 */
import { describe, expect, it } from "vitest";
import { SteerBus } from "../../packages/core/src/steerBus.ts";

describe("转向总线", () => {
  it("最多保留 8 条（FIFO）", () => {
    const bus = new SteerBus();
    for (let i = 0; i < 10; i++) bus.push(`s${i}`);
    expect(bus.size()).toBe(8);
    expect(bus.drain()[0]).toBe("s2");
  });

  it("每条截断至 2000 字", () => {
    const bus = new SteerBus();
    bus.push("x".repeat(3000));
    expect(bus.drain()[0].length).toBe(2000);
  });

  it("drain 清空队列", () => {
    const bus = new SteerBus();
    bus.push("a");
    bus.push("b");
    expect(bus.drain()).toEqual(["a", "b"]);
    expect(bus.size()).toBe(0);
  });
});
