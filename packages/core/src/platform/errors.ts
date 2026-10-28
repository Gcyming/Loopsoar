/**
 * 平台层未实现错误
 * 用于标记尚未在特定平台实现的功能（如 web 端的 sqlite、web 端的 embed 等）
 */
export class LoopsoarNotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoopsoarNotImplementedError";
    // 确保原型链正确，支持 instanceof 检查
    Object.setPrototypeOf(this, LoopsoarNotImplementedError.prototype);
  }
}