/**
 * 运行期落盘存储的装配点：检查点与 trace 都挂在 dataDir 下，按会话隔离。
 * 单独成文件的原因：index.ts 已贴近 1500 行红线，装配细节不该继续堆在入口。
 */
import path from "node:path";
import { CheckpointStore } from "./checkpointStore.js";
import { estimateCostUsd } from "./pricing.js";
import { TraceStore } from "./traceStore.js";

export interface RunStores {
  checkpoints: CheckpointStore;
  traces: TraceStore;
}

export function createRunStores(dataDir: string): RunStores {
  return {
    checkpoints: new CheckpointStore(path.join(dataDir, "checkpoints")),
    traces: new TraceStore(path.join(dataDir, "traces")),
  };
}

/** 回合收尾：关闭检查点组（快照保留），落一条 turn trace；不得抛错影响聊天结果。 */
export function closeTurn(
  stores: RunStores,
  sessionId: string,
  usage: { rounds: number; toolCalls: number; totalTokens: number; inputTokens?: number; outputTokens?: number },
  status: string,
  meta?: { model?: string } | null,
): void {
  try {
    stores.checkpoints.end(sessionId);
    stores.traces.turn({
      sessionId,
      rounds: usage.rounds,
      toolCalls: usage.toolCalls,
      tokens: usage.totalTokens,
      ...(meta?.model ? { model: meta.model } : {}),
      ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      ...(estimateCostUsd(meta?.model, usage) !== undefined ? { costUsd: estimateCostUsd(meta?.model, usage)! } : {}),
      note: status,
    });
  } catch {
    // 落盘失败不影响主流程
  }
}
