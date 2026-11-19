import { z } from "zod";
import { ApiKeySchema, PermissionsSchema, PickPathSchema, PreferencesSchema, ProviderItemIdSchema, ProviderItemSchema, ProviderRefSchema, RulesPayloadSchema, SettingsListModelsSchema, SettingsProviderSchema } from "../validators.js";
import type { ChannelBinding } from "../validators.js";

/** 通道 settings 域：按域拆分，键顺序由 ../channels/index.ts 统一恢复。 */
export const settingsChannels: Record<string, ChannelBinding> = {
  "settings:listModels": {
    domain: "settings",
    method: "listModels",
    request: SettingsListModelsSchema,
    sensitive: true,
  },
  "dialog:pickPath": {
    domain: "dialog",
    method: "pickPath",
    request: PickPathSchema,
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
  "window:minimize": {
    domain: "window",
    method: "minimize",
    request: null,
    sensitive: true,
  },
  "window:maximize": {
    domain: "window",
    method: "maximize",
    request: null,
    sensitive: true,
  },
  "window:close": {
    domain: "window",
    method: "close",
    request: null,
    sensitive: true,
  },
  "window:state": {
    domain: "window",
    method: "state",
    request: null,
    sensitive: true,
  },
  "settings:getPreferences": {
    domain: "settings",
    method: "getPreferences",
    request: null,
    sensitive: true,
  },
  "settings:setPreferences": {
    domain: "settings",
    method: "setPreferences",
    request: PreferencesSchema,
    sensitive: true,
  },
  "settings:getPermissions": {
    domain: "settings",
    method: "getPermissions",
    request: null,
    sensitive: true,
  },
  "settings:setPermissions": {
    domain: "settings",
    method: "setPermissions",
    request: PermissionsSchema,
    sensitive: true,
  },
  "settings:clearProvider": {
    domain: "settings",
    method: "clearProvider",
    request: null,
    sensitive: true,
  },
  "settings:testProvider": {
    domain: "settings",
    method: "testProvider",
    request: SettingsProviderSchema,
    sensitive: true,
  },
  "settings:getRules": {
    domain: "settings",
    method: "getRules",
    request: null,
    sensitive: true,
  },
  "settings:setRules": {
    domain: "settings",
    method: "setRules",
    request: RulesPayloadSchema,
    sensitive: true,
  },
  "settings:getWorkspaceRule": {
    domain: "settings",
    method: "getWorkspaceRule",
    request: z.object({ workspaceId: z.string().min(1).max(80) }),
    sensitive: true,
  },
  "settings:diagnostics": {
    domain: "settings",
    method: "diagnostics",
    request: null,
    sensitive: true,
  },
  "settings:about": {
    domain: "settings",
    method: "about",
    request: null,
    sensitive: true,
  },
  "settings:setApiKey": {
    domain: "settings",
    method: "setApiKey",
    request: ApiKeySchema,
    sensitive: true,
  },
  "settings:clearApiKey": {
    domain: "settings",
    method: "clearApiKey",
    request: ProviderRefSchema,
    sensitive: true,
  },
  "settings:listProviders": {
    domain: "settings",
    method: "listProviders",
    request: null,
    sensitive: true,
  },
  "settings:upsertProvider": {
    domain: "settings",
    method: "upsertProvider",
    request: ProviderItemSchema,
    sensitive: true,
  },
  "settings:removeProvider": {
    domain: "settings",
    method: "removeProvider",
    request: ProviderItemIdSchema,
    sensitive: true,
  },
  "settings:setActiveProvider": {
    domain: "settings",
    method: "setActiveProvider",
    request: ProviderItemIdSchema,
    sensitive: true,
  },
};
