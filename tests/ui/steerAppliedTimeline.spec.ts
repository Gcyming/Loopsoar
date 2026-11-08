/**
 * 引导回执折入时间线：applySteerToLatest 单测。
 * 语义对齐 slime：注入成功后引导不新增独立用户气泡，而是折进当轮 assistant 的「引导」卡。
 */
import { describe, expect, it } from "vitest";
import { applySteerToLatest, type ChatMessage } from "../../packages/ui/src/chatStreamState.ts";

function assistant(id: string, timeline: ChatMessage["timeline"] = []): ChatMessage {
  return { id, role: "assistant", text: "", timeline };
}

describe("applySteerToLatest", () => {
  it("折进最后一条 assistant 的 timeline 末尾", () => {
    const messages = [assistant("a1", [{ kind: "body", text: "输出中" }]), { id: "u1", role: "user" as const, text: "问题" }];
    const next = applySteerToLatest(messages, "换个方向");
    expect(next[0].timeline).toEqual([
      { kind: "body", text: "输出中" },
      { kind: "steer", text: "换个方向" },
    ]);
    expect(next[1]).toBe(messages[1]);
  });

  it("多条 assistant 时只改最后一条", () => {
    const messages = [assistant("a1"), assistant("a2")];
    const next = applySteerToLatest(messages, "补充");
    expect(next[0].timeline).toEqual([]);
    expect(next[1].timeline).toEqual([{ kind: "steer", text: "补充" }]);
  });

  it("trim 文本；空文本原样返回同一引用", () => {
    const messages = [assistant("a1")];
    expect(applySteerToLatest(messages, "   ")).toBe(messages);
    expect(applySteerToLatest(messages, " 注意边界 ")[0].timeline).toEqual([{ kind: "steer", text: "注意边界" }]);
  });

  it("没有 assistant 时原样返回（避免把引导塞进用户消息）", () => {
    const messages: ChatMessage[] = [{ id: "u1", role: "user", text: "问题" }];
    expect(applySteerToLatest(messages, "补充")).toBe(messages);
  });

  it("紧邻重复的同一文案不重复插卡（对齐 appendTimelineStep 去重）", () => {
    let messages = [assistant("a1")];
    messages = applySteerToLatest(messages, "继续");
    messages = applySteerToLatest(messages, "继续");
    expect(messages[0].timeline).toEqual([{ kind: "steer", text: "继续" }]);
    messages = applySteerToLatest(messages, "新指令");
    expect(messages[0].timeline).toEqual([
      { kind: "steer", text: "继续" },
      { kind: "steer", text: "新指令" },
    ]);
  });
});
