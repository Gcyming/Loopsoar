import { z } from "zod";

/**
 * Named Zod schemas for each channel request payload.
 * Used by gen/ipc.ts for z.infer mapping.
 */
export const ChatStreamSchema = z.object({ message: z.string(), sessionId: z.string().optional() });
export const ChatStopSchema = z.object({ sessionId: z.string() });
export const ChatSendSchema = z.object({ message: z.string(), sessionId: z.string().optional() });
export const PermRespondSchema = z.object({ requestId: z.string(), choice: z.enum(["allow-once", "allow-session", "deny"]) });
export const FileReadSchema = z.object({ path: z.string(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().positive().optional() });
export const FileWriteSchema = z.object({ path: z.string(), content: z.string() });
export const BrowserNavigateSchema = z.object({ url: z.string() });
export const BrowserScreenshotSchema = z.object({ selector: z.string().optional() });

/**
 * Provider（模型服务商）配置：只包含非机密字段。
 * 为什么 apiKey 不在此 schema：密钥不落盘（前期准备 §4 安全门：apiKey 加密存储前先走环境变量），
 * 配置通道只负责 baseUrl/model/provider 三个可公开字段。
 */
export const SettingsProviderSchema = z.object({
  provider: z.string().min(1).max(64),
  baseUrl: z.string().url(),
  model: z.string().min(1).max(200),
});

/**
 * ChannelBinding defines the structure of a communication channel.
 * domain: The domain/category of the channel (e.g., "chat", "perm")
 * method: The method/action name (e.g., "stream", "read")
 * request: Zod schema for the request payload, or null if no request payload
 * sensitive: Whether the channel is sensitive (requires special handling)
 */
export type ChannelBinding = {
  domain: string;
  method: string;
  request: z.ZodTypeAny | null; // Zod schema for request payload, or null
  sensitive: boolean;
};

/**
 * CHANNEL_BINDINGS: All supported communication channels.
 * 12 channels, all marked sensitive (true).
 * Each channel has a domain, method, request schema (or null), and sensitive flag.
 */
export const CHANNEL_BINDINGS: Record<string, ChannelBinding> = {
  "chat:stream": {
    domain: "chat",
    method: "stream",
    request: ChatStreamSchema,
    sensitive: true,
  },
  "chat:stop": {
    domain: "chat",
    method: "stop",
    request: ChatStopSchema,
    sensitive: true,
  },
  "chat:send": {
    domain: "chat",
    method: "send",
    request: ChatSendSchema,
    sensitive: true,
  },
  "perm:respond": {
    domain: "perm",
    method: "respond",
    request: PermRespondSchema,
    sensitive: true,
  },
  "file:read": {
    domain: "workspace",
    method: "read",
    request: FileReadSchema,
    sensitive: true,
  },
  "file:write": {
    domain: "workspace",
    method: "write",
    request: FileWriteSchema,
    sensitive: true,
  },
  "agents:list": {
    domain: "agents",
    method: "list",
    request: null,
    sensitive: true,
  },
  "app:version": {
    domain: "runtime",
    method: "version",
    request: null,
    sensitive: true,
  },
  "boot:status": {
    domain: "runtime",
    method: "status",
    request: null,
    sensitive: true,
  },
  "browser:navigate": {
    domain: "browser",
    method: "navigate",
    request: BrowserNavigateSchema,
    sensitive: true,
  },
  "browser:screenshot": {
    domain: "browser",
    method: "screenshot",
    request: BrowserScreenshotSchema,
    sensitive: true,
  },
  "browser:snapshot": {
    domain: "browser",
    method: "snapshot",
    request: null,
    sensitive: true,
  },
  "settings:getProvider": {
    domain: "settings",
    method: "getProvider",
    request: null,
    sensitive: true,
  },
  "settings:setProvider": {
    domain: "settings",
    method: "setProvider",
    request: SettingsProviderSchema,
    sensitive: true,
  },
};

 /**
  * EVENTS: List of all event names used in the system.
  * These are used for event bus and logging.
  */
export const EVENTS = [
  "chat:stream:chunk",
  "chat:stream:done",
  "chat:stream:error",
  "chat:stream:heartbeat",
  "perm:request",
  "boot:ready",
] as const;

/**
 * Type for event names (string literal union).
 */
export type EventName = typeof EVENTS[number];