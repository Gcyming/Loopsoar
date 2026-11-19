// 平台适配层对外导出（§4.2 S4 职责）
// 禁止自递归包装；直接从实现模块重导出函数与类型
export * from "./types.js";
export * from "./errors.js";
export { createNodePlatform, nodePathPort } from "./node.js";
