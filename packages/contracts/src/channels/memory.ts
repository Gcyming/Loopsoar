import { z } from "zod";
import { MemoryAddSchema, MemoryDeleteSchema, MemoryGraphSchema, MemoryMergeSchema, MemoryReviewSchema, MemoryUpdateSchema } from "../validators.js";
import type { ChannelBinding } from "../validators.js";

/** 通道 memory 域：按域拆分，键顺序由 ../channels/index.ts 统一恢复。 */
export const memoryChannels: Record<string, ChannelBinding> = {
  "memory:list": {
    domain: "memory",
    method: "list",
    request: null,
    sensitive: true,
  },
  "memory:add": {
    domain: "memory",
    method: "add",
    request: MemoryAddSchema,
    sensitive: true,
  },
  "memory:update": {
    domain: "memory",
    method: "update",
    request: MemoryUpdateSchema,
    sensitive: true,
  },
  "memory:delete": {
    domain: "memory",
    method: "delete",
    request: MemoryDeleteSchema,
    sensitive: true,
  },
  "memory:graph": {
    domain: "memory",
    method: "graph",
    request: MemoryGraphSchema,
    sensitive: true,
  },
  "memory:stats": {
    domain: "memory",
    method: "stats",
    request: null,
    sensitive: true,
  },
  "memory:clear": {
    domain: "memory",
    method: "clear",
    request: null,
    sensitive: true,
  },
  "memory:consolidate": {
    domain: "memory",
    method: "consolidate",
    request: null,
    sensitive: true,
  },
  "memory:review": {
    domain: "memory",
    method: "review",
    request: MemoryReviewSchema,
    sensitive: true,
  },
  "memory:merge": {
    domain: "memory",
    method: "merge",
    request: MemoryMergeSchema,
    sensitive: true,
  },
  "memory:export": {
    domain: "memory",
    method: "export",
    request: null,
    sensitive: true,
  },
  "rules:candidates": {
    domain: "rules",
    method: "candidates",
    request: z.object({ workspaceId: z.string().min(1).max(80).optional() }).optional(),
    sensitive: true,
  },
  "rules:reviewSession": {
    domain: "rules",
    method: "reviewSession",
    request: z.object({ sessionId: z.string().min(1).max(120).optional() }).optional(),
    sensitive: true,
  },
  "rules:history": {
    domain: "rules",
    method: "history",
    request: z.object({ limit: z.number().int().min(1).max(100).optional() }).optional(),
    sensitive: true,
  },
  "rules:rollback": {
    domain: "rules",
    method: "rollback",
    request: z.object({ id: z.string().min(1).max(80) }),
    sensitive: true,
  },
  "rules:learnFromSession": {
    domain: "rules",
    method: "learnFromSession",
    request: z.object({ sessionId: z.string().min(1).max(120).optional() }).optional(),
    sensitive: true,
  },
  "rules:acceptCandidate": {
    domain: "rules",
    method: "acceptCandidate",
    request: z.object({
      id: z.string().min(1).max(80),
      target: z.enum(["workspace", "global"]).optional(),
      text: z.string().trim().min(4).max(240).optional(),
    }),
    sensitive: true,
  },
  "rules:dismissCandidate": {
    domain: "rules",
    method: "dismissCandidate",
    request: z.object({ id: z.string().min(1).max(80) }),
    sensitive: true,
  },
};
