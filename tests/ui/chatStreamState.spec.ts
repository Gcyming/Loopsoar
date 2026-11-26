/**
 * 会话流事件 → 消息状态：纯函数单测（不挂 React）。
 * 这是"事件→时间线"的唯一转换层，覆盖创建/累加/工具落定/规划折叠/收尾/恢复。
 */
import { describe, expect, it } from "vitest";
import {
  applyChunk,
  applyDone,
  applyReasoning,
  applySteer,
  applyToolResult,
  applyToolStart,
  createSessionStreamMeta,
  parseDone,
  restoreMessages,
  type ChatMessage,
} from "../../packages/ui/src/chatStreamState.ts";

describe("会话流状态转换", () => {
  it("正文增量创建助手消息并累积 body 节点", () => {
    let messages: ChatMessage[] = [];
    messages = applyChunk(messages, "a1", "你", { tailSeq: 1, now: 1 });
    messages = applyChunk(messages, "a1", "好", { tailSeq: 2, now: 2 });
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe("你好");
    expect(messages[0].status).toBe("streaming");
    expect(messages[0].timeline).toEqual([{ kind: "body", text: "你好" }]);
  });

  it("思考增量合并 think 节点；steer 独立成节点", () => {
    let messages = applyReasoning([{ id: "a1", role: "assistant", text: "" }], "a1", "思考");
    messages = applyReasoning(messages, "a1", "继续");
    expect(messages[0].timeline).toEqual([{ kind: "think", text: "思考继续" }]);
    messages = applySteer(messages, "a1", "换个方向");
    expect(messages[0].timeline?.at(-1)).toEqual({ kind: "steer", text: "换个方向" });
  });

  it("tool_start 运行中 → tool 结果落定（不重复建节点）", () => {
    let messages: ChatMessage[] = [{ id: "a1", role: "assistant", text: "" }];
    messages = applyToolStart(messages, "a1", JSON.stringify({ toolCallId: "c1", toolName: "browser_snapshot", args: { url: "https://x" } }));
    expect(messages[0].timeline?.[0]).toMatchObject({ kind: "tool", id: "c1", state: "running" });
    messages = applyToolResult(
      messages,
      "a1",
      JSON.stringify({ toolCallId: "c1", toolName: "browser_snapshot", args: { url: "https://x" }, result: { ok: true, content: "页面内容" } }),
      "new-id",
    );
    const tools = (messages[0].timeline ?? []).filter((step) => step.kind === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ state: "done", ok: true, result: "页面内容" });
  });

  it("没有 tool_start 时直接追加完成节点；规划参数折叠成规划卡 + 播报", () => {
    const first = applyToolResult(
      [{ id: "a1", role: "assistant", text: "" }],
      "a1",
      JSON.stringify({ toolCallId: "c2", toolName: "todo_write", args: { items: [{ content: "第一项", status: "in_progress" }] }, result: { ok: true, content: "- [ ] 第一项 ← 进行中" } }),
      "x",
    );
    const plan = first[0].timeline?.find((step) => step.kind === "plan");
    expect(plan).toBeTruthy();
    const external = applyToolResult(
      [{ id: "a1", role: "assistant", text: "" }],
      "a1",
      JSON.stringify({ toolName: "web_fetch", args: { url: "https://example.com" }, result: { ok: false, content: "[错误] 401" } }),
      "t2",
    );
    expect(external[0].timeline?.[0]).toMatchObject({ kind: "tool", id: "t2", state: "done", ok: false });
  });

  it("done 解析中断原因并统一落定", () => {
    const info = parseDone(JSON.stringify({ status: "budget", reason: "轮次已达上限", usage: { rounds: 3 } }));
    expect(info.interrupted?.status).toBe("budget");
    expect(info.statusText).toContain("已中断");
    const messages = applyDone(
      [{ id: "a1", role: "assistant", text: "部分", status: "streaming", createdAt: 1 }],
      info,
      { startedAt: 100, firstTokenAt: 300, now: 900 },
    );
    expect(messages[0].status).toBe("done");
    expect(messages[0].timing).toMatchObject({ firstTokenMs: 200, totalMs: 800, rounds: 3 });
    expect(messages[0].interrupted?.reason).toContain("轮次");
  });

  it("从历史恢复消息并带回时间线", () => {
    const messages = restoreMessages(
      [
        { role: "user", text: "你好" },
        { role: "assistant", text: "回复", timeline: [{ kind: "think", text: "想想" }], provider: "opencode-go", model: "glm-5.3" },
      ],
      (role) => `id-${role}`,
    );
    expect(messages).toHaveLength(2);
    expect(messages[1].timeline).toEqual([{ kind: "think", text: "想想" }]);
    expect(messages[1]).toMatchObject({ provider: "opencode-go", model: "glm-5.3" });
    expect(messages[1].status).toBe("done");
  });
});


describe("会话流元信息", () => {
  it("默认空闲，且不同会话互不影响", () => {
    const a = createSessionStreamMeta();
    const b = createSessionStreamMeta();
    expect(a).toMatchObject({ activeId: null, busy: false, stopping: false, startedAt: 0 });
    a.busy = true;
    a.activeId = "assistant-1";
    expect(b.busy).toBe(false);
    expect(b.activeId).toBeNull();
  });
});

describe("损坏/异常事件防护", () => {
  it("非字符串增量不抛错、不改变消息", () => {
    expect(applyChunk([], "a", undefined as unknown as string)).toEqual([]);
    expect(applyReasoning([], "a", 123 as unknown as string)).toEqual([]);
    expect(applySteer([], "a", null as unknown as string)).toEqual([]);
  });

  it("恢复历史时丢弃损坏的 timeline 与非字符串 text", () => {
    const [message] = restoreMessages(
      [
        {
          role: "assistant",
          text: 42 as unknown as string,
          timeline: [{ kind: "think" }, { kind: "tool", id: 1, name: null }, { kind: "bogus" }],
        },
      ],
      () => "m1",
    );
    expect(message.text).toBe("");
    expect(message.timeline).toBeUndefined();
  });

  it("工具结果是结构化对象时不抛错，并转成文本", () => {
    const next = applyToolResult(
      [{ id: "a", role: "assistant", text: "", status: "streaming", timeline: [] }] as ChatMessage[],
      "a",
      JSON.stringify({ toolCallId: "t1", toolName: "todo_write", result: { content: { steps: ["a"] } } }),
      "t2",
    );
    const step = next[0].timeline?.find((item) => item.kind === "tool");
    expect(step).toBeTruthy();
    expect(typeof (step as { result?: unknown }).result).toBe("string");
  });
});
