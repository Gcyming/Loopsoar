// §6 gateway 包 / 主入口
// 说明：可直接执行 `node dist/main.js` 启动服务器；
// 环境变量 LOOPSOAR_GATEWAY_PORT 默认 19110，LOOPSOAR_GATEWAY_TOKEN 控制认证强制与否（空则不强制）。
// 未定义细节选最简实现（直接调用 startServer，无额外配置解析层）。

import { startServer } from "./index.js";

async function main(): Promise<void> {
  // 从环境变量读取配置
  const portEnv = process.env.LOOPSOAR_GATEWAY_PORT;
  const tokenEnv = process.env.LOOPSOAR_GATEWAY_TOKEN || "";
  const port = portEnv ? parseInt(portEnv, 10) : 19110;
  const requireToken = tokenEnv.length > 0;

  try {
    const { url } = await startServer({
      port,
      requireToken,
      gatewayToken: tokenEnv,
    });
    console.log(`[Loopsoar Gateway] 已启动：${url}`);
    console.log(`[Loopsoar Gateway] 认证强制：${requireToken ? "已启用" : "已禁用（空令牌）"}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Loopsoar Gateway] 启动失败：${msg}`);
    process.exit(1);
  }
}

main();
