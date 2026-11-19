import { z } from "zod";
import { BindSessionWorkspaceSchema, ReadImageSchema, SaveImageSchema, WorkspaceCreateSchema, WorkspaceIdSchema, WorkspaceStatusSchema, WorktreeMergeSchema, WorktreeRemoveSchema, WorktreeSessionSchema } from "../validators.js";
import type { ChannelBinding } from "../validators.js";

/** 通道 workspace 域：按域拆分，键顺序由 ../channels/index.ts 统一恢复。 */
export const workspaceChannels: Record<string, ChannelBinding> = {
  "fs:readImage": {
    domain: "fs",
    method: "readImage",
    request: ReadImageSchema,
    sensitive: true,
  },
  "fs:saveImage": {
    domain: "fs",
    method: "saveImage",
    request: SaveImageSchema,
    sensitive: true,
  },
  "agents:list": {
    domain: "agents",
    method: "list",
    request: null,
    sensitive: true,
  },
  "workspace:list": {
    domain: "workspace",
    method: "list",
    request: null,
    sensitive: true,
  },
  "workspace:create": {
    domain: "workspace",
    method: "create",
    request: WorkspaceCreateSchema,
    sensitive: true,
  },
  "workspace:bindSession": {
    domain: "workspace",
    method: "bindSession",
    request: BindSessionWorkspaceSchema,
    sensitive: true,
  },
  "workspace:select": {
    domain: "workspace",
    method: "select",
    request: WorkspaceIdSchema,
    sensitive: true,
  },
  "workspace:rename": {
    domain: "workspace",
    method: "rename",
    request: z.object({ id: z.string().min(1).max(128), name: z.string().min(1).max(64) }),
    sensitive: true,
  },
  "workspace:openFolder": {
    domain: "workspace",
    method: "openFolder",
    request: z.object({ id: z.string().min(1).max(128) }),
    sensitive: true,
  },
  "workspace:remove": {
    domain: "workspace",
    method: "remove",
    request: WorkspaceIdSchema,
    sensitive: true,
  },
  "workspace:status": {
    domain: "workspace",
    method: "status",
    request: WorkspaceStatusSchema,
    sensitive: true,
  },
  "worktree:create": {
    domain: "worktree",
    method: "create",
    request: WorktreeSessionSchema,
    sensitive: true,
  },
  "worktree:remove": {
    domain: "worktree",
    method: "remove",
    request: WorktreeRemoveSchema,
    sensitive: true,
  },
  "worktree:diff": {
    domain: "worktree",
    method: "diff",
    request: WorktreeSessionSchema,
    sensitive: true,
  },
  "worktree:merge": {
    domain: "worktree",
    method: "merge",
    request: WorktreeMergeSchema,
    sensitive: true,
  },
};
