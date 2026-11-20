/**
 * Agent-Loop 阶段能力目录（L2 声明式 loop 的「可开关阶段」单一产地）。
 *
 * 为什么放在契约层：设置页需要展示阶段，壳层需要根据开关收紧工具面；
 * 两边如果各写一份，新增阶段/工具时会静默漂移。这里只描述「阶段 → 工具集合」，
 * 不引入 fs/Electron；运行时的白名单/拦截仍由 shell 的 applyDeclarativeLoop 做纵深防御。
 */
import { z } from "zod";

export const LOOP_STAGE_IDS = ["plan", "research", "browse", "interact", "workspace", "delegate"] as const;
export type LoopStageId = (typeof LOOP_STAGE_IDS)[number];

export interface LoopStageDefinition {
  id: LoopStageId;
  /** 中文展示名（设置页/系统提示共用）。 */
  name: string;
  /** 英文展示名（扩展/日志/未来 i18n 兜底）。 */
  nameEn: string;
  /** 面向用户的阶段说明。 */
  description: string;
  /** 该阶段涉及的工具名；关闭阶段 = 这些工具不可见且不可执行。 */
  tools: readonly string[];
  /** 开启阶段时注入的能力提示（简短、行为导向，不写死具体产品流程）。 */
  prompt: string;
}

export const LOOP_STAGE_CATALOG: readonly LoopStageDefinition[] = [
  {
    id: "plan",
    name: "规划与待办",
    nameEn: "Plan",
    description: "维护任务清单，把长任务拆成可检查的步骤。",
    tools: ["todo_write"],
    prompt: "先明确目标与验收标准；长任务用 todo_write 维护可见计划，完成一步就更新一步。",
  },
  {
    id: "research",
    name: "检索与取材",
    nameEn: "Research",
    description: "搜索网页、抓取正文，为结论建立可核验的来源。",
    tools: ["web_search", "web_fetch"],
    prompt: "不确定的事实先检索并读取原始来源；区分「页面声称」与「已核验事实」，不要凭记忆补全。",
  },
  {
    id: "browse",
    name: "浏览器浏览",
    nameEn: "Browse",
    description: "打开、切换、等待页面，读取页面快照与截图。",
    tools: [
      "browser_navigate",
      "browser_snapshot",
      "browser_tabs",
      "browser_back",
      "browser_forward",
      "browser_reload",
      "browser_wait",
      "browser_screenshot",
      "browser_downloads",
      "browser_cookies",
      "browser_diagnostics",
    ],
    prompt: "每次导航/切换后先读取 snapshot 确认页面状态；优先用可访问性快照定位元素，不要猜坐标。",
  },
  {
    id: "interact",
    name: "页面交互",
    nameEn: "Interact",
    description: "点击、输入、按键、滚动、悬停、拖拽与上传，真正操作网页。",
    tools: [
      "browser_click",
      "browser_type",
      "browser_press_key",
      "browser_select",
      "browser_hover",
      "browser_scroll",
      "browser_drag",
      "browser_dismiss_popup",
      "browser_upload",
    ],
    prompt: "只在必要时操作页面；每次交互后重新快照确认结果，敏感动作（登录/支付/不可撤销）先向用户确认。",
  },
  {
    id: "workspace",
    name: "文件与执行",
    nameEn: "Workspace",
    description: "读写工作区文件、运行命令、读取文档与回滚检查点。",
    tools: [
      "file_read",
      "file_write",
      "terminal_run",
      "pdf_read",
      "docx_read",
      "xlsx_read",
      "office_read",
      "checkpoint_list",
      "checkpoint_restore",
    ],
    prompt: "写入前先读现状；命令与文件操作限定在工作区内，产物路径要可回查。",
  },
  {
    id: "delegate",
    name: "协作与记忆",
    nameEn: "Delegate",
    description: "委派子任务、读取技能与记忆、沉淀可复用的经验。",
    tools: [
      "subagent_read",
      "subagent_tasks",
      "subagent_resume",
      "delegate_work",
      "delegate_research",
      "delegate_parallel",
      "delegate_tree",
      "delegate_child",
      "skill_list",
      "skill_read",
      "skill_import",
      "skill_candidate",
      "memory_search",
      "memory_add",
      "memory_update",
      "memory_delete",
      "trace_read",
      "trace_summary",
    ],
    prompt: "独立且可并行的子任务才委派；需要复用的事实/流程按现有技能与记忆能力读取或沉淀。",
  },
];

/** 自定义阶段 id：与 loop id 同形，允许用户完全自建阶段。 */
export const LOOP_STAGE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** 阶段开关/自定义阶段的持久化结构（内置 id 或任意合法自定义 id）。 */
export const LoopStageConfigSchema = z.object({
  /** 内置阶段用 LOOP_STAGE_IDS；自定义阶段允许任意合法 id。 */
  id: z.string().regex(LOOP_STAGE_ID_RE, "阶段 id 仅允许小写字母/数字/连字符，1~64 字符"),
  enabled: z.boolean(),
  /** 完全自定义阶段的展示名（内置阶段忽略，以目录为准）。 */
  name: z.string().trim().min(1).max(80).optional(),
  /** 完全自定义阶段的工具集合；省略 = 该阶段不限制具体工具。 */
  tools: z.array(z.string().min(1).max(120)).max(200).optional(),
  /** 完全自定义阶段注入的能力说明；省略 = 不注入额外提示。 */
  prompt: z.string().max(4000).optional(),
});

export type LoopStageConfig = z.infer<typeof LoopStageConfigSchema>;

export const LoopStagesSchema = z
  .array(LoopStageConfigSchema)
  .max(32)
  .superRefine((stages, ctx) => {
    const seen = new Set<string>();
    for (const stage of stages) {
      if (seen.has(stage.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `阶段 ${stage.id} 重复` });
      }
      seen.add(stage.id);
    }
  });

/** 所有阶段涉及的浏览器工具（给测试/审计做覆盖校验用）。 */
export const LOOP_STAGE_TOOL_NAMES: readonly string[] = [...new Set(LOOP_STAGE_CATALOG.flatMap((stage) => stage.tools))];
