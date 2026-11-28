/**
 * ask_user（选项提问）相关类型。
 *
 * 为什么从 types.d.ts 拆出来：那个声明文件已经顶到架构守卫的 1400 行预算，
 * 继续堆「决策分叉」的选项/回答结构会把它推过红线；类型独立成模块后再由 types.d.ts 转发。
 */

/** 一个结构化选项：label 是动作，description 是选择它的后果/代价。 */
export interface AskUserOption {
  label: string;
  description?: string;
  /** 回传给模型的稳定值（缺省 = label）。 */
  value?: string;
  /** 模型推荐项（最多一个；UI 显示「推荐」）。 */
  recommended?: boolean;
}

/** 渲染层回填的答复：单选 choice / 多选 choices / 自填 answer / 跳过 skipped。 */
export interface AskUserReply {
  answer?: string;
  choice?: string;
  choices?: string[];
  skipped?: boolean;
}

/** 渲染层答复 → ask:respond 负载：只带真正给出的字段（取消由调用方传 null 处理）。 */
export function toAskRespondPayload(
  requestId: string,
  reply: AskUserReply,
): { requestId: string; answer?: string; choice?: string; choices?: string[]; skipped?: boolean } {
  return {
    requestId,
    ...(reply.answer ? { answer: reply.answer } : {}),
    ...(reply.choice ? { choice: reply.choice } : {}),
    ...(reply.choices && reply.choices.length > 0 ? { choices: reply.choices } : {}),
    ...(reply.skipped === true ? { skipped: true } : {}),
  };
}

/** ask:user 事件负载（工具挂起等人回答；渲染层弹窗）。 */
export interface AskUserRequest {
  requestId: string;
  question: string;
  /** 决策分类徽章（如「部署方案」）。 */
  header?: string;
  /** 可选项（最多 8 个；点选即回答；兼容旧壳层的 string[]）。 */
  options?: AskUserOption[] | string[];
  /** 多选：多个方向可同时成立（需要用户点「确认选择」）。 */
  multiSelect?: boolean;
  /** 是否允许自由文本（缺省语义：允许；永远保留「其他」出口）。 */
  allowFreeText?: boolean;
  /** 归属会话：缺失表示「当前会话」（兼容旧壳层）；有值时只在对应会话里弹窗。 */
  sessionId?: string;
  /** 语义：普通提问 / 敏感步骤确认（决定弹窗的视觉与按钮文案）。 */
  kind?: "ask" | "sensitive";
  /** 敏感确认的标题。 */
  title?: string;
  /** 敏感确认的上下文行（操作 / 目标 / 原因 / 页面）。 */
  detail?: { label: string; value: string }[];
  /** 到期时刻（ms）：用于倒计时与到期自动收起。 */
  expiresAt?: number;
}
