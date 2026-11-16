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
import { LlmClient, LlmRequest, type LlmMessage } from "./llm/index.js";
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
  /** 相同工具+参数的提醒阈值（默认 5；达到后向模型回灌防循环提示）。 */
  repeatToolWarnAt?: number;
  /** 相同工具+参数的停止阈值（默认 30；太大会浪费额度，太小会打断正常重试）。 */
  repeatToolStopAt?: number;
  steers: SteerBus;                                  // 转向总线
  signal?: AbortSignal;                              // 外部中止信号
  noProgressRounds?: number;                         // 无进度检测阈值（默认 5 轮）
  /** 调用方已组装好的消息（系统提示/记忆/技能/历史）；不传则用默认执行提示。 */
  messages?: LlmMessage[];
  /** 推理等级（透传厂商；不支持则忽略）。 */
  reasoningEffort?: string;
  /**
   * 每轮声称核验（可选）：某轮无工具调用且模型准备收束（sawDone）时调用。
   * 为什么：只在最终收束时核验，「已保存」的假完成已经先呈现给用户了；每轮核验能在收束前
   * 逼模型用工具实际核实（ok=false 注入强制工具轮）。
   */
  verifyRound?: (info: {
    /** 本轮序号（从 1 开始）。 */
    round: number;
    /** 截至本轮累计的模型正文（核验窗口）。 */
    finalText: string;
    /** 整段运行至此是否调用过工具（用于区分「纯口嗨」与「已做过操作」）。 */
    usedAnyTool: boolean;
  }) => Promise<{ ok: boolean; note?: string }>;
  /** 声称核验失败后最多注入几次强制工具轮（默认 2；0=不强制，只记录 progress）。 */
  maxVerifyForcedRounds?: number;
  /**
   * 上游因输出长度上限截断（finishReason="length"）时最多自动续写几次（默认 8；0=不续写）。
   * 为什么需要：很多 OpenAI 兼容上游默认 max_tokens 很小，长回复会被截断在半句；
   * 自动续写把同一助手消息续完整，用户不必手动「继续」。
   */
  maxLengthContinuations?: number;
  /**
   * 长等待工具名单（默认 ["ask_user"]）。
   * 为什么单独豁免：ask_user 等真人回答可能几分钟，按普通工具静默超时（90s）会被误杀。
   */
  longRunningTools?: readonly string[];
  /** 长等待工具的超时（默认 600000 = 10 分钟，与 ask_user 默认等待时长一致）。 */
  longRunningTimeoutMs?: number;
  /** 普通工具静默超时覆盖（默认 LOOP_HEALTH.silentTimeoutMs；自定义 loop 可收紧，测试可缩短）。 */
  silentTimeoutMs?: number;
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
  const repeatWarnAt = Math.max(2, Math.floor(opts.repeatToolWarnAt ?? 5));
  const repeatStopAt = Math.max(repeatWarnAt + 1, Math.floor(opts.repeatToolStopAt ?? 30));
  const maxRounds = clamped.maxRounds;
  const maxToolCalls = clamped.maxToolCalls;
  const maxWallClockMs = clamped.maxWallClockMs;

  const usage: BudgetUsage = { ...initialBudget };
  const startTime = Date.now();
  const npr = configuredNoProgressRounds ?? LOOP_HEALTH.noProgressRounds;
  let roundsWithoutProgress = 0;
  /** 已注入的强制工具轮次数（verifyRound 未通过时累计，受 maxVerifyForcedRounds 封顶）。 */
  let forcedVerifyRounds = 0;
  const maxVerifyForcedRounds = Math.max(0, Math.floor(opts.maxVerifyForcedRounds ?? 2));
  /** 已自动续写次数（上游 finish_reason=length 截断时累计，受 maxLengthContinuations 封顶）。 */
  let lengthContinuations = 0;
  const maxLengthContinuations = Math.max(0, Math.floor(opts.maxLengthContinuations ?? 8));
  /** 长等待工具集合：默认 ask_user（真人回答耗时不可控）。 */
  const longRunningTools = new Set(opts.longRunningTools ?? ["ask_user"]);
  const longRunningTimeoutMs = opts.longRunningTimeoutMs ?? 600_000;
  // 普通工具的「静默超时」默认不再硬杀：大型任务里工具可能长时间无输出（页面/脚本/网络等待），
  // 用户要求交给 Agent/工具自身决定。显式传 silentTimeoutMs 的调用方（测试/自定义 loop）仍生效。
  // 90s 只作为慢工具提示（心跳带 slow 标记），不中止本轮。
  const normalSilentTimeoutMs = opts.silentTimeoutMs ?? 0;
  const silentWarnMs = LOOP_HEALTH.silentWarnMs;

  let finalText = "";
  let seq = 0;
  /** 多轮工具对话上下文（首轮由 opts.messages 初始化，之后累积 assistant/tool 消息） */
  let conversation: LlmMessage[] | null = null;
  /** 防循环：相同工具+参数的调用次数统计 */
  const repeatCalls = new Map<string, number>();
  /** 回灌给模型的单条工具结果上限（完整内容仍在 UI 工具卡/本地记录中） */
  const MAX_TOOL_RESULT_IN_CONTEXT = 20_000;

  const emit = (type: LoopEvent["type"], data: unknown): void => {
    sink({ seq: seq++, type, data, ts: Date.now() });
  };

  // 外部中止信号监听：一旦触发，立即停止当前轮次并返回 aborted。
  const abortController = new AbortController();
  /**
   * 可等待的中止信号：LLM 读取（上游迟迟没有 chunk 时）与工具执行（工具还在跑时）都与它竞速。
   * 为什么需要：只轮询 `abortController.signal.aborted` 的话，检查点只有「下一个 chunk 到达」和
   * 「下一轮开始 / 工具返回」，上游卡住或长任务工具在跑时点「停止」根本不生效 ——
   * 用户看到的是「点了没反应 + 界面一直显示思考中」。
   */
  let abortWaiter: { reject: (reason: unknown) => void } | null = null;
  const abortPromise = new Promise<never>((_, reject) => {
    abortWaiter = { reject };
  });
  // 没参与竞速时它也会在停止时 reject：挂一个空 catch，避免 unhandled rejection
  void abortPromise.catch(() => {});
  const waitAbort = (): Promise<never> => abortPromise;
  const onExternalAbort = (): void => {
    abortController.abort();
    abortWaiter?.reject(new Error("loop-aborted"));
  };
  if (signal) {
    // 已经中止（stop 早于循环启动的竞态）：直接生效，不能指望后续 abort 事件
    if (signal.aborted) onExternalAbort();
    else signal.addEventListener("abort", onExternalAbort, { once: true });
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

      // 引导注入（轮次边界）：取走运行中插入的引导 → 先发 steer 事件（UI 据此把待发卡折进思考历程），
      // 再把文案作为一条 user 消息注入本轮对话（模型下一轮看到，不打断当前输出）。
      const steerItems = steers.drain();
      let steerPrompt = "";
      if (steerItems.length > 0) {
        emit("steer", {
          items: steerItems.map((it) => ({
            id: it.id,
            text: it.text,
            kind: it.kind ?? "user",
            fromName: it.fromName,
          })),
        });
        steerPrompt = `\n用户在你运行期间插入了下面的请求（把它们当作本轮新增的指令一并考虑）：\n${steerItems
          .map((it) => `- ${it.text}`)
          .join("\n")}\n`;
      }

      // 无进度检测预热：每轮开始记录当前进度状态（用于后续判断）
      let roundHadTextProgress = false;
      let roundHadToolProgress = false;
      let roundText = "";
      let sawDone = false;
      let roundFinishReason: string | undefined;
      const roundToolCalls: {
        id: string;
        name: string;
        args: unknown;
        result: { ok: boolean; content?: string; error?: string };
      }[] = [];

      // 多轮工具对话上下文（工具结果必须回灌，否则模型"失忆" → 回答截断/重复调用）
      if (!conversation) {
        conversation = opts.messages
          ? [...opts.messages]
          : [
              { role: "system", content: "你是 Loopsoar 平台的执行引擎，按诚实协议执行任务，必要时调用工具。" },
              { role: "user", content: "继续执行任务。如有需要调用工具，请直接给出工具调用指令；如已完成，请说明并总结结果。" },
            ];
      }
      if (steerPrompt) {
        conversation = [
          ...conversation,
          { role: "user", content: `【运行中插入的指令】${steerPrompt}` },
        ];
      }
      const request: LlmRequest = {
        messages: conversation,
        tools: tools(),
        // 不向上游传显式 max_tokens：各供应商对「最大输出」的上限差异巨大（从 4k 到数十万），
        // 传大了会被上游 400 拒绝，传小了反而制造截断。长度上限交给 finish_reason=length
        // 的同轮续写兜底（ADR-0045/0047），这是对未知上游最安全的行为。
        maxTokens: undefined,
        reasoningEffort: opts.reasoningEffort,
        signal: abortController.signal,
      };

      // 流式调用 LLM：手动迭代 + 与中止信号竞速。
      // 为什么不用 for-await：for-await 只在「下一个 chunk 到达」后才轮到循环体里的中止检查；
      // 上游卡住（长时间无 chunk）时用户点「停止」不会立即生效，UI 会一直显示「思考中」。
      const stream = llm.invoke(request)[Symbol.asyncIterator]();
      try {
        for (;;) {
          const step = await Promise.race([stream.next(), waitAbort()]);
          if (step.done) break;
          const chunk = step.value;
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
              roundText += textContent;
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
              if (process.env.LOOPSOAR_LOOP_DEBUG) console.log("[LOOP] tool_call", (chunk as { toolCall?: { name?: string } }).toolCall?.name);
              const tc = chunk as { kind: "tool_call"; toolCall: { id: string; name: string; args: unknown } };
              const toolCall: ToolCall = {
                id: tc.toolCall.id,
                name: tc.toolCall.name,
                args: tc.toolCall.args,
              };

              // 工具开始执行：先发 tool_start（UI 用它在时间线里显示「执行中」呼吸状态）
              emit("tool_start", {
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                args: toolCall.args,
              });

              // 工具调用执行期间：设置心跳间隔（定时发送 heartbeat 事件）
              const heartbeatInterval = setInterval(() => {
                if (!abortController.signal.aborted) {
                  emit("heartbeat", { silentMs: heartbeatMs });
                }
              }, heartbeatMs);

              // 静默超时：普通工具按 LOOP_HEALTH.silentTimeoutMs；
              // 长等待工具（ask_user 等需要真人回答的）豁免，走 longRunningTimeoutMs —— 否则会被 90s 误杀。
              // 心跳保持：长等待期间仍按 heartbeatMs 发 heartbeat（UI 显示「仍在等待」）。
              const isLongRunningTool = longRunningTools.has(toolCall.name);
              const silentTimeoutMs = isLongRunningTool ? longRunningTimeoutMs : normalSilentTimeoutMs;
              let silentTimer: NodeJS.Timeout | undefined;
              let warnTimer: NodeJS.Timeout | undefined;
              let toolResult: ToolResult;

              try {
                // 并发执行：工具调用与（可选的）硬超时/中止信号竞争。
                // 为什么带中止：MCP/终端工具自身无法可靠取消，但「用户点了停止」不能让循环
                // 一直卡在工具上（终端命令/子代理可能几分钟）——工具还在跑也要立刻收束本轮。
                const races: Array<Promise<ToolResult>> = [
                  executeTool.invoke(toolCall).catch((err) => ({
                    ok: false,
                    content: "",
                    error: err instanceof Error ? err.message : String(err),
                  } as ToolResult)),
                  waitAbort(),
                ];
                if (silentTimeoutMs > 0) {
                  races.push(new Promise<ToolResult>((_, reject) => {
                    silentTimer = setTimeout(() => {
                      reject(new Error("静默超时：工具执行超过安全静默时间"));
                    }, silentTimeoutMs);
                    // 不阻止进程退出（否则普通工具的 90s 定时器会拖住测试/退出路径）
                    silentTimer.unref?.();
                  }));
                }
                // 慢工具提示：只发事件，不中止；让用户看到「Agent 还在等」，而不是被 90s 判死。
                warnTimer = setTimeout(() => {
                  if (!abortController.signal.aborted) {
                    emit("heartbeat", { silentMs: silentTimeoutMs || silentWarnMs, slow: true, tool: toolCall.name });
                  }
                }, silentWarnMs);
                warnTimer.unref?.();
                const timeoutRace = Promise.race(races);

                toolResult = await timeoutRace;
              } catch (err) {
                // 用户中止：即使工具还在跑也立刻结束本轮（不再发起下一轮 LLM）。
                // 工具结果被放弃（无法可靠取消），其 promise 已挂 catch，不会产生 unhandled rejection。
                if (abortController.signal.aborted) {
                  emit("tool", {
                    toolCallId: toolCall.id,
                    toolName: toolCall.name,
                    args: toolCall.args,
                    result: { ok: false, content: "", error: "已停止" } as ToolResult,
                  });
                  return {
                    status: "aborted",
                    reason: "工具执行期间收到外部中止信号",
                    finalText,
                    usage,
                  };
                }
                // 超时：心跳已发，返回 silent（安全模式触发条件）
                emit("heartbeat", { silentMs: silentTimeoutMs });
                return {
                  status: "silent",
                  reason: `安全模式触发条件：工具执行静默超时（超过 ${silentTimeoutMs}ms）`,
                  finalText,
                  usage,
                };
              } finally {
                if (silentTimer) clearTimeout(silentTimer);
                if (warnTimer) clearTimeout(warnTimer);
                clearInterval(heartbeatInterval);
              }

              // 工具返回后的兜底检查：工具恰好在中止前落定（竞速落败）时，也不能继续本轮/下一轮
              if (abortController.signal.aborted) {
                emit("tool", {
                  toolCallId: toolCall.id,
                  toolName: toolCall.name,
                  args: toolCall.args,
                  result: { ok: false, content: "", error: "已停止" } as ToolResult,
                });
                return {
                  status: "aborted",
                  reason: "工具返回后收到外部中止信号",
                  finalText,
                  usage,
                };
              }

              // 工具调用完成后发送 tool 事件
              emit("tool", {
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                args: toolCall.args,
                result: toolResult,
              });

              // 更新预算：工具调用计数和 Token 计数
              usage.toolCalls += 1;
              if (chunk.tokens !== undefined) {
                usage.totalTokens += chunk.tokens;
              }

              // 防循环：相同工具+相同参数重复调用超过阈值 → 提示；超过硬阈值 → no-progress 停止
              const callKey = `${toolCall.name}:${JSON.stringify(toolCall.args ?? {})}`;
              const repeatCount = repeatCalls.get(callKey) ?? 0;
              repeatCalls.set(callKey, repeatCount + 1);
              if (repeatCount + 1 >= repeatWarnAt && repeatCount > 0 && toolResult.ok) {
                toolResult = {
                  ok: toolResult.ok,
                  content: `${toolResult.content}
[防循环提示] 该工具与参数已重复调用第 ${repeatCount + 1} 次；若结果没有变化，请停止重复并直接给出结论。`,
                  error: toolResult.error,
                };
              }
              if (repeatCount + 1 >= repeatStopAt) {
                emit("progress", {
                  note: `工具 ${toolCall.name} 相同参数已调用 ${repeatCount + 1} 次，触发防循环停止`,
                });
                return {
                  status: "no-progress",
                  reason: `工具 ${toolCall.name} 以相同参数连续调用 ${repeatCount + 1} 次，触发防循环停止。`,
                  finalText,
                  usage,
                };
              }

              // 工具结果只进对话上下文，不混进助手正文（否则 UI 会把工具输出当回答显示）
              roundToolCalls.push({
                id: toolCall.id,
                name: toolCall.name,
                args: toolCall.args,
                result: { ok: toolResult.ok, content: toolResult.content, error: toolResult.error },
              });
              if (toolResult.ok) roundHadToolProgress = true;

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
              sawDone = true;
              roundFinishReason = chunk.finishReason;
              break;
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
        // 用户主动中止：归一为 aborted（不 emit error —— 否则 UI 会当成真实失败弹红字）
        if (abortController.signal.aborted) {
          return {
            status: "aborted",
            reason: "LLM 调用期间收到外部中止信号",
            finalText,
            usage,
          };
        }
        // LLM 流调用异常：记录为 error 事件并返回 error 状态
        const msg = llmErr instanceof Error ? llmErr.message : String(llmErr);
        emit("error", { message: msg, fatal: true });
        return {
          status: "error",
          reason: `LLM 流调用异常：${msg}`,
          finalText,
          usage,
        };
      } finally {
        // 关闭上游流（等价于 for-await 提前 break 时的 IteratorClose：释放 SSE 连接/定时器）。
        // 注意：不 await —— 未实现中止的客户端可能让生成器卡在内部 await 上，
        // await return() 会把「立即返回」又拖成无限等待（正是本次要修的问题）。
        void Promise.resolve(stream.return?.(undefined)).catch(() => {});
      }

      // 本轮产生过工具调用：把 assistant(tool_calls) 与工具结果回灌，进入下一轮
      if (process.env.LOOPSOAR_LOOP_DEBUG) console.log("[LOOP] round done", { round, sawDone, tools: roundToolCalls.length, text: roundText.length, finishReason: roundFinishReason });
      if (roundToolCalls.length > 0) {
        // 工具调用参数被长度上限截断：参数 JSON 往往不完整（工具已执行失败），不能把这些残缺调用
        // 回灌给模型，否则它会基于错误结果继续；改为丢弃本轮残缺工具轮 + 明确要求重发。
        if ((roundFinishReason === "length" || roundFinishReason === "max_tokens") && lengthContinuations < maxLengthContinuations) {
          lengthContinuations += 1;
          emit("progress", {
            note: `工具调用参数被上游长度上限截断，已丢弃并请求重发（第 ${lengthContinuations}/${maxLengthContinuations} 次）…`,
          });
          if (process.env.LOOPSOAR_LOOP_DEBUG) {
            console.log("[LOOP] truncated tool round", { round, count: lengthContinuations, tools: roundToolCalls.length });
          }
          conversation = [
            ...conversation,
            { role: "assistant", content: roundText },
            {
              role: "user",
              content:
                "上一轮输出因长度上限被截断，工具调用参数不完整，已丢弃。请重新发起完整的工具调用；若已无需工具，请直接继续输出正文。",
            },
          ];
          continue;
        }
        conversation = [
          ...conversation,
          {
            role: "assistant",
            content: roundText,
            tool_calls: roundToolCalls.map((call) => ({ id: call.id, name: call.name, args: call.args })),
          },
          ...roundToolCalls.map((call) => {
            const raw = call.result.ok
              ? (call.result.content ?? "")
              : `[工具失败] ${call.result.error ?? call.result.content ?? "未知错误"}`;
            const clipped =
              raw.length > MAX_TOOL_RESULT_IN_CONTEXT
                ? `${raw.slice(0, MAX_TOOL_RESULT_IN_CONTEXT)}
…（工具结果过长已截断，完整内容见会话中的工具卡片）`
                : raw;
            return { role: "tool" as const, tool_call_id: call.id, content: clipped };
          }),
        ];
      } else if (sawDone) {
        // 引导续轮（移植 slime A-1061⑥）：模型只出正文、没有工具轮，本轮即将收尾；
        // 若运行中还有插入的引导，取走并在**同一轮**继续跑 —— 不另起用户消息、不打断当前输出，
        // UI 会把这批引导折进当前 assistant 的思考历程（chat:steer:applied → 「引导」卡）。
        const lateSteers = steers.drain();
        if (lateSteers.length > 0) {
          emit("steer", {
            items: lateSteers.map((it) => ({
              id: it.id,
              text: it.text,
              kind: it.kind ?? "user",
              fromName: it.fromName,
            })),
          });
          conversation = [
            ...conversation,
            { role: "assistant", content: roundText },
            {
              role: "user",
              content: `\n【运行中插入的指令】\n用户在你运行期间插入了下面的请求（把它们当作本轮新增的指令一并考虑）：\n${lateSteers
                .map((it) => `- ${it.text}`)
                .join("\n")}\n`,
            },
          ];
          continue;
        }
        // 上游长度截断自动续写（修复「长回复断在半句」的真实根因）：
        // 许多 OpenAI 兼容上游默认 max_tokens 远小于模型上限，正常长回答会在半句话被 finish_reason="length" 截断；
        // 旧实现丢弃 finish_reason，UI 看起来就是「消息被截断」。这里把已产出的正文回灌，让模型接着写，
        // 同一助手消息由 UI 继续拼接，用户无感。
        if ((roundFinishReason === "length" || roundFinishReason === "max_tokens") && lengthContinuations < maxLengthContinuations) {
          lengthContinuations += 1;
          if (process.env.LOOPSOAR_LOOP_DEBUG) {
            console.log("[LOOP] length continuation", {
              round,
              count: lengthContinuations,
              roundTextLen: roundText.length,
              finishReason: roundFinishReason,
            });
          }
          emit("progress", {
            note: `输出达到上游长度上限，自动续写（第 ${lengthContinuations}/${maxLengthContinuations} 次）…`,
          });
          conversation = [
            ...conversation,
            { role: "assistant", content: roundText },
            {
              role: "user",
              content: "请紧接上文继续输出未完成的内容：不要重复已写内容，不要重新开头，不要总结。",
            },
          ];
          continue;
        }
        // 续写预算用尽但上游仍以长度上限结束：绝不能静默截断。
        // 追加明确标记（进入 finalText / 持久化 / 复制）+ 进度提示，用户一眼能看出「这里是被截断的」。
        if (roundFinishReason === "length" || roundFinishReason === "max_tokens") {
          const marker = `\n\n（输出因上游长度上限中断，已自动续写 ${maxLengthContinuations} 次仍未结束）`;
          emit("progress", {
            note: `输出达到上游长度上限且自动续写次数用尽（${maxLengthContinuations} 次），已在末尾标注截断原因`,
          });
          emit("chunk", { text: marker });
          finalText += marker;
        }
        // 上游内容安全过滤掐断：同样不能静默，给用户一个可见原因。
        if (roundFinishReason === "content_filter") {
          emit("progress", { note: "上游内容安全过滤截断了回复（finish_reason=content_filter）" });
        }
        // 中止优先于核验：用户已点停止就不再为收束做额外的核验 IO
        if (abortController.signal.aborted) {
          return {
            status: "aborted",
            reason: "LLM 调用期间收到外部中止信号",
            finalText,
            usage,
          };
        }
        // 每轮声称核验（可选）：模型准备收束但本轮没调工具 → 先核验它的「已完成」声称。
        // 为什么在这里拦：等最终收束后再核验，用户已经看到「已保存/已完成」的假完成了；
        // 核验未通过就注入一条 user 提示，逼模型用工具实际核实（最多 maxVerifyForcedRounds 次）。
        let verifyFailed = false;
        let verifyNote = "";
        if (opts.verifyRound) {
          try {
            const verdict = await opts.verifyRound({
              round: round + 1,
              finalText,
              usedAnyTool: usage.toolCalls > 0,
            });
            verifyFailed = verdict.ok === false;
            verifyNote = verdict.note ?? "声称与事实不符";
          } catch (err) {
            // 核验器自身异常：不阻断收束（避免核验故障误伤正常完成），但必须可见
            emit("progress", {
              note: `声称核验异常（本轮已跳过）：${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }
        // 核验期间收到中止：不再收束/续轮，直接以 aborted 结束
        if (abortController.signal.aborted) {
          return {
            status: "aborted",
            reason: "LLM 调用期间收到外部中止信号",
            finalText,
            usage,
          };
        }
        if (verifyFailed) {
          if (forcedVerifyRounds < maxVerifyForcedRounds) {
            forcedVerifyRounds += 1;
            emit("progress", {
              note: `声称核验未通过（${verifyNote}），注入强制工具轮 ${forcedVerifyRounds}/${maxVerifyForcedRounds}`,
              verify: true,
            });
            // 把模型的收束正文与本轮核验结论一起回灌，模型才知道「哪句话没被采信」
            conversation = [
              ...conversation,
              { role: "assistant", content: roundText },
              {
                role: "user",
                content: `声称核验未通过：${verifyNote}，请先用工具实际核实再收束`,
              },
            ];
            // 强制轮是有效推进：清零无进度计数，避免被误判成死循环
            roundsWithoutProgress = 0;
            continue;
          }
          emit("progress", {
            note: `声称核验未通过，但强制工具轮已达上限（${maxVerifyForcedRounds}），按现有结果收束`,
          });
        }
        emit("done", { finalText });
        return {
          status: "done",
          reason: verifyFailed
            ? `LLM 返回 done，任务完成（声称核验未通过，强制工具轮已达上限 ${maxVerifyForcedRounds}）`
            : "LLM 返回 done，任务完成",
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
          // 字段名必须是 note：渲染层只读 note（旧写 message 会让用户看不到停止原因）。
          emit("progress", { note: `连续 ${npr} 轮无实质进度，触发安全停止` });
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
    // 中止导致的中断（例如上游 abort 后抛出的异常）也归为 aborted，而不是 error
    if (abortController.signal.aborted) {
      return {
        status: "aborted",
        reason: "外部中止信号触发，工具循环被终止",
        finalText,
        usage,
      };
    }
    // 最外层异常捕获：任何未被内部捕获的异常都转为 error 状态，保证不崩溃（fail-closed）
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: "error",
      reason: `工具循环运行异常：${msg}`,
      finalText,
      usage,
    };
  } finally {
    // 解绑外部信号监听（长生命周期 signal 上不能留悬挂监听器）
    if (signal) signal.removeEventListener("abort", onExternalAbort);
  }
}
