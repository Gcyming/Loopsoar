/**
 * 全局事件名清单（单一产地）。
 * 从 schemas.ts 抽出以控制单文件体积；schemas.ts 继续 re-export，保持既有 import 不变。
 */
export const EVENTS = [
  "chat:stream:chunk",
  "chat:stream:reasoning",
  "chat:stream:tool",
  "chat:stream:tool_start",
  "chat:stream:progress",
  "chat:stream:done",
  "chat:stream:error",
  "chat:stream:heartbeat",
  "chat:steer:applied",
  "perm:request",
  "browser:tabs",
  "chat:taskForked",
  "browser:downloads",
  "memory:updated",
  "rules:updated",
  "extensions:updated",
  "skills:updated",
  "mcp:updated",
  "terminal:data",
  "terminal:exit",
  "terminal:state",
  "ask:user",
  "loop:fallback",
  "loop:changed",
  "chrome:popoverAction",
  "chrome:popoverClosed",
  "chrome:dismissPopovers",
  "chrome:devToolsPanel",
  /**
   * Agent 正在操控浏览器的实时活动（{ sessionId?, tool, phase: "start" | "end" }）。
   * 渲染层据此：① 当前会话只在动作期间显示浏览器边框呼吸灯；② 把操作中的标签切到可见。
   * 注意：跨会话只更新「该会话正在忙」的状态，绝不切走用户正在看的会话（会话隔离）。
   */
  "chrome:agentActivity",
  /** 一轮对话开始/结束（Agent 接管网页的窗口期）：呼吸灯与接管锁共用这个生命周期。 */
  "chrome:agentWindowClosed",
  "chrome:agentWindowIconMode",
  "chrome:agentWindowTransition",
  /**
   * Agent 首次打开网页前的「会话窗口布局」安排（第二阶段 Slice E · 功能②）：
   * 壳层询问/记忆完成后推送 { mode: "docked" | "agentWindow"; sessionId?; reason? }，
   * 渲染层据此执行真正的窗口动作（收小窗 / 恢复右侧常驻）。
   */
  "chrome:applyLayout",
  "chat:compacted",
] as const;

/** Type for event names (string literal union). */
export type EventName = typeof EVENTS[number];
