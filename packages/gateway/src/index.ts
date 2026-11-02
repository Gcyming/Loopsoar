// §6 gateway 包 / 统一入口。
// 说明：app.ts 提供 OpenAI 兼容服务（runner 由宿主注入 —— shell/gatewayRuntime.ts 实现 Agent 运行时）；
// 本入口再导出供测试（app.inject）与嵌入启动（shell domains/gateway.ts）使用。
export {
  buildApp,
  createBearerMiddleware,
  finishReasonForStatus,
  openAiError,
  startServer,
} from "./app.js";
export type {
  GatewayChatMessage,
  GatewayChatRequest,
  GatewayChatRunner,
  GatewayCompletionOutcome,
  GatewayModelInfo,
  GatewayOptions,
  GatewayToolCallDelta,
  GatewayUsage,
  OpenAiStreamChunk,
} from "./app.js";
