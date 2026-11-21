/**
 * 定时任务（自动巡航）契约：输入校验 + 持久化形状。
 *
 * 时间语义刻意保持「本机本地时间」：用户写 09:00 就是本机 09:00，
 * 不引入 UTC/时区字段，避免 DST 切换后任务漂移到用户不认识的时刻。
 * 调度器负责把下一次触发时间提前算好并落盘，UI 只展示，不自行猜测。
 */
import { z } from "zod";

export const SCHEDULE_FREQUENCIES = ["once", "daily", "weekdays", "weekly"] as const;
export type ScheduleFrequency = (typeof SCHEDULE_FREQUENCIES)[number];

/** 任务 id 与 loop id 同一套约束：小写字母/数字/连字符，便于落盘与引用。 */
export const SCHEDULE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const ScheduleIdSchema = z.object({
  id: z.string().regex(SCHEDULE_ID_RE, "任务 id 必须是小写字母/数字/连字符"),
});
export const ScheduleDeleteSchema = ScheduleIdSchema;
export const ScheduleRunRequestSchema = ScheduleIdSchema;

const TimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "时间必须是 HH:mm");
const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期必须是 YYYY-MM-DD");

/**
 * 用户可编辑字段。`enabled` 允许缺省（默认 true），其余运行态字段由壳层维护，
 * 防止渲染层伪造 lastRunAt / nextRunAt / 运行历史。
 */
export const ScheduleInputSchema = z
  .object({
    id: z.string().regex(SCHEDULE_ID_RE).optional(),
    title: z.string().trim().min(1, "任务名称不能为空").max(80),
    prompt: z.string().trim().min(1, "任务内容不能为空").max(8000),
    frequency: z.enum(SCHEDULE_FREQUENCIES),
    time: TimeSchema,
    /** once 必填；其余频率忽略。 */
    date: DateSchema.optional(),
    /** weekly 使用；1=周一 … 7=周日（ISO 顺序，避免 JS 的 0=周日歧义）。 */
    weekdays: z.array(z.number().int().min(1).max(7)).max(7).optional(),
    enabled: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.frequency === "once" && !value.date) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["date"], message: "单次任务必须选择日期" });
    }
    if (value.frequency === "weekly" && (!value.weekdays || value.weekdays.length === 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["weekdays"], message: "每周任务至少选择一天" });
    }
    if (value.weekdays && new Set(value.weekdays).size !== value.weekdays.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["weekdays"], message: "星期不能重复" });
    }
  });

export type ScheduleInput = z.infer<typeof ScheduleInputSchema>;

/** 壳层落盘/返回给 UI 的完整任务（运行态字段只读）。 */
export const ScheduledTaskSchema = ScheduleInputSchema.and(
  z.object({
    id: z.string().regex(SCHEDULE_ID_RE),
    enabled: z.boolean(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    lastRunAt: z.number().int().nonnegative().nullable().optional(),
    nextRunAt: z.number().int().nonnegative().nullable().optional(),
    lastStatus: z.enum(["ok", "error", "running", "missed"]).optional(),
    lastSummary: z.string().max(600).optional(),
    lastSessionId: z.string().max(160).optional(),
    runCount: z.number().int().nonnegative().optional(),
  }),
);
export type ScheduledTask = z.infer<typeof ScheduledTaskSchema>;

export const ScheduleRunStatusSchema = z.enum(["running", "ok", "error", "missed"]);
export type ScheduleRunStatus = z.infer<typeof ScheduleRunStatusSchema>;

export const ScheduleRunSchema = z.object({
  id: z.string().max(80),
  taskId: z.string().max(64),
  taskTitle: z.string().max(80),
  startedAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative().optional(),
  status: ScheduleRunStatusSchema,
  sessionId: z.string().max(160).optional(),
  summary: z.string().max(600).optional(),
  error: z.string().max(600).optional(),
  trigger: z.enum(["schedule", "manual", "catchup"]),
});
export type ScheduleRun = z.infer<typeof ScheduleRunSchema>;

export const ScheduleSaveResultSchema = z.object({ ok: z.boolean(), task: ScheduledTaskSchema.optional(), error: z.string().optional() });
export type ScheduleSaveResult = z.infer<typeof ScheduleSaveResultSchema>;

export const ScheduleListResultSchema = z.object({
  tasks: z.array(ScheduledTaskSchema),
  runs: z.array(ScheduleRunSchema),
  timezoneOffsetMinutes: z.number().int(),
});
export type ScheduleListResult = z.infer<typeof ScheduleListResultSchema>;

export const ScheduleRunResultSchema = z.object({
  accepted: z.boolean(),
  runId: z.string().optional(),
  sessionId: z.string().optional(),
  error: z.string().optional(),
});
export type ScheduleRunResult = z.infer<typeof ScheduleRunResultSchema>;
