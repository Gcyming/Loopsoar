/**
 * ask_user 工具（Agent 的「问人」通道）。
 *
 * 语义：任务缺少关键信息（偏好、目标路径、二选一方案）时，暂停等用户回答；
 * 超时/取消按取消结算而非伪造回答 —— fail-closed，避免 Agent 替用户编答案。
 * 工具本身不做权限确认：弹窗即交互，用户必须回答、跳过或取消。
 *
 * 选项设计对标 slime 的「决策分叉窗口」，并吸收三点实证结论：
 *   ① 目标/约束类澄清只在执行前期有价值（Ask Early, Ask Late, Ask Right, 2026：
 *      目标澄清在轨迹 10% 后价值几乎归零；执行过半再问，效果比不问还差）；
 *   ② 问题要能降低不确定性（CIGAsk, EMNLP 2026 Findings：模糊提问无法回收信息，
 *      等于白问）—— 所以选项必须带「选择后果」，推荐项必须有把握才标；
 *   ③ 提问成本由用户承担（Claude Code / Letta / Codex 的 ask-user 工具一致约束）：
 *      能查到的不要问，能用默认值推进的不要问。
 */
import { z } from "zod";
import type { ToolRegistry, ToolResult } from "loopsoar-core/tools/registry";
import { normalizeAskOptions, type AskBus, type AskUserOptionInput } from "./askBus.js";

export const ASK_USER_TOOL_NAME = "ask_user";

/** 等待用户回答的时间上限（工具循环对 ask_user 使用独立的静默超时）。 */
export const ASK_USER_TIMEOUT_MS = 600_000;

/** 换行符常量：避免源码里出现转义序列。 */
const NL = String.fromCharCode(10);

const OptionSchema = z.union([
  z.string().min(1).max(200),
  z.object({
    label: z.string().min(1).max(200),
    description: z.string().max(300).optional(),
    value: z.string().max(200).optional(),
  }),
]);

const DESCRIPTION = [
  "向用户提一个必须由人拍板的问题，并暂停等待回答（决策分叉）。",
  "",
  "什么时候用（三条同时满足）：",
  "1) 方向真的分叉：不同选择会产出不同结果，且无法从代码库/网页/历史里查证；",
  "2) 现在问比做错再返工更省时间；",
  "3) 你无法用一个合理默认值继续推进（能假设就先假设，并在回复里说明假设）。",
  "",
  "什么时候不要用：",
  "- 能自己查到的（先查再问）；",
  "- 只是确认「要不要继续」——不要用提问代替做事；",
  "- 目标/约束类问题在执行过半后才想到：实证研究显示目标澄清在执行 10% 后价值几乎归零、",
  "  中途再问反而比不问更差。目标/约束必须在动手前问；执行中只问数据/输入缺口。",
  "",
  "参数质量（直接决定回答质量）：",
  "- question：一句话说清正在权衡什么（例如「部署走 Docker 还是裸机」），不要问「你有什么想法」。",
  "- header：2-6 字分类徽章（部署方案 / 架构取舍 / 提交策略）。",
  "- options：2-6 个具体可执行的方向，禁止「是/否/随便」这类态度；",
  "  每项写 label（动作）+ description（选择它的代价/后果，一句话）——用户靠它评估，不靠猜。",
  "  确实只需要一段信息（路径/端口/密钥）时可以**不传 options**，直接纯文本提问。",
  "- recommendation：有明确更优项才填下标（0 起）；没把握不要填。推荐项会标注「推荐」。",
  "- multiSelect：只有多个方向可以同时成立时才 true。",
  "",
  "返回：用户的选择（含选项后果）、自填补充，或「跳过」「取消」。不要替用户编答案。",
].join(NL);

export function registerAskTools(registry: ToolRegistry, askBus: AskBus): void {
  registry.register({
    name: ASK_USER_TOOL_NAME,
    description: DESCRIPTION,
    permissions: { read: true },
    schema: z.object({
      question: z.string().min(1).max(2000),
      header: z.string().max(24).optional(),
      // 不强制 2 个：确实只需要一段信息（路径/端口/密钥）时可以纯文本提问；
      // 但只有 1 个选项的「伪选择」在 execute 里拒绝（那是确认框，不是决策分叉）。
      options: z.array(OptionSchema).max(6).optional(),
      multiSelect: z.boolean().optional(),
      recommendation: z.union([z.number().int().min(0).max(5), z.string().max(200)]).optional(),
      allowFreeText: z.boolean().optional(),
    }),
    execute: async (ctx): Promise<ToolResult> => {
      const params = (ctx.params ?? {}) as {
        question?: string;
        header?: string;
        options?: Array<string | AskUserOptionInput>;
        multiSelect?: boolean;
        recommendation?: number | string;
        allowFreeText?: boolean;
      };
      const question = (params.question ?? "").trim();
      if (!question) return { ok: false, content: "[错误] 缺少 question 参数" };
      // 归一化在工具层先做一次：结果回填要用到 label/description（总线内部会再归一，幂等）。
      const normalized = normalizeAskOptions(params.options, params.recommendation);
      const options = normalized.options;
      // 0 个选项 = 纯信息型提问（要用户给路径/端口等），合法；
      // 1 个选项 = 伪装成选择的是非题，拒绝（用户没有真正的决策空间）。
      if (options.length === 1) {
        return {
          ok: false,
          content:
            "[错误] 只给了 1 个选项：这不是选择。要么给 2~6 个具体方向，" +
            "要么不传 options、直接问你要的那段信息；只是想确认「要不要继续」就说明并继续，不要用 ask_user 代替做事。",
        };
      }
      try {
        const answer = await askBus.request({
          question,
          options,
          // 归一化已经把推荐项标进 option.recommended；再显式传下标，避免二次归一丢失标记。
          ...(normalized.recommendedIndex !== undefined ? { recommendation: normalized.recommendedIndex } : {}),
          ...(params.header ? { header: params.header } : {}),
          ...(params.multiSelect ? { multiSelect: true } : {}),
          ...(typeof params.allowFreeText === "boolean" ? { allowFreeText: params.allowFreeText } : {}),
          timeoutMs: ASK_USER_TIMEOUT_MS,
          // 会话归属：后台会话的提问只在对应会话里弹窗（不抢用户当前会话的界面）。
          sessionId: ctx.sessionId,
          kind: "ask",
        });

        if (answer.skipped) {
          return {
            ok: true,
            content:
              "用户跳过了回答（没有做选择）。请按上下文自行判断继续推进，并在最终回复里说明你采用的假设；" +
              "不要声称这是用户的选择。",
          };
        }
        if (answer.cancelled) {
          return {
            ok: false,
            content:
              "用户取消了回答" + (answer.answer ? "：" + answer.answer : "") +
              "。不要编造用户的答案；可换一种方式询问，或回到已知信息继续。",
          };
        }

        const picked = answer.choices && answer.choices.length > 0
          ? answer.choices
          : answer.choice
            ? [answer.choice]
            : [];
        const joined = picked.join("、");
        const described = picked.map((label) => {
          const option = options.find((item) => item.label === label);
          return option?.description ? label + "（" + option.description + "）" : label;
        });
        const custom = answer.custom && answer.custom !== joined ? answer.custom : "";
        if (described.length === 0) {
          return { ok: true, content: "用户回答：" + (answer.answer ?? "") };
        }
        return {
          ok: true,
          content:
            "用户选择：" + described.join("；") +
            (custom ? "；补充说明：" + custom : "") +
            "。请按此方向继续，不要再重复提问同一件事。",
        };
      } catch (err) {
        return {
          ok: false,
          content: "[错误] ask_user 执行失败：" + (err instanceof Error ? err.message : String(err)),
        };
      }
    },
  });
}
