/**
 * 契约包根入口（构建产物）。
 *
 * 子路径仍是主要使用方式；根入口只保证 `import 'loopsoar-contracts'` 在 Node 中可加载。
 * 不在这里重新导出所有内部文件，避免扩大公共 API 面。
 */
export * from "./schemas.js";
