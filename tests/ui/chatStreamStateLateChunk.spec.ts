/**
 * 迟到增量回归（正文被劈成两条气泡的根因防线）：
 * done 之后才到达的尾部 chunk 必须并回最后一条助手消息，**绝不新建**助手气泡。
 */
import { describe, expect, it } from "vitest";
import {
  applyChunk,
  applyDone,
  applyLateChunk,
  type ChatMessage,
} from "../../packages/ui/src/chatStreamState.ts";

function streaming(id = "a1"): ChatMessage[] {
  return applyChunk([], id, "前半段正文", { tailSeq: 1, now: 1 });
}

describe("applyLateChunk · 迟到增量", () => {
  it("done 之后到达的尾部 chunk 并回最后一条助手消息，不新建气泡", () => {
    const finished = applyDone(streaming(), { usage: {}, statusText: "" }, { startedAt: 1, firstTokenAt: 2, now: 3 });
    const next = applyLateChunk(finished, "尾部几个字", { tailSeq: 2, fallbackId: "a-new" });

    expect(next).toHaveLength(1);
    expect(next[0].id).toBe("a1");
    expect(next[0].text).toBe("前半段正文尾部几个字");
    // 状态保持 done：不能因为迟到增量又变回流式中
    expect(next[0].status).toBe("done");
    // 时间线补上 body 节点（思考历程里也不丢）
    const bodies = (next[0].timeline ?? []).filter((step) => step.kind === "body");
    expect(bodies.length).toBe(1);
    expect((bodies[0] as { text: string }).text).toContain("尾部几个字");
  });

  it("仍处于 streaming 的助手消息：按原 id 正常追加（不重复建消息）", () => {
    const next = applyLateChunk(streaming("a2"), "继续", { tailSeq: 3 });
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe("a2");
    expect(next[0].text).toBe("前半段正文继续");
    expect(next[0].status).toBe("streaming");
  });

  it("最后一条是 system/transient 时，仍并回前面的助手消息", () => {
    const base: ChatMessage[] = [...streaming("a3"), { id: "sys1", role: "system", text: "提示", status: "done" }];
    const done = applyDone(base, { usage: {}, statusText: "" }, { startedAt: 1, firstTokenAt: 2, now: 3 });
    const next = applyLateChunk(done, "尾巴", { tailSeq: 4 });
    expect(next).toHaveLength(2);
    expect(next[0].text).toBe("前半段正文尾巴");
    expect(next[1].role).toBe("system");
  });

  it("一条助手消息都没有时才新建（用 fallbackId），并保持流式状态可继续追加", () => {
    const next = applyLateChunk([], "第一段", { tailSeq: 5, fallbackId: "a-fallback" });
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe("a-fallback");
    expect(next[0].role).toBe("assistant");
    expect(next[0].status).toBe("streaming");
    const more = applyLateChunk(next, "第二段", { tailSeq: 6 });
    expect(more).toHaveLength(1);
    expect(more[0].text).toBe("第一段第二段");
  });

  it("空增量不改变状态（幂等）", () => {
    const done = applyDone(streaming("a4"), { usage: {}, statusText: "" }, { startedAt: 1, firstTokenAt: 2, now: 3 });
    expect(applyLateChunk(done, "", { tailSeq: 7 })).toEqual(done);
  });
});
