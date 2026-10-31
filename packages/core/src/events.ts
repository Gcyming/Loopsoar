/**
 * 循环事件类型（§4.1 events）
 * 统一事件流形状：每个事件有递增序号 seq、类型 type、载荷 data、时间戳 ts。
 * data 保持 unknown：载荷形状由各 emit 调用点保证，EventSink 消费者按 type 自行收窄。
 * 纯类型定义，零 node 内建依赖。
 */
export type LoopEventType =
  | "chunk"
  | "reasoning"
  | "tool"
  | "tool_start"
  | "progress"
  | "done"
  | "error"
  | "heartbeat";

export interface LoopEvent {
  seq: number;
  type: LoopEventType;
  data: unknown;
  ts: number;
}

/** 事件沉降接口：消费者通过此函数接收循环事件。 */
export type EventSink = (e: LoopEvent) => void;
