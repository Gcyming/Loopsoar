/**
 * 生成文件：由 scripts/gen.ts 生成，不可手动修改。
 * 唯一产地：packages/contracts/src/schemas.ts 与 src/security-policy.ts。
 */

import { z } from "zod";
import { CHANNEL_BINDINGS } from "../src/schemas.js";

/**
 * IPC_CHANNELS：通道常量对象（通道名 → 元数据）。
 */
export const IPC_CHANNELS = {
  "chat:stream": { domain: "chat", method: "stream", sensitive: true, hasRequest: true },
  "chat:stop": { domain: "chat", method: "stop", sensitive: true, hasRequest: true },
  "chat:send": { domain: "chat", method: "send", sensitive: true, hasRequest: true },
  "perm:respond": { domain: "perm", method: "respond", sensitive: true, hasRequest: true },
  "file:read": { domain: "workspace", method: "read", sensitive: true, hasRequest: true },
  "file:write": { domain: "workspace", method: "write", sensitive: true, hasRequest: true },
  "agents:list": { domain: "agents", method: "list", sensitive: true, hasRequest: false },
  "app:version": { domain: "runtime", method: "version", sensitive: true, hasRequest: false },
  "boot:status": { domain: "runtime", method: "status", sensitive: true, hasRequest: false },
  "browser:navigate": { domain: "browser", method: "navigate", sensitive: true, hasRequest: true },
  "browser:screenshot": { domain: "browser", method: "screenshot", sensitive: true, hasRequest: true },
  "browser:snapshot": { domain: "browser", method: "snapshot", sensitive: true, hasRequest: false },
} as const;

/**
 * IpcRequest 包装类型：通道名 + 载荷。
 */
export type IpcRequest<T> = {
  readonly channel: string;
  readonly payload: T;
};

/**
 * IPC_METHODS：通道名 → 参数类型名映射（用 z.infer）。
 * 用于下游根据 channel 名获取对应请求参数的类型名称字符串。
 */
export type IPC_METHODS = {
  "chat:stream": z.infer<typeof import("../src/schemas.js").ChatStreamSchema>;
  "chat:stop": z.infer<typeof import("../src/schemas.js").ChatStopSchema>;
  "chat:send": z.infer<typeof import("../src/schemas.js").ChatSendSchema>;
  "perm:respond": z.infer<typeof import("../src/schemas.js").PermRespondSchema>;
  "file:read": z.infer<typeof import("../src/schemas.js").FileReadSchema>;
  "file:write": z.infer<typeof import("../src/schemas.js").FileWriteSchema>;
  "agents:list": null;
  "app:version": null;
  "boot:status": null;
  "browser:navigate": z.infer<typeof import("../src/schemas.js").BrowserNavigateSchema>;
  "browser:screenshot": z.infer<typeof import("../src/schemas.js").BrowserScreenshotSchema>;
  "browser:snapshot": null;
};

/**
 * IPC_VALIDATORS：通道名 → zod 校验器（无参通道为 null）。
 * 与 CHANNEL_BINDINGS 同源（直接由 request 字段推导），
 * 供受信 IPC 入口做四要素校验之「参数合法性」。
 */
export const IPC_VALIDATORS: Record<string, z.ZodTypeAny | null> = Object.fromEntries(
  Object.entries(CHANNEL_BINDINGS).map(([channel, b]) => [channel, b.request]),
) as Record<string, z.ZodTypeAny | null>;

/**
 * buildPreloadWhitelist：根据 CHANNEL_BINDINGS 构建 preload 白名单。
 * 用于 Electron preload 层暴露接口时的域名→方法映射。
 */
export function buildPreloadWhitelist(): { domains: Record<string, string[]> } {
  return {
    domains: {
    "chat": ["stream", "stop", "send"],
    "perm": ["respond"],
    "workspace": ["read", "write"],
    "agents": ["list"],
    "runtime": ["version", "status"],
    "browser": ["navigate", "screenshot", "snapshot"]
    },
  };
}

/**
 * EVENT_NAMES：所有事件名列表。
 */
export const EVENT_NAMES = [
  "chat:stream:chunk",
  "chat:stream:done",
  "chat:stream:error",
  "chat:stream:heartbeat",
  "perm:request",
  "boot:ready",
] as const;
