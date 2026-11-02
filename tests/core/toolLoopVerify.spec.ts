/**
 * 工具循环增强：每轮声称核验 + 强制工具轮 + 长等待工具静默超时豁免。
 *
 * 为什么这些断言：
 *   · 「已验证再收束」是诚实协议的关键：模型声称已保存但没调工具时必须被拦回一轮；
 *   · 强制轮必须封顶（默认 2），否则核验器异常/模型顽固会变成无限循环烧额度；
 *   · ask_user 等真人回答工具不能按 90s 普通静默超时误杀，否则用户还在思考就被判 silent。
 */
import { describe, expect, it } from "vitest";
import { runToolLoop, type ToolExecutor } from "../../packages/core/src/tool_loop.ts";
import { SteerBus } from "../../packages/core/src/steerBus.ts";
import type { LoopEvent } from "../../packages/core/src/events.ts";

type Script = { kind: string; text?: string; toolCall?: { id: string; name: string; args: unknown } }[];

function baseOpts() {
  return {
    tools: () => [] as { name: string; description: string; parameters: unknown }[],
    limits: { maxRounds: 10, maxToolCalls: 10, maxTotalTokens: 1_000_000, maxWallClockMs: 60_000 },
    budget: { rounds: 0, toolCalls: 0, totalTokens: 0, wallClockMs: 0 },
    steers: new SteerBus(),
    heartbeatMs: 10_000,
    executeTool: { invoke: async () => ({ ok: true, content: "" }) } as ToolExecutor,
    sink: () => {},
  };
}

/** 可捕获每次 LLM 请求的脚本客户端：按顺序消费一轮 chunk 列表。 */
function scriptedLlm(scripts: Script[], requests?: { messages: { role: string; content: string }[] }[]) {
  return {
    async *invoke(req: { messages: { role: string; content: string }[] }) {
      requests?.push({ messages: req.messages.map((m) => ({ ...m })) });
      const chunks = scripts.shift() ?? [{ kind: "done" }];
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  } as never;
}

describe("每轮声称核验（verifyRound）与强制工具轮", () => {
  it("核验未通过 → 注入强制工具轮并继续，下一轮通过后 done", async () => {
    const requests: { messages: { role: string; content: string }[] }[] = [];
    const llm = scriptedLlm(
      [
        [{ kind: "text", text: "已保存到 report.txt" }, { kind: "done" }],
        [{ kind: "text", text: "核实后：report.txt 不存在，已改为输出说明" }, { kind: "done" }],
      ],
      requests,
    );
    const verifyCalls: { round: number; usedAnyTool: boolean }[] = [];
    const events: LoopEvent[] = [];
    const outcome = await runToolLoop({
      ...baseOpts(),
      llm,
      sink: (e) => events.push(e),
      verifyRound: async (info) => {
        verifyCalls.push({ round: info.round, usedAnyTool: info.usedAnyTool });
        // 第一次声称 report.txt 已完成 → 文件不存在；第二次放行
        return verifyCalls.length === 1
          ? { ok: false, note: "report.txt 不存在" }
          : { ok: true };
      },
    });

    expect(outcome.status).toBe("done");
    expect(outcome.reason).toContain("任务完成");
    expect(verifyCalls).toHaveLength(2);
    expect(verifyCalls[0]!.usedAnyTool).toBe(false);
    // 强制工具轮：必须发 progress（不得直接 done）
    const progressNotes = events
      .filter((e) => e.type === "progress")
      .map((e) => (e.data as { note?: string }).note ?? "");
    expect(progressNotes.some((note) => note.includes("强制工具轮"))).toBe(true);
    // 第二轮请求上下文里必须出现注入的核验提示（模型才知道要补工具核实）
    expect(requests).toHaveLength(2);
    const injected = requests[1]!.messages.map((m) => m.content).join("\n");
    expect(injected).toContain("声称核验未通过");
    expect(injected).toContain("report.txt");
    // done 事件只发一次（强制轮期间不得提前收束）
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
  });

  it("核验持续失败 → 超过强制轮上限（默认 2）后按现有结果收束，不死循环", async () => {
    const scripts: Script[] = [
      [{ kind: "text", text: "已生成 out.html" }, { kind: "done" }],
      [{ kind: "text", text: "已生成 out.html" }, { kind: "done" }],
      [{ kind: "text", text: "已生成 out.html" }, { kind: "done" }],
    ];
    let verifyCalls = 0;
    const events: LoopEvent[] = [];
    const outcome = await runToolLoop({
      ...baseOpts(),
      llm: scriptedLlm(scripts),
      sink: (e) => events.push(e),
      verifyRound: async () => {
        verifyCalls += 1;
        return { ok: false, note: "out.html 不存在" };
      },
    });

    expect(outcome.status).toBe("done");
    expect(outcome.reason).toContain("强制工具轮已达上限");
    // 首轮核验 + 2 次强制轮核验 = 3 次；LLM 被请求 3 轮
    expect(verifyCalls).toBe(3);
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("maxVerifyForcedRounds=0 → 只记录 progress、不注入强制轮（可配置关闭）", async () => {
    const requests: { messages: { role: string; content: string }[] }[] = [];
    const outcome = await runToolLoop({
      ...baseOpts(),
      llm: scriptedLlm([[{ kind: "text", text: "已完成" }, { kind: "done" }]], requests),
      maxVerifyForcedRounds: 0,
      verifyRound: async () => ({ ok: false, note: "未通过" }),
    });
    expect(outcome.status).toBe("done");
    expect(requests).toHaveLength(1);
  });

  it("默认无 verifyRound → 行为不变（直接 done，不注入任何强制轮）", async () => {
    const requests: { messages: { role: string; content: string }[] }[] = [];
    const events: LoopEvent[] = [];
    const outcome = await runToolLoop({
      ...baseOpts(),
      llm: scriptedLlm([[{ kind: "text", text: "完成" }, { kind: "done" }]], requests),
      sink: (e) => events.push(e),
    });
    expect(outcome.status).toBe("done");
    expect(outcome.reason).toBe("LLM 返回 done，任务完成");
    expect(requests).toHaveLength(1);
    expect(events.filter((e) => e.type === "progress")).toHaveLength(0);
  });

  it("verifyRound 自身抛错 → 跳过本轮核验并可见记录，不阻断收束（失败可见、不误伤）", async () => {
    const events: LoopEvent[] = [];
    const outcome = await runToolLoop({
      ...baseOpts(),
      llm: scriptedLlm([[{ kind: "text", text: "完成" }, { kind: "done" }]]),
      sink: (e) => events.push(e),
      verifyRound: async () => {
        throw new Error("核验器故障");
      },
    });
    expect(outcome.status).toBe("done");
    const notes = events.filter((e) => e.type === "progress").map((e) => (e.data as { note?: string }).note ?? "");
    expect(notes.some((note) => note.includes("声称核验异常"))).toBe(true);
  });

  it("已用过工具时 verifyRound 收到 usedAnyTool=true（供调用方区分纯口嗨）", async () => {
    const seen: boolean[] = [];
    const scripts: Script[] = [
      [{ kind: "tool_call", toolCall: { id: "t1", name: "file_read", args: { path: "a.txt" } } }, { kind: "done" }],
      [{ kind: "text", text: "已读取并总结" }, { kind: "done" }],
    ];
    const outcome = await runToolLoop({
      ...baseOpts(),
      llm: scriptedLlm(scripts),
      executeTool: { invoke: async () => ({ ok: true, content: "内容" }) },
      verifyRound: async (info) => {
        seen.push(info.usedAnyTool);
        return { ok: true };
      },
    });
    expect(outcome.status).toBe("done");
    expect(seen).toEqual([true]);
  });
});

describe("长等待工具静默超时豁免（ask_user）", () => {
  it("ask_user 执行 200ms > 普通静默超时 30ms：不被静默杀死，且等待期间心跳保持", async () => {
    const scripts: Script[] = [
      [{ kind: "tool_call", toolCall: { id: "ask-1", name: "ask_user", args: { question: "选哪个？" } } }, { kind: "done" }],
      [{ kind: "text", text: "用户已回答，继续执行" }, { kind: "done" }],
    ];
    const events: LoopEvent[] = [];
    const outcome = await runToolLoop({
      ...baseOpts(),
      heartbeatMs: 10,
      // 普通工具静默超时收紧到 30ms：能证明 ask_user 走的是长等待超时而非普通超时
      silentTimeoutMs: 30,
      llm: scriptedLlm(scripts),
      executeTool: {
        invoke: async () => {
          await new Promise((r) => setTimeout(r, 200));
          return { ok: true, content: "A" };
        },
      },
      sink: (e) => events.push(e),
    });

    expect(outcome.status).toBe("done");
    expect(events.some((e) => e.type === "tool")).toBe(true);
    // 长等待期间心跳仍然发送（UI 可显示「仍在等待」）
    expect(events.some((e) => e.type === "heartbeat")).toBe(true);
    expect(events.some((e) => e.type === "progress" && (e.data as { note?: string }).note?.includes("静默"))).toBe(false);
  });

  it("普通工具仍按原静默超时收束（silent），不会被豁免逻辑放过", async () => {
    const scripts: Script[] = [
      [{ kind: "tool_call", toolCall: { id: "t1", name: "file_read", args: {} } }, { kind: "done" }],
    ];
    const outcome = await runToolLoop({
      ...baseOpts(),
      silentTimeoutMs: 30,
      llm: scriptedLlm(scripts),
      executeTool: {
        invoke: async () => {
          await new Promise((r) => setTimeout(r, 150));
          return { ok: true, content: "迟到的结果" };
        },
      },
    });
    expect(outcome.status).toBe("silent");
    expect(outcome.reason).toContain("静默超时");
    expect(outcome.reason).toContain("30ms");
  });

  it("longRunningTimeoutMs 可收紧：超过配置的长等待超时仍会 silent", async () => {
    const scripts: Script[] = [
      [{ kind: "tool_call", toolCall: { id: "ask-2", name: "ask_user", args: {} } }, { kind: "done" }],
    ];
    const outcome = await runToolLoop({
      ...baseOpts(),
      silentTimeoutMs: 1_000,
      longRunningTimeoutMs: 30,
      llm: scriptedLlm(scripts),
      executeTool: {
        invoke: async () => {
          await new Promise((r) => setTimeout(r, 150));
          return { ok: true, content: "迟到的回答" };
        },
      },
    });
    expect(outcome.status).toBe("silent");
    expect(outcome.reason).toContain("30ms");
  });
});
