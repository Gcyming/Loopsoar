/**
 * 供应商模型 token 上限（上下文 / 最大输出共用）。
 *
 * 必须是实际 token 数，不是 K。上游元数据常见 1,048,576（二进制百万），
 * 旧上限 1,000,000 会把合法模型挡在保存之外；统一放宽到 10,000,000。
 *
 * 单独放在轻量模块，供 UI 表格与 zod schema 共用，避免把整个 validators/zod
 * 带进渲染层 bundle。
 */
export const PROVIDER_MODEL_TOKEN_LIMIT = 10_000_000;
