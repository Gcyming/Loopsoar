// §6 gateway 包 / 统一入口：从 app 实现再导出，供外部调用或测试使用。
export { buildApp, startServer, createBearerMiddleware } from "./app.js";
export type { GatewayOptions } from "./app.js";
