// window.loopsoarAPI 声明文件。
// 结构对齐 shell 预加载白名单（packages/shell/src/preload/index.ts 由 S6 产出）：
// 域 chat/perm/file/agents/runtime/browser，各自暴露 <method> 调用；
// on(event, cb) 返回退订函数。
// ui 包只消费运行时声明，不依赖 shell 源码，故在此本地声明并与 preload 白名单对齐。

// 单个域下的方法映射：<domain>.<method>(...args) => Promise<any>
export interface LoopsoarDomain {
  [method: string]: (...args: unknown[]) => Promise<unknown>;
}

// 整个 loopsoarAPI 形状，与 preload 白名单生成的 <domain>.<method> + on 保持一致。
export interface LoopsoarAPI {
  chat: LoopsoarDomain;
  perm: LoopsoarDomain;
  file: LoopsoarDomain;
  agents: LoopsoarDomain;
  runtime: LoopsoarDomain & {
    bootStatus(): Promise<{ status: string; version?: string }>;
  };
  browser: LoopsoarDomain;
  // 订阅主进程事件，返回退订函数。
  on(event: string, cb: (...args: unknown[]) => void): () => void;
}

// 扩充全局 Window，使 App.tsx 等源码可直接使用 window.loopsoarAPI。
declare global {
  interface Window {
    loopsoarAPI?: LoopsoarAPI;
  }
}

export {};