// §6 gateway 包 / 独立进程入口。
// 说明：真实 Agent 运行时由宿主（Loopsoar 应用主进程）注入 —— 独立进程没有 registry/LLM/工作区装配，
// 因此这里不再自行启动（避免"启动了但永远 500"的假可用）；请从应用内「网关」开关或
// `gateway:start` IPC 启动，或自行 import buildApp 注入 runner。

import { buildApp } from "./app.js";

async function main(): Promise<void> {
  console.error(
    [
      "[Loopsoar Gateway] 独立进程启动已停用：网关需要宿主注入 Agent 运行时（runner）。",
      "请在 Loopsoar 应用内启动网关（设置 → 网关 / gateway:start），",
      "或在自有进程中 import { buildApp } 并注入 GatewayChatRunner。",
    ].join("\n"),
  );
  // 保留 buildApp 引用，避免打包器把本文件判定为无副作用而整体摇掉（也便于未来自带 runner 时复用）
  void buildApp;
  process.exitCode = 1;
}

main();
