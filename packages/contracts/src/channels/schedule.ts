/**
 * 定时任务 IPC 域：任务 CRUD + 手动运行。
 *
 * 定时任务会启动真正的 Agent 回合（可调用工具），因此全部按敏感通道处理：
 * preload 白名单 + 受信帧校验 + 审计，与其他高风险能力保持同一门槛。
 */
import { ScheduleDeleteSchema, ScheduleInputSchema, ScheduleRunRequestSchema } from "../scheduledTasks.js";
import type { ChannelBinding } from "../validators.js";

export const scheduleChannels: Record<string, ChannelBinding> = {
  "schedule:list": {
    domain: "schedule",
    method: "list",
    request: null,
    sensitive: true,
  },
  "schedule:save": {
    domain: "schedule",
    method: "save",
    request: ScheduleInputSchema,
    sensitive: true,
  },
  "schedule:delete": {
    domain: "schedule",
    method: "delete",
    request: ScheduleDeleteSchema,
    sensitive: true,
  },
  "schedule:run": {
    domain: "schedule",
    method: "run",
    request: ScheduleRunRequestSchema,
    sensitive: true,
  },
};
