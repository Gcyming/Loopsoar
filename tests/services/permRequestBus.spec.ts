import { describe, expect, it } from "vitest";
import { PermRequestBus } from "../../packages/services/src/chat.ts";

/**
 * 结算回调是 UI 出队的唯一可靠路径：回答可能来自界面点击，也可能来自自动化/另一个窗口
 * （E2E 直接调 perm:respond）。没有回调时，渲染层弹窗会永久停留，baseOverlay 让原生网页
 * 视图一直隐藏，下一条点击/选择就会落在不可见页面上。
 */
describe("PermRequestBus 结算通知", () => {
  it("resolve 时通知 requestId，且只通知一次", async () => {
    const settled: string[] = [];
    const bus = new PermRequestBus(1_000, (id) => settled.push(id));
    const pending = bus.request({ requestId: "perm-1", toolName: "browser_click" });
    expect(bus.resolve("perm-1", "allow-once")).toBe(true);
    await expect(pending).resolves.toMatchObject({ choice: "allow-once" });
    expect(settled).toEqual(["perm-1"]);
    expect(bus.resolve("perm-1", "deny")).toBe(false);
    expect(settled).toEqual(["perm-1"]);
  });

  it("超时按拒绝结算并通知", async () => {
    const settled: string[] = [];
    const bus = new PermRequestBus(30, (id) => settled.push(id));
    const answer = await bus.request({ requestId: "perm-timeout", toolName: "browser_click" });
    expect(answer.choice).toBe("deny");
    expect(settled).toEqual(["perm-timeout"]);
  });

  it("clearAll 逐个通知，避免会话结束时残留遮罩", async () => {
    const settled: string[] = [];
    const bus = new PermRequestBus(1_000, (id) => settled.push(id));
    const first = bus.request({ requestId: "a", toolName: "t" });
    const second = bus.request({ requestId: "b", toolName: "t" });
    bus.clearAll();
    await expect(first).resolves.toMatchObject({ choice: "deny" });
    await expect(second).resolves.toMatchObject({ choice: "deny" });
    expect(settled.sort()).toEqual(["a", "b"]);
  });
});
