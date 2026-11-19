/**
 * 全应用层级常量（单一产地）。
 * 浮层与模态都在 DOM 里，原生 WebContentsView 不参与，需要 App 同时让位。
 */
export const POPOVER_Z_INDEX = 2_147_483_000;
export const MODAL_Z_INDEX = POPOVER_Z_INDEX + 1;
