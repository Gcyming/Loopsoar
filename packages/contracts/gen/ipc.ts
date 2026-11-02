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
  "chat:steer": { domain: "chat", method: "steer", sensitive: true, hasRequest: true },
  "chat:rollback": { domain: "chat", method: "rollback", sensitive: true, hasRequest: true },
  "fs:readImage": { domain: "fs", method: "readImage", sensitive: true, hasRequest: true },
  "fs:saveImage": { domain: "fs", method: "saveImage", sensitive: true, hasRequest: true },
  "chat:saveTimeline": { domain: "chat", method: "saveTimeline", sensitive: true, hasRequest: true },
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
  "browser:newTab": { domain: "browser", method: "newTab", sensitive: true, hasRequest: true },
  "browser:closeTab": { domain: "browser", method: "closeTab", sensitive: true, hasRequest: true },
  "browser:selectTab": { domain: "browser", method: "selectTab", sensitive: true, hasRequest: true },
  "browser:listTabs": { domain: "browser", method: "listTabs", sensitive: true, hasRequest: false },
  "browser:setOverlay": { domain: "browser", method: "setOverlay", sensitive: true, hasRequest: true },
  "settings:listModels": { domain: "settings", method: "listModels", sensitive: true, hasRequest: true },
  "dialog:pickPath": { domain: "dialog", method: "pickPath", sensitive: true, hasRequest: true },
  "browser:setSidebarWidth": { domain: "browser", method: "setSidebarWidth", sensitive: true, hasRequest: true },
  "memory:list": { domain: "memory", method: "list", sensitive: true, hasRequest: false },
  "memory:add": { domain: "memory", method: "add", sensitive: true, hasRequest: true },
  "memory:update": { domain: "memory", method: "update", sensitive: true, hasRequest: true },
  "memory:delete": { domain: "memory", method: "delete", sensitive: true, hasRequest: true },
  "memory:stats": { domain: "memory", method: "stats", sensitive: true, hasRequest: false },
  "memory:clear": { domain: "memory", method: "clear", sensitive: true, hasRequest: false },
  "chat:history": { domain: "chat", method: "history", sensitive: true, hasRequest: false },
  "settings:getProvider": { domain: "settings", method: "getProvider", sensitive: true, hasRequest: false },
  "settings:setProvider": { domain: "settings", method: "setProvider", sensitive: true, hasRequest: true },
  "window:minimize": { domain: "window", method: "minimize", sensitive: true, hasRequest: false },
  "window:maximize": { domain: "window", method: "maximize", sensitive: true, hasRequest: false },
  "window:close": { domain: "window", method: "close", sensitive: true, hasRequest: false },
  "window:state": { domain: "window", method: "state", sensitive: true, hasRequest: false },
  "settings:getPreferences": { domain: "settings", method: "getPreferences", sensitive: true, hasRequest: false },
  "settings:setPreferences": { domain: "settings", method: "setPreferences", sensitive: true, hasRequest: true },
  "settings:getPermissions": { domain: "settings", method: "getPermissions", sensitive: true, hasRequest: false },
  "settings:setPermissions": { domain: "settings", method: "setPermissions", sensitive: true, hasRequest: true },
  "settings:clearProvider": { domain: "settings", method: "clearProvider", sensitive: true, hasRequest: false },
  "settings:testProvider": { domain: "settings", method: "testProvider", sensitive: true, hasRequest: true },
  "settings:getRules": { domain: "settings", method: "getRules", sensitive: true, hasRequest: false },
  "settings:setRules": { domain: "settings", method: "setRules", sensitive: true, hasRequest: true },
  "settings:diagnostics": { domain: "settings", method: "diagnostics", sensitive: true, hasRequest: false },
  "settings:about": { domain: "settings", method: "about", sensitive: true, hasRequest: false },
  "browser:back": { domain: "browser", method: "back", sensitive: true, hasRequest: true },
  "browser:forward": { domain: "browser", method: "forward", sensitive: true, hasRequest: true },
  "browser:reload": { domain: "browser", method: "reload", sensitive: true, hasRequest: true },
  "browser:history": { domain: "browser", method: "history", sensitive: true, hasRequest: true },
  "browser:downloads": { domain: "browser", method: "downloads", sensitive: true, hasRequest: false },
  "browser:downloadAction": { domain: "browser", method: "downloadAction", sensitive: true, hasRequest: true },
  "settings:setApiKey": { domain: "settings", method: "setApiKey", sensitive: true, hasRequest: true },
  "settings:clearApiKey": { domain: "settings", method: "clearApiKey", sensitive: true, hasRequest: true },
  "settings:listProviders": { domain: "settings", method: "listProviders", sensitive: true, hasRequest: false },
  "settings:upsertProvider": { domain: "settings", method: "upsertProvider", sensitive: true, hasRequest: true },
  "settings:removeProvider": { domain: "settings", method: "removeProvider", sensitive: true, hasRequest: true },
  "settings:setActiveProvider": { domain: "settings", method: "setActiveProvider", sensitive: true, hasRequest: true },
  "chat:sessions": { domain: "chat", method: "sessions", sensitive: true, hasRequest: false },
  "chat:newSession": { domain: "chat", method: "newSession", sensitive: true, hasRequest: false },
  "chat:switchSession": { domain: "chat", method: "switchSession", sensitive: true, hasRequest: true },
  "chat:deleteSession": { domain: "chat", method: "deleteSession", sensitive: true, hasRequest: true },
  "workspace:list": { domain: "workspace", method: "list", sensitive: true, hasRequest: false },
  "workspace:create": { domain: "workspace", method: "create", sensitive: true, hasRequest: true },
  "workspace:select": { domain: "workspace", method: "select", sensitive: true, hasRequest: true },
  "workspace:remove": { domain: "workspace", method: "remove", sensitive: true, hasRequest: true },
  "workspace:status": { domain: "workspace", method: "status", sensitive: true, hasRequest: true },
  "worktree:create": { domain: "worktree", method: "create", sensitive: true, hasRequest: true },
  "worktree:remove": { domain: "worktree", method: "remove", sensitive: true, hasRequest: true },
  "worktree:diff": { domain: "worktree", method: "diff", sensitive: true, hasRequest: true },
  "worktree:merge": { domain: "worktree", method: "merge", sensitive: true, hasRequest: true },
  "extensions:list": { domain: "extensions", method: "list", sensitive: true, hasRequest: false },
  "extensions:setEnabled": { domain: "extensions", method: "setEnabled", sensitive: true, hasRequest: true },
  "extensions:remove": { domain: "extensions", method: "remove", sensitive: true, hasRequest: true },
  "extensions:start": { domain: "extensions", method: "start", sensitive: true, hasRequest: true },
  "extensions:stop": { domain: "extensions", method: "stop", sensitive: true, hasRequest: true },
  "extensions:openDir": { domain: "extensions", method: "openDir", sensitive: true, hasRequest: false },
  "skills:list": { domain: "skills", method: "list", sensitive: true, hasRequest: false },
  "skills:reload": { domain: "skills", method: "reload", sensitive: true, hasRequest: false },
  "skills:setEnabled": { domain: "skills", method: "setEnabled", sensitive: true, hasRequest: true },
  "skills:openDir": { domain: "skills", method: "openDir", sensitive: true, hasRequest: false },
  "mcp:list": { domain: "mcp", method: "list", sensitive: true, hasRequest: false },
  "mcp:add": { domain: "mcp", method: "add", sensitive: true, hasRequest: true },
  "mcp:remove": { domain: "mcp", method: "remove", sensitive: true, hasRequest: true },
  "mcp:connect": { domain: "mcp", method: "connect", sensitive: true, hasRequest: true },
  "mcp:disconnect": { domain: "mcp", method: "disconnect", sensitive: true, hasRequest: true },
  "terminal:profiles": { domain: "terminal", method: "profiles", sensitive: true, hasRequest: false },
  "terminal:list": { domain: "terminal", method: "list", sensitive: true, hasRequest: false },
  "terminal:open": { domain: "terminal", method: "open", sensitive: true, hasRequest: true },
  "terminal:input": { domain: "terminal", method: "input", sensitive: true, hasRequest: true },
  "terminal:run": { domain: "terminal", method: "run", sensitive: true, hasRequest: true },
  "terminal:interrupt": { domain: "terminal", method: "interrupt", sensitive: true, hasRequest: true },
  "terminal:close": { domain: "terminal", method: "close", sensitive: true, hasRequest: true },
  "ask:respond": { domain: "ask", method: "respond", sensitive: true, hasRequest: true },
  "plugin:list": { domain: "plugin", method: "list", sensitive: true, hasRequest: false },
  "plugin:setEnabled": { domain: "plugin", method: "setEnabled", sensitive: true, hasRequest: true },
  "plugin:reload": { domain: "plugin", method: "reload", sensitive: true, hasRequest: false },
  "gateway:status": { domain: "gateway", method: "status", sensitive: true, hasRequest: false },
  "gateway:start": { domain: "gateway", method: "start", sensitive: true, hasRequest: false },
  "gateway:stop": { domain: "gateway", method: "stop", sensitive: true, hasRequest: false },
  "chat:compact": { domain: "chat", method: "compact", sensitive: true, hasRequest: true },
  "loop:list": { domain: "loop", method: "list", sensitive: true, hasRequest: false },
  "loop:setActive": { domain: "loop", method: "setActive", sensitive: true, hasRequest: true },
  "loop:reload": { domain: "loop", method: "reload", sensitive: true, hasRequest: false },
  "bookmarks:list": { domain: "bookmarks", method: "list", sensitive: true, hasRequest: false },
  "bookmarks:add": { domain: "bookmarks", method: "add", sensitive: true, hasRequest: true },
  "bookmarks:remove": { domain: "bookmarks", method: "remove", sensitive: true, hasRequest: true },
  "browser:savePage": { domain: "browser", method: "savePage", sensitive: true, hasRequest: true },
  "terminal:history": { domain: "terminal", method: "history", sensitive: true, hasRequest: true },
} as const;

/**
 * IpcRequest 包装类型：通道名 + 载荷。
 */
export type IpcRequest<T> = {
  readonly channel: string;
  readonly payload: T;
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
    "chat": ["stream", "steer", "rollback", "saveTimeline", "stop", "send", "history", "sessions", "newSession", "switchSession", "deleteSession", "compact"],
    "fs": ["readImage", "saveImage"],
    "perm": ["respond"],
    "workspace": ["read", "write", "list", "create", "select", "remove", "status"],
    "agents": ["list"],
    "runtime": ["version", "status"],
    "browser": ["navigate", "screenshot", "snapshot", "newTab", "closeTab", "selectTab", "listTabs", "setOverlay", "setSidebarWidth", "back", "forward", "reload", "history", "downloads", "downloadAction", "savePage"],
    "settings": ["listModels", "getProvider", "setProvider", "getPreferences", "setPreferences", "getPermissions", "setPermissions", "clearProvider", "testProvider", "getRules", "setRules", "diagnostics", "about", "setApiKey", "clearApiKey", "listProviders", "upsertProvider", "removeProvider", "setActiveProvider"],
    "dialog": ["pickPath"],
    "memory": ["list", "add", "update", "delete", "stats", "clear"],
    "window": ["minimize", "maximize", "close", "state"],
    "worktree": ["create", "remove", "diff", "merge"],
    "extensions": ["list", "setEnabled", "remove", "start", "stop", "openDir"],
    "skills": ["list", "reload", "setEnabled", "openDir"],
    "mcp": ["list", "add", "remove", "connect", "disconnect"],
    "terminal": ["profiles", "list", "open", "input", "run", "interrupt", "close", "history"],
    "ask": ["respond"],
    "plugin": ["list", "setEnabled", "reload"],
    "gateway": ["status", "start", "stop"],
    "loop": ["list", "setActive", "reload"],
    "bookmarks": ["list", "add", "remove"]
    },
  };
}

/**
 * EVENT_NAMES：所有事件名列表。
 */
export const EVENT_NAMES = [
  "chat:stream:chunk",
  "chat:stream:reasoning",
  "chat:stream:tool",
  "chat:stream:tool_start",
  "chat:stream:progress",
  "chat:stream:done",
  "chat:stream:error",
  "chat:stream:heartbeat",
  "perm:request",
  "boot:ready",
  "browser:tabs",
  "browser:downloads",
  "memory:updated",
  "extensions:updated",
  "skills:updated",
  "mcp:updated",
  "terminal:data",
  "terminal:exit",
  "terminal:state",
  "ask:user",
  "loop:fallback",
  "loop:changed",
  "plugins:updated",
  "gateway:changed",
  "chat:compacted",
] as const;
