import { ExtensionIdSchema, ExtensionToggleSchema, McpServerIdSchema, McpServerSchema, SkillIdSchema, SkillToggleSchema } from "../validators.js";
import type { ChannelBinding } from "../validators.js";

/** 通道 extensions 域：按域拆分，键顺序由 ../channels/index.ts 统一恢复。 */
export const extensionsChannels: Record<string, ChannelBinding> = {
  "extensions:list": {
    domain: "extensions",
    method: "list",
    request: null,
    sensitive: true,
  },
  "extensions:setEnabled": {
    domain: "extensions",
    method: "setEnabled",
    request: ExtensionToggleSchema,
    sensitive: true,
  },
  "extensions:remove": {
    domain: "extensions",
    method: "remove",
    request: ExtensionIdSchema,
    sensitive: true,
  },
  "extensions:start": {
    domain: "extensions",
    method: "start",
    request: ExtensionIdSchema,
    sensitive: true,
  },
  "extensions:stop": {
    domain: "extensions",
    method: "stop",
    request: ExtensionIdSchema,
    sensitive: true,
  },
  "extensions:openDir": {
    domain: "extensions",
    method: "openDir",
    request: null,
    sensitive: true,
  },
  "skills:list": {
    domain: "skills",
    method: "list",
    request: null,
    sensitive: true,
  },
  "skills:reload": {
    domain: "skills",
    method: "reload",
    request: null,
    sensitive: true,
  },
  "skills:setEnabled": {
    domain: "skills",
    method: "setEnabled",
    request: SkillToggleSchema,
    sensitive: true,
  },
  "skills:remove": {
    domain: "skills",
    method: "remove",
    request: SkillIdSchema,
    sensitive: true,
  },
  "skills:openDir": {
    domain: "skills",
    method: "openDir",
    request: null,
    sensitive: true,
  },
  "mcp:list": {
    domain: "mcp",
    method: "list",
    request: null,
    sensitive: true,
  },
  "mcp:add": {
    domain: "mcp",
    method: "add",
    request: McpServerSchema,
    sensitive: true,
  },
  "mcp:remove": {
    domain: "mcp",
    method: "remove",
    request: McpServerIdSchema,
    sensitive: true,
  },
  "mcp:connect": {
    domain: "mcp",
    method: "connect",
    request: McpServerIdSchema,
    sensitive: true,
  },
  "mcp:disconnect": {
    domain: "mcp",
    method: "disconnect",
    request: McpServerIdSchema,
    sensitive: true,
  },
};
