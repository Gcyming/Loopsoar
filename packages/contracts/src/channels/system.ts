import { z } from "zod";
import { AskRespondSchema, ChromePopoverActionSchema, LoopSetActiveSchema, MoveAgentWindowSchema, OpenAgentWindowSchema, OpenChromePopoverSchema, TerminalCloseSchema, TerminalHistorySchema, TerminalInputSchema, TerminalInterruptSchema, TerminalOpenSchema, TerminalRunSchema } from "../validators.js";
import type { ChannelBinding } from "../validators.js";

/** 通道 system 域：按域拆分，键顺序由 ../channels/index.ts 统一恢复。 */
export const systemChannels: Record<string, ChannelBinding> = {
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
  "ui:toast": {
    domain: "ui",
    method: "toast",
    request: z.object({ text: z.string().min(1).max(300), sticky: z.boolean().optional() }),
    sensitive: true,
  },
  "terminal:profiles": {
    domain: "terminal",
    method: "profiles",
    request: null,
    sensitive: true,
  },
  "terminal:list": {
    domain: "terminal",
    method: "list",
    request: null,
    sensitive: true,
  },
  "terminal:open": {
    domain: "terminal",
    method: "open",
    request: TerminalOpenSchema,
    sensitive: true,
  },
  "terminal:input": {
    domain: "terminal",
    method: "input",
    request: TerminalInputSchema,
    sensitive: true,
  },
  "terminal:run": {
    domain: "terminal",
    method: "run",
    request: TerminalRunSchema,
    sensitive: true,
  },
  "terminal:interrupt": {
    domain: "terminal",
    method: "interrupt",
    request: TerminalInterruptSchema,
    sensitive: true,
  },
  "terminal:close": {
    domain: "terminal",
    method: "close",
    request: TerminalCloseSchema,
    sensitive: true,
  },
  "ask:respond": {
    domain: "ask",
    method: "respond",
    request: AskRespondSchema,
    sensitive: true,
  },
  "ui:openPopover": {
    domain: "ui",
    method: "openPopover",
    request: OpenChromePopoverSchema,
    sensitive: true,
  },
  "ui:togglePopover": {
    domain: "ui",
    method: "togglePopover",
    request: OpenChromePopoverSchema,
    sensitive: true,
  },
  "ui:closePopover": {
    domain: "ui",
    method: "closePopover",
    request: null,
    sensitive: true,
  },
  "ui:popoverAction": {
    domain: "ui",
    method: "popoverAction",
    request: ChromePopoverActionSchema,
    sensitive: true,
  },
  "ui:openAgentWindow": {
    domain: "ui",
    method: "openAgentWindow",
    request: OpenAgentWindowSchema,
    sensitive: true,
  },
  "ui:closeAgentWindow": {
    domain: "ui",
    method: "closeAgentWindow",
    request: null,
    sensitive: true,
  },
  "ui:minimizeAgentWindow": {
    domain: "ui",
    method: "minimizeAgentWindow",
    request: null,
    sensitive: true,
  },
  "ui:dragAgentWindow": {
    domain: "ui",
    method: "dragAgentWindow",
    request: MoveAgentWindowSchema,
    sensitive: true,
  },
  "ui:restoreAgentWindow": {
    domain: "ui",
    method: "restoreAgentWindow",
    request: null,
    sensitive: true,
  },
  "ui:moveAgentWindow": {
    domain: "ui",
    method: "moveAgentWindow",
    request: MoveAgentWindowSchema,
    sensitive: true,
  },
  "loop:list": {
    domain: "loop",
    method: "list",
    request: null,
    sensitive: true,
  },
  "loop:setActive": {
    domain: "loop",
    method: "setActive",
    request: LoopSetActiveSchema,
    sensitive: true,
  },
  "loop:reload": {
    domain: "loop",
    method: "reload",
    request: null,
    sensitive: true,
  },
  "terminal:history": {
    domain: "terminal",
    method: "history",
    request: TerminalHistorySchema,
    sensitive: true,
  },
  "terminal:diagnose": {
    domain: "terminal",
    method: "diagnose",
    request: null,
    sensitive: true,
  },
};
