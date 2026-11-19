import { BrowserControlSchema, ChatCompactSchema, ChatForkSchema, ChatRenameSessionSchema, ChatRollbackSchema, ChatSaveTimelineSchema, ChatSendSchema, ChatSteerCancelSchema, ChatSteerSchema, ChatStopSchema, ChatStreamSchema, NewSessionSchema, PermRespondSchema, SessionRefSchema } from "../validators.js";
import type { ChannelBinding } from "../validators.js";

/** 通道 chat 域：按域拆分，键顺序由 ../channels/index.ts 统一恢复。 */
export const chatChannels: Record<string, ChannelBinding> = {
  "chat:stream": {
    domain: "chat",
    method: "stream",
    request: ChatStreamSchema,
    sensitive: true,
  },
  "chat:steer": {
    domain: "chat",
    method: "steer",
    request: ChatSteerSchema,
    sensitive: true,
  },
  "chat:steerCancel": {
    domain: "chat",
    method: "steerCancel",
    request: ChatSteerCancelSchema,
    sensitive: true,
  },
  "chat:rollback": {
    domain: "chat",
    method: "rollback",
    request: ChatRollbackSchema,
    sensitive: true,
  },
  "chat:renameSession": {
    domain: "chat",
    method: "renameSession",
    request: ChatRenameSessionSchema,
    sensitive: true,
  },
  "chat:forkSession": {
    domain: "chat",
    method: "forkSession",
    request: ChatForkSchema,
    sensitive: true,
  },
  "chat:saveTimeline": {
    domain: "chat",
    method: "saveTimeline",
    request: ChatSaveTimelineSchema,
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
  "chat:history": {
    domain: "chat",
    method: "history",
    request: null,
    sensitive: true,
  },
  "chat:sessions": {
    domain: "chat",
    method: "sessions",
    request: null,
    sensitive: true,
  },
  "chat:newSession": {
    domain: "chat",
    method: "newSession",
    request: NewSessionSchema,
    sensitive: true,
  },
  "chat:switchSession": {
    domain: "chat",
    method: "switchSession",
    request: SessionRefSchema,
    sensitive: true,
  },
  "chat:deleteSession": {
    domain: "chat",
    method: "deleteSession",
    request: SessionRefSchema,
    sensitive: true,
  },
  "chat:setBrowserControl": {
    domain: "chat",
    method: "setBrowserControl",
    request: BrowserControlSchema,
    sensitive: true,
  },
  "chat:compact": {
    domain: "chat",
    method: "compact",
    request: ChatCompactSchema,
    sensitive: true,
  },
};
