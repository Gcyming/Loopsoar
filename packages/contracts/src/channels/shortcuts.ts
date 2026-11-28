import { z } from "zod";
import { ShortcutAddSchema, ShortcutPinSchema, ShortcutRemoveSchema, ShortcutUpdateSchema } from "../validators.js";
import type { ChannelBinding } from "../validators.js";

/** 通道 shortcuts 域：新标签页快捷方式（用户主动添加、可编辑）。 */
export const shortcutsChannels: Record<string, ChannelBinding> = {
  "shortcuts:list": {
    domain: "shortcuts",
    method: "list",
    request: null,
    sensitive: true,
  },
  "shortcuts:add": {
    domain: "shortcuts",
    method: "add",
    request: ShortcutAddSchema,
    sensitive: true,
  },
  "shortcuts:update": {
    domain: "shortcuts",
    method: "update",
    request: ShortcutUpdateSchema,
    sensitive: true,
  },
  "shortcuts:remove": {
    domain: "shortcuts",
    method: "remove",
    request: ShortcutRemoveSchema,
    sensitive: true,
  },
  "shortcuts:pin": {
    domain: "shortcuts",
    method: "pin",
    request: ShortcutPinSchema,
    sensitive: true,
  },
};
