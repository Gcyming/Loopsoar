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
        { role: "assistant", text: "回复", timeline: [{ kind: "think", text: "想想" }] },
      ],
      (role) => `id-${role}`,
    );
    expect(messages).toHaveLength(2);
    expect(messages[1].timeline).toEqual([{ kind: "think", text: "想想" }]);
    expect(messages[1].status).toBe("done");
  });
});
