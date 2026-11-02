/**
 * gateway 域：嵌入式 OpenAI 兼容网关的启停通道（gateway:status / gateway:start / gateway:stop）。
 *
 * 为什么由 shell 域承载而不是 gateway 包自己监听：真正要跑的是本机 Agent 运行时
 * （platform/工具/记忆/供应商/密钥都在 shell），gateway 包只提供 HTTP 协议层；
 * 域层负责生命周期 + 状态事件，UI 据此显示「运行中 / 地址 / 是否需要令牌」。
 *
 * 安全默认：只监听 127.0.0.1；LOOPSOAR_GATEWAY_TOKEN 非空时强制 Bearer（401 OpenAI 错误形状）。
 */
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";
// 只做类型引用（编译期擦除）：域层注册不应把 gateway 运行时/HTTP 依赖带进静态导入图，
// 保持「通道存在性守卫」等测试可以只装配域而不启动任何 HTTP 栈。
import type { GatewayRuntime } from "../gatewayRuntime.js";

/** 缺省监听端口（与 gatewayRuntime.GATEWAY_DEFAULT_PORT / gateway.startServer 的默认值一致）。 */
const GATEWAY_DEFAULT_PORT = 19210;

/** 网关状态（gateway:status 返回值；gateway:changed 事件同形状）。 */
export interface GatewayStatus {
  running: boolean;
  /** 监听地址（未运行时 null）。 */
  url: string | null;
  /** 是否需要 Bearer 令牌（LOOPSOAR_GATEWAY_TOKEN 非空即需要）。 */
  tokenRequired: boolean;
  /** 最近一次启动/停止失败的可读原因（成功后清空）。 */
  error: string | null;
}

export interface GatewayDomainDeps extends TrustedIpcDeps {
  /** 推送事件（index 传 pushToRenderer；缺省不推）。 */
  push?: (event: string, payload: unknown) => void;
  /** 环境变量（缺省 process.env；token/端口都从这里读）。 */
  env?: Record<string, string | undefined>;
}

/** 运行时工厂：由 index 注入（含 dataDir/configDir/platform），域层不关心装配细节。 */
export type GatewayRuntimeFactory = () => Promise<GatewayRuntime>;

function parsePort(raw: string | undefined): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 && value <= 65_535 ? value : GATEWAY_DEFAULT_PORT;
}

/** 注册网关启停通道；同一时刻只会有一个监听实例（幂等 start/stop）。 */
export function registerGatewayDomain(deps: GatewayDomainDeps, runtimeFactory: GatewayRuntimeFactory): void {
  const env = deps.env ?? process.env;
  let runtime: GatewayRuntime | null = null;
  let running = false;
  let url: string | null = null;
  let tokenRequired = false;
  let lastError: string | null = null;
  let starting: Promise<GatewayStatus> | null = null;

  const status = (): GatewayStatus => ({ running, url, tokenRequired, error: lastError });
  const notify = (): void => {
    try {
      deps.push?.("gateway:changed", status());
    } catch {
      // 推送失败不影响启停结果
    }
  };

  handleTrusted(deps, "gateway:status", () => status());

  handleTrusted(deps, "gateway:start", async (): Promise<GatewayStatus> => {
    if (running && runtime) return status();
    if (starting) return starting;
    starting = (async (): Promise<GatewayStatus> => {
      lastError = null;
      let next: GatewayRuntime | null = null;
      try {
        next = await runtimeFactory();
        const port = parsePort(env.LOOPSOAR_GATEWAY_PORT);
        await next.app.listen({ port, host: "127.0.0.1" });
        runtime = next;
        running = true;
        url = `http://127.0.0.1:${port}`;
        tokenRequired = next.tokenRequired;
        return status();
      } catch (err) {
        lastError = `网关启动失败：${err instanceof Error ? err.message : String(err)}`;
        running = false;
        url = null;
        if (next) {
          try {
            await next.dispose();
          } catch {
            // 启动失败清理失败：保留原始错误
          }
        }
        return status();
      } finally {
        starting = null;
        notify();
      }
    })();
    return starting;
  });

  handleTrusted(deps, "gateway:stop", async (): Promise<GatewayStatus> => {
    if (!runtime) {
      running = false;
      url = null;
      notify();
      return status();
    }
    try {
      await runtime.dispose();
    } catch (err) {
      lastError = `网关停止时清理失败：${err instanceof Error ? err.message : String(err)}`;
    }
    runtime = null;
    running = false;
    url = null;
    notify();
    return status();
  });
}
