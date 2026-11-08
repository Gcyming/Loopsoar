/**
 * 中断链路回归（task-3）：done(aborted) 到达时，UI 状态必须收敛。
 *
 * 用户反馈「中断后 Agent 会话仍在显示思考中」：streaming 消息不落定、时间线里运行中的工具卡
 * 永远显示「执行中」。这里验证纯函数层的行为（组件只在之上渲染）：
 *   · streaming → done + interrupted（LiveStatus / 生成中占位随之消失）；
 *   · 仍为 running 的工具节点落定为「已停止」（否则历史里一直显示执行中）。
 */
import { describe, expect, it } from "vitest";
import {
  applyDone,
  parseDone,
  settleAbortedTools,
  type ChatMessage,
} from "../../packages/ui/src/chatStreamState.ts";
import type { TimelineStep } from "../../packages/ui/src/timeline.ts";

const streamingMessage: ChatMessage = {
  id: "a1",
  role: "assistant",
  text: "部分输出",
  status: "streaming",
  createdAt: 1,
  timeline: [
    { kind: "think", text: "先看看" },
    { kind: "tool", id: "t1", name: "terminal_run", label: "terminal_run", state: "running" },
  ],
};

describe("中断后的 UI 收敛", () => {
  it("done(aborted)：streaming 落定 + 写入中断原因 + running 工具卡落定", () => {
    const info = parseDone(JSON.stringify({ status: "aborted", reason: "用户已停止本轮生成" }));
    expect(info.interrupted).toEqual({ status: "aborted", reason: "用户已停止本轮生成" });

    const next = applyDone([streamingMessage], info, { startedAt: 100, firstTokenAt: 300, now: 700 });
    const message = next[0];

    // LiveStatus / 生成中占位由 status==="streaming" 驱动：必须落定
    expect(message.status).toBe("done");
    expect(message.interrupted).toEqual({ status: "aborted", reason: "用户已停止本轮生成" });
    expect(message.timing).toMatchObject({ firstTokenMs: 200, totalMs: 600 });

    // 工具卡不能永远停在「执行中」
    const tool = (message.timeline ?? []).find((step): step is Extract<TimelineStep, { kind: "tool" }> => step.kind === "tool");
    expect(tool).toMatchObject({ state: "done", ok: false, result: "已停止" });
  });

  it("done(done)：正常收尾不写中断原因，也不篡改工具节点", () => {
    const info = parseDone(JSON.stringify({ status: "done", usage: { rounds: 1 } }));
    const next = applyDone([streamingMessage], info, { startedAt: 100, firstTokenAt: 200, now: 300 });
    expect(next[0].status).toBe("done");
    expect(next[0].interrupted).toBeUndefined();
    const tool = (next[0].timeline ?? []).find((step) => step.kind === "tool");
    expect(tool && tool.kind === "tool" ? tool.state : undefined).toBe("running");
  });

  it("settleAbortedTools：无运行中节点时返回原引用（不做无意义重建）", () => {
    const steps: TimelineStep[] = [
      { kind: "think", text: "想了想" },
      { kind: "tool", id: "t1", name: "x", label: "x", state: "done", ok: true },
    ];
    expect(settleAbortedTools(steps)).toBe(steps);
    expect(settleAbortedTools(undefined)).toBeUndefined();
  });
});
