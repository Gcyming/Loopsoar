/**
 * 转向总线（slime steerBus 结构化移植）：8 条上限 / 2000 字截断 / 同 id 覆盖 / take / drain。
 */
import { describe, expect, it } from "vitest";
import { STEER_MAX_PENDING, STEER_TEXT_MAX, SteerBus } from "../../packages/core/src/steerBus.ts";

describe("转向总线", () => {
  it("最多保留 8 条：满员拒绝而不是挤掉旧条目", () => {
    const bus = new SteerBus();
    for (let i = 0; i < STEER_MAX_PENDING; i++) {
      expect(bus.push({ id: `s${i}`, text: `s${i}` })).toBe("ok");
    }
    expect(bus.push({ id: "overflow", text: "overflow" })).toBe("full");
    expect(bus.size()).toBe(8);
    expect(bus.list()[0].id).toBe("s0");
  });

  it("每条截断至 2000 字", () => {
    const bus = new SteerBus();
    bus.push({ id: "long", text: "x".repeat(3000) });
    expect((bus.list()[0]?.text ?? "").length).toBe(STEER_TEXT_MAX);
  });

  it("空文本拒绝入队", () => {
    const bus = new SteerBus();
    expect(bus.push({ id: "empty", text: "   " })).toBe("empty");
    expect(bus.size()).toBe(0);
  });

  it("同 id 覆盖且保留原位置", () => {
    const bus = new SteerBus();
    bus.push({ id: "a", text: "第一版" });
    bus.push({ id: "b", text: "b" });
    expect(bus.push({ id: "a", text: "第二版" })).toBe("ok");
    expect(bus.list().map((item) => item.text)).toEqual(["第二版", "b"]);
  });

  it("take 取出指定条目（不存在返回 undefined）", () => {
    const bus = new SteerBus();
    bus.push({ id: "a", text: "a" });
    bus.push({ id: "b", text: "b" });
    expect(bus.take("a")?.text).toBe("a");
    expect(bus.take("missing")).toBeUndefined();
    expect(bus.list().map((item) => item.id)).toEqual(["b"]);
  });

  it("drain 清空队列且保留条目元信息", () => {
    const bus = new SteerBus();
    bus.push({ id: "a", text: "a", kind: "user" });
    bus.push({ id: "b", text: "b", kind: "subagent", fromName: "子代理" });
    expect(bus.drain().map((item) => item.id)).toEqual(["a", "b"]);
    expect(bus.size()).toBe(0);
    expect(bus.drain()).toEqual([]);
  });
});
