/**
 * 工具循环核心（§4.1 tool_loop）
 * 框架核心：轮次循环 + 四闸预算检查 + 心跳 + 静默超时 + 转向注入 + 无进度检测 + 中断支持。
 * 权限判定和工具执行交给外部 ToolExecutor（loop 只负责编排）；
 * 使用 BudgetUsage 追踪四维度消耗，使用 EventSink 发送循环事件，
 * 使用 SteerBus 在轮次边界注入转向提示。
 * 为什么：纯编排层让安全控制（预算、超时、进度检测）与具体工具实现解耦，便于独立测试和替换实现。
 */

import { BudgetUsage, budgetReason, clampLimits } from "./budget.js";
import { LoopEvent, EventSink } from "./events.js";
import { LOOP_HEALTH, HEARTBEAT_MS } from "loopsoar-contracts/security-policy";
import { LlmClient, LlmRequest, LlmChunk, type LlmMessage } from "./llm/index.js";
import { SteerBus } from "./steerBus.js";
import type { ToolResult } from "./tools/registry.js";
export type { ToolResult } from "./tools/registry.js";

// 工具调用描述：由 LLM 输出的 tool_call chunk 解析而来。
export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

// 工具执行器接口：外部实现负责权限判定（如 sandbox.checkPermission）和实际工具调用，
// loop 层只调用 invoke，不直接接触 node 内建模块或具体实现。
export interface ToolExecutor {
  invoke(toolCall: ToolCall): Promise<ToolResult>;
}

// 工具循环选项
export interface ToolLoopOpts {
  llm: LlmClient;                                 // LLM 流式客户端
  tools: () => readonly { name: string; description: string; parameters: unknown }[]; // 可用工具清单
  executeTool: ToolExecutor;                        // 工具执行器（依赖注入）
  limits: { maxRounds?: number; maxToolCalls?: number; maxTotalTokens?: number; maxWallClockMs?: number };
  budget: BudgetUsage;                               // 初始预算使用量
  sink: EventSink;                                   // 事件沉降
  heartbeatMs?: number;                              // 心跳间隔（默认用 LOOP_HEALTH.HEARTBEAT_MS）
  steers: SteerBus;                                  // 转向总线
  signal?: AbortSignal;                              // 外部中止信号
  noProgressRounds?: number;                         // 无进度检测阈值（默认 5 轮）
  /** 调用方已组装好的消息（系统提示/记忆/技能/历史）；不传则用默认执行提示。 */
  messages?: LlmMessage[];
  /** 推理等级（透传厂商；不支持则忽略）。 */
  reasoningEffort?: string;
}

// 工具循环产出：包含最终状态、归因文案、累积文本、最终预算使用量。
export interface ToolLoopOutcome {
  status: "done" | "budget" | "aborted" | "silent" | "no-progress" | "error";
  reason: string;
  finalText: string;
  usage: BudgetUsage;
}

/**
 * 运行工具循环。每轮流程：
 * 1. 检查外部中止信号
 * 2. 更新墙钟时间并执行预算四闸检查（命中即收束并附「已收集信息」文案）
 * 3. 在轮次边界注入转向提示（SteerBus.drain）
 * 4. 构造 LLM 请求（包含系统提示、工具清单、转向提示）
 * 5. 流式调用 LLM，处理 text/reasoning/tool_call/usage/done/error
 * 6. 工具调用期间：定时发送心跳事件；若执行超过静默超时则中止并返回 silent
 * 7. 每轮结束检查无进度死循环（连续无实质进度轮数达到阈值即中止）
 */
export async function runToolLoop(opts: ToolLoopOpts): Promise<ToolLoopOutcome> {
  const {
    llm,
    tools,
    executeTool,
    limits,
    budget: initialBudget,
    sink,
    heartbeatMs = HEARTBEAT_MS,
    steers,
    signal,
    noProgressRounds: configuredNoProgressRounds,
  } = opts;

  const clamped = clampLimits(limits);
  const maxRounds = clamped.maxRounds;
  const maxToolCalls = clamped.maxToolCalls;
  const maxTotalTokens = clamped.maxTotalTokens;
  const maxWallClockMs = clamped.maxWallClockMs;

  const usage: BudgetUsage = { ...initialBudget };
  const startTime = Date.now();
  const npr = configuredNoProgressRounds ?? LOOP_HEALTH.noProgressRounds;
  let roundsWithoutProgress = 0;

  let finalText = "";
  let seq = 0;

  const emit = (type: LoopEvent["type"], data: unknown): void => {
    sink({ seq: seq++, type, data, ts: Date.now() });
  };

  // 外部中止信号监听：一旦触发，立即停止当前轮次并返回 aborted。
  const abortController = new AbortController();
  if (signal) {
    const onAbort = (): void => abortController.abort();
    signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    for (let round = 0; round < maxRounds; round++) {
      // 外部中止检查
      if (abortController.signal.aborted) {
        return {
          status: "aborted",
          reason: "外部中止信号触发，工具循环被终止",
          finalText,
          usage,
        };
      }

      // 墙钟时间更新
      usage.wallClockMs = Date.now() - startTime;

      // 四闸检查：每轮开始执行预算检查，命中任一闸即收束并附「已收集信息」文案
      const budgetStop = budgetReason(usage, limits);
      if (budgetStop) {
        return {
          status: "budget",
          reason: budgetStop,
          finalText,
          usage,
        };
      }

      // 轮次计数（每轮递增，第一轮从 1 开始）
      usage.rounds = round + 1;

      // 转向注入（轮次边界）：从 SteerBus 取出所有当前转向，注入到系统提示中
      const steerTexts = steers.drain();
      const steerPrompt = steerTexts.length > 0
        ? `\n[系统转向提示] ${steerTexts.join(" · ")}\n`
        : "";
      if (steerTexts.length > 0) {
        emit("progress", { note: `已注入 ${steerTexts.length} 条转向提示（下一轮生效）` });
      }

      // 无进度检测预热：每轮开始记录当前进度状态（用于后续判断）
      let roundHadTextProgress = false;
      let roundHadToolProgress = false;

      // 构造 LLM 流式请求
      const baseMessages: LlmMessage[] = opts.messages
        ? [...opts.messages]
        : [
            { role: "system", content: "你是 Loopsoar 平台的执行引擎，按诚实协议执行任务，必要时调用工具。" },
            { role: "user", content: "继续执行任务。如有需要调用工具，请直接给出工具调用指令；如已完成，请说明并总结结果。" },
          ];
      const request: LlmRequest = {
        messages: steerPrompt ? [...baseMessages, { role: "user", content: `【转向提示】${steerPrompt}` }] : baseMessages,
        tools: tools(),
        maxTokens: undefined,
        reasoningEffort: opts.reasoningEffort,
        signal: abortController.signal,
      };

      // 流式调用 LLM
      try {
        for await (const chunk of llm.invoke(request)) {
          if (abortController.signal.aborted) {
            return {
              status: "aborted",
              reason: "LLM 调用期间收到外部中止信号",
              finalText,
              usage,
            };
          }

          switch (chunk.kind) {
            case "text": {
              const textContent = chunk.text ?? "";
              emit("chunk", { text: textContent });
              finalText += textContent;
              if (textContent.trim().length > 0) {
                roundHadTextProgress = true;
              }
              break;
            }

            case "reasoning": {
              const reasoningText = chunk.text ?? "";
              emit("reasoning", { text: reasoningText });
              break;
            }

            case "tool_call": {
              const tc = chunk as { kind: "tool_call"; toolCall: { id: string; name: string; args: unknown } };
              const toolCall: ToolCall = {
                id: tc.toolCall.id,
                name: tc.toolCall.name,
                args: tc.toolCall.args,
              };

              // 工具调用执行期间：设置心跳间隔（定时发送 heartbeat 事件）
              const heartbeatInterval = setInterval(() => {
                if (!abortController.signal.aborted) {
                  emit("heartbeat", { silentMs: heartbeatMs });
                }
              }, heartbeatMs);

              // 静默超时：工具执行超过 LOOP_HEALTH.silentTimeoutMs 即中止并返回 silent 状态
              const silentTimeoutMs = LOOP_HEALTH.silentTimeoutMs;
              let toolResult: ToolResult;

              try {
                // 并发执行：工具调用与超时检测竞争
                const timeoutRace = Promise.race([
                  executeTool.invoke(toolCall).catch((err) => ({
                    ok: false,
                    content: "",
                    error: err instanceof Error ? err.message : String(err),
                  } as ToolResult)),
                  new Promise<ToolResult>((_, reject) => {
                    setTimeout(() => {
                      reject(new Error("静默超时：工具执行超过安全静默时间"));
                    }, silentTimeoutMs);
                  }),
                ]);

                toolResult = await timeoutRace;
              } catch (err) {
                // 超时：清理心跳，返回 silent（安全模式触发条件）
                clearInterval(heartbeatInterval);
                emit("heartbeat", { silentMs: silentTimeoutMs });
                return {
                  status: "silent",
                  reason: "安全模式触发条件：工具执行静默超时（超过 LOOP_HEALTH.silentTimeoutMs）",
                  finalText,
                  usage,
                };
              } finally {
                clearInterval(heartbeatInterval);
              }

              // 工具调用完成后发送 tool 事件
              emit("tool", {
                toolName: toolCall.name,
                args: toolCall.args,
                result: toolResult,
              });

              // 更新预算：工具调用计数和 Token 计数
              usage.toolCalls += 1;
              if (chunk.tokens !== undefined) {
                usage.totalTokens += chunk.tokens;
              }

              // 记录工具执行结果到最终文本（便于后续轮次参考）
              const resultLine = `\n[工具 ${toolCall.name}] ${toolResult.ok ? "成功" : "失败"}: ${toolResult.content || toolResult.error || "无内容"}\n`;
              finalText += resultLine;
              if (toolResult.ok && (toolResult.content || resultLine.trim().length > 0)) {
                roundHadToolProgress = true;
              }

              // 工具调用上限检查：每次工具执行后检查是否达到上限
              if (usage.toolCalls >= maxToolCalls) {
                return {
                  status: "budget",
                  reason: `工具调用已达上限 ${maxToolCalls}。已收集信息。`,
                  finalText,
                  usage,
                };
              }
              break;
            }

            case "usage": {
              usage.totalTokens += chunk.tokens ?? 0;
              break;
            }

            case "done": {
              emit("done", { finalText });
              return {
                status: "done",
                reason: "LLM 返回 done，任务完成",
                finalText,
                usage,
              };
            }

            case "error": {
              const msg = chunk.message ?? "LLM 流返回未知错误";
              emit("error", { message: msg, fatal: true });
              return {
                status: "error",
                reason: msg,
                finalText,
                usage,
              };
            }

            default:
              // 未知 chunk 类型：安全忽略（fail-closed：不抛异常而是继续）
              break;
          }
        }
      } catch (llmErr) {
        // LLM 流调用异常：记录为 error 事件并返回 error 状态
        const msg = llmErr instanceof Error ? llmErr.message : String(llmErr);
        emit("error", { message: msg, fatal: true });
        return {
          status: "error",
          reason: `LLM 流调用异常：${msg}`,
          finalText,
          usage,
        };
      }

      // 无进度检测（no-progress 死循环检测）：连续无实质进展的轮次达到阈值则中止
      const hadProgressThisRound = roundHadTextProgress || roundHadToolProgress;
      if (hadProgressThisRound) {
        roundsWithoutProgress = 0;
      } else {
        roundsWithoutProgress += 1;
        if (roundsWithoutProgress >= npr) {
          emit("progress", { message: `连续 ${npr} 轮无实质进度，触发安全停止` });
          return {
            status: "no-progress",
            reason: `连续 ${npr} 轮无实质进度（无文本输出或工具结果变化），触发安全停止。已收集信息。`,
            finalText,
            usage,
          };
        }
      }

      // 墙钟时间上限检查：每轮结束时检查（已在下一轮开始时通过 budgetReason 检查，这里作为双重保险）
      usage.wallClockMs = Date.now() - startTime;
      if (usage.wallClockMs >= maxWallClockMs) {
        return {
          status: "budget",
          reason: `墙钟时间已达上限 ${maxWallClockMs} ms。已收集信息。`,
          finalText,
          usage,
        };
      }
    }

    // 轮次用尽：所有轮次用完但未触发任何收束条件，按 budget 状态返回
    return {
      status: "budget",
      reason: `轮次已达上限 ${maxRounds}。已收集信息。`,
      finalText,
      usage,
    };
  } catch (err) {
    // 最外层异常捕获：任何未被内部捕获的异常都转为 error 状态，保证不崩溃（fail-closed）
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: "error",
      reason: `工具循环运行异常：${msg}`,
      finalText,
      usage,
    };
  }
}
