/**
 * T6 测试：packages/core/src/router.ts
 * 覆盖 ModelRouter：pick 过滤 cooldown、priority 降序、markCooldown、fallbackChain 有序
 */
import { describe, expect, it } from "vitest";
import { ModelRouter } from "../../packages/core/src/router.ts";

describe("pick 过滤 cooldown + priority 降序", () => {
  it("冷却中的条目被过滤（cooldownUntilMs > now）", () => {
    const router = new ModelRouter([
      { id: "m1", provider: "p1", priority: 10, roles: ["chat"], cooldownUntilMs: 99999 },
      { id: "m2", provider: "p2", priority: 5, roles: ["chat"], cooldownUntilMs: 0 },
    ]);
    const picked = router.pick("chat", 100);
    expect(picked?.id).toBe("m2");
  });

  it("同角色多模型按 priority 降序选第一个", () => {
    const router = new ModelRouter([
      { id: "low", provider: "p", priority: 1, roles: ["chat"], cooldownUntilMs: 0 },
      { id: "high", provider: "p", priority: 99, roles: ["chat"], cooldownUntilMs: 0 },
    ]);
    expect(router.pick("chat", 0)?.id).toBe("high");
  });

  it("无可用模型返回 null", () => {
    const router = new ModelRouter([]);
    expect(router.pick("chat", 0)).toBeNull();
  });

  it("多角色匹配（some(role)）", () => {
    const router = new ModelRouter([
      { id: "m", provider: "p", priority: 3, roles: ["code", "chat"], cooldownUntilMs: 0 },
    ]);
    expect(router.pick(["chat", "code"], 0)?.id).toBe("m");
  });
});

describe("markCooldown", () => {
  it("标记后 pick 在到期前过滤", () => {
    const router = new ModelRouter([
      { id: "m", provider: "p", priority: 1, roles: ["chat"], cooldownUntilMs: 0 },
    ]);
    router.markCooldown("m", 500, 100);
    expect(router.pick("chat", 200)).toBeNull(); // 100+500=600 > 200，仍冷却
    expect(router.pick("chat", 600)).not.toBeNull(); // 600 >= 600，可用
  });
});

describe("fallbackChain 有序", () => {
  it("返回已过滤冷却、按 priority 降序的数组", () => {
    const router = new ModelRouter([
      { id: "c", provider: "p", priority: 3, roles: ["chat"], cooldownUntilMs: 99999 }, // 冷却，排除
      { id: "a", provider: "p", priority: 10, roles: ["chat"], cooldownUntilMs: 0 },
      { id: "b", provider: "p", priority: 7, roles: ["chat"], cooldownUntilMs: 0 },
    ]);
    const chain = router.fallbackChain("chat", 10);
    expect(chain.map((e) => e.id)).toEqual(["a", "b"]);
  });
});
