/**
 * 待发指令队列纯函数单测（slime instructionQueue 的 Loopsoar 精简移植）。
 * 覆盖：入队上限/空文本、状态流转、撤销移除、自动续发优先级、回执折入。
 */
import { describe, expect, it } from "vitest";
import {
  PENDING_STEER_MAX,
  enqueuePending,
  mergeDelivered,
  nextResendable,
  removePending,
  requeueUndelivered,
  setPendingStatus,
  type PendingSteer,
} from "../../packages/ui/src/steerQueue.ts";

function make(id: string, text = `指令 ${id}`, status: PendingSteer["status"] = "queued"): PendingSteer {
  return { id, text, createdAt: Number(id.replace(/\D/g, "")) || 0, status };
}

describe("待发指令队列", () => {
  it("入队追加到尾部；空文本/满员时原样返回", () => {
    const base: PendingSteer[] = [];
    expect(enqueuePending(base, make("1"))).toHaveLength(1);
    expect(enqueuePending(base, make("2", "   "))).toBe(base);

    const full = Array.from({ length: PENDING_STEER_MAX }, (_, i) => make(String(i + 1)));
    expect(full).toHaveLength(8);
    expect(enqueuePending(full, make("9"))).toBe(full);
    expect(enqueuePending(full.slice(0, PENDING_STEER_MAX - 1), make("9"))).toHaveLength(PENDING_STEER_MAX);
  });

  it("更新单条状态：命中改状态并携带原因，后续可清除原因", () => {
    const list = setPendingStatus([make("1"), make("2")], "1", "failed", "网络错误");
    expect(list[0]).toMatchObject({ status: "failed", error: "网络错误" });
    expect(list[1].status).toBe("queued");
    const cleared = setPendingStatus(list, "1", "queued");
    expect(cleared[0].status).toBe("queued");
    expect(cleared[0].error).toBeUndefined();
  });

  it("更新不存在的 id 原样返回内容", () => {
    const list = [make("1")];
    expect(setPendingStatus(list, "nope", "delivered")).toEqual(list);
  });

  it("按 id 撤销删除", () => {
    const list = [make("1"), make("2")];
    expect(removePending(list, "1").map((item) => item.id)).toEqual(["2"]);
    expect(removePending(list, "nope")).toHaveLength(2);
  });

  it("自动续发优先 failed，其次 queued；delivered 不参与", () => {
    expect(nextResendable([make("1", "a", "delivered")])).toBeUndefined();
    expect(nextResendable([make("1", "a", "queued"), make("2", "b", "delivered")])?.id).toBe("1");
    expect(nextResendable([make("1", "a", "queued"), make("2", "b", "failed")])?.id).toBe("2");
  });

  it("本轮收尾：未收到回执的 delivered 改回 queued，避免静默丢失", () => {
    const list = requeueUndelivered([make("1", "a", "delivered"), make("2", "b", "queued"), make("3", "c", "failed")]);
    expect(list.map((item) => item.status)).toEqual(["queued", "queued", "failed"]);
  });

  it("注入回执：移除对应条目并按队列顺序返回文案", () => {
    const list = [make("1", "第一条"), make("2", "第二条"), make("3", "第三条")];
    const { next, deliveredTexts } = mergeDelivered(list, [
      { id: "3", text: "第三条" },
      { id: "1", text: "第一条" },
    ]);
    expect(next.map((item) => item.id)).toEqual(["2"]);
    expect(deliveredTexts).toEqual(["第一条", "第三条"]);
  });

  it("空回执原样返回（保留队列引用，便于 React 短路）", () => {
    const list = [make("1")];
    const result = mergeDelivered(list, []);
    expect(result.next).toBe(list);
    expect(result.deliveredTexts).toEqual([]);
  });
});
