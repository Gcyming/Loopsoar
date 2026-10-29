// §5 services 包 / 事件流批量器
// 说明：流式输出按 40ms / 24000 字合批，减少碎片化传输；
// 未定义细节选最简实现（直接定时+计数字合批，无复杂缓冲策略）。

/** 流式数据块类型 */
export interface ChunkItem {
  content: string;
  meta?: Record<string, unknown>;
}

/** 批量合批结果 */
export interface ChunkBatch {
  chunks: ChunkItem[];
  totalChars: number;
  emittedAt: number;
}

/**
 * StreamChunkBatcher：40ms 合批 / 24000 字上限
 * 设计理由：网络传输过小碎片增加协议开销，过大则延迟增加；
 * 40ms 是人眼感知延迟与网络往返的平衡点；24000 字防止单包过大。
 */
export class StreamChunkBatcher {
  private buffer: ChunkItem[] = [];
  private charCount = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly flushIntervalMs = 20; // 20ms：降低流式增量延迟（原 40ms 观感偏慢）
  private readonly maxBatchChars = 24000; // §5 规格：24000 字

  constructor(private onFlush: (batch: ChunkBatch) => void) {}

  /** 添加单个数据块 */
  push(chunk: ChunkItem): void {
    this.buffer.push(chunk);
    this.charCount += chunk.content.length;
    // 字数触发：达到 24000 字立即合批
    if (this.charCount >= this.maxBatchChars) {
      this.flushNow();
    } else {
      // 定时触发：每 40ms 至少合批一次（无数据则跳过）
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.flushNow();
        }, this.flushIntervalMs);
      }
    }
  }

  /** 手动立即合批 */
  flushNow(): void {
    if (this.buffer.length === 0) return;
    const chunks = this.buffer.splice(0, this.buffer.length);
    const totalChars = chunks.reduce((s, c) => s + c.content.length, 0);
    this.charCount = 0;
    this.onFlush({
      chunks,
      totalChars,
      emittedAt: Date.now(),
    });
  }

  /** 停止定时器并清空缓冲 */
  close(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flushNow();
  }
}