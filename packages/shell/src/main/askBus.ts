/**
 * 询问用户（ask_user 工具）请求总线（壳层）。
 *
 * 为什么需要挂起式总线：ask_user 的语义就是「等一个真人回答」，工具执行必须挂起；
 * 与权限确认（PermRequestBus）同构：超时按取消结算（fail-closed），渲染层弹窗经
 * `ask:respond` 通道回填。工具只依赖本总线，不直接碰 electron/IPC。
 *
 * 选项模型（对标 slime 的「决策分叉窗口」）：
 *   · label       —— 具体可执行的方向（不是「是/否/随便」这类态度）；
 *   · description —— 选择该方向的后果/代价，帮用户评估（一句话）；
 *   · recommended —— 模型有明确更优项时标注，UI 显示「推荐」并排在前面；
 *   · multiSelect —— 多个方向可同时成立时才多选；
 *   · 自由文本    —— 永远保留「其他」出口（用户总能补充自己的想法）。
 * 结构化选项比纯字符串多出的不是装饰：没有后果说明时，用户只能凭选项名猜代价，
 * 于是要么随便点一个、要么直接关掉弹窗 —— 提问就白问了。
 */

/** 工具侧传入的选项（字符串或对象）。 */
export interface AskUserOptionInput {
  label: string;
  /** 选择该方向的后果/代价（一句话；UI 在选项下方展示）。 */
  description?: string;
  /** 回传给模型的稳定值（缺省用 label）。 */
  value?: string;
  /** 已标注的推荐项（工具先归一化再交给总线时保留，避免二次归一丢标记）。 */
  recommended?: boolean;
}

/** 归一化后的选项（推送渲染层 / 回填结果都用它）。 */
export interface AskUserOption {
  label: string;
  description?: string;
  value: string;
  /** 模型推荐项（最多一个）。 */
  recommended?: boolean;
}

export interface AskUserRequestInput {
  question: string;
  /** 决策分类徽章（如「部署方案」「架构取舍」），最长 24 字。 */
  header?: string;
  /** 选项：字符串或 { label, description }；最多 8 个。 */
  options?: Array<string | AskUserOptionInput>;
  /** 多选（默认单选）。 */
  multiSelect?: boolean;
  /** 是否允许自由文本（默认 true：永远给「其他」出口）。 */
  allowFreeText?: boolean;
  /** 推荐项下标（0 起）或与选项 label 相同的字符串。 */
  recommendation?: number | string;
  /** 超时（默认 10 分钟；MCP/权限确认的超时语义不同，这里给用户足够时间）。 */
  timeoutMs?: number;
  /** 归属会话：渲染层据此只在对应会话里显示弹窗。 */
  sessionId?: string;
  /** 语义：普通提问（ask_user）或敏感步骤确认；UI 用不同视觉与按钮文案。 */
  kind?: "ask" | "sensitive";
  /** 敏感确认的标题（缺省用通用标题）。 */
  title?: string;
  /** 敏感确认的上下文行（工具 / 目标元素 / 页面 / 原因），让用户看清自己在批准什么。 */
  detail?: { label: string; value: string }[];
}

export interface AskUserAnswer {
  /** 展示/回传给模型的回答文本（选项标签 + 自填内容，或纯自由文本）。 */
  answer?: string;
  /** 单选：所选选项的 label。 */
  choice?: string;
  /** 多选：所选选项的 label 列表。 */
  choices?: string[];
  /** 选项之外的补充说明（自填文本）。 */
  custom?: string;
  /** 用户取消/超时（fail-closed：绝不伪造回答）。 */
  cancelled?: boolean;
  /** 用户明确跳过（不回答，但要求继续）。 */
  skipped?: boolean;
}

/** 推送给渲染层的 ask:user 事件负载（与 contracts 事件语义一致）。 */
export interface AskUserEventPayload {
  requestId: string;
  question: string;
  header?: string;
  options?: AskUserOption[];
  multiSelect?: boolean;
  allowFreeText?: boolean;
  sessionId?: string;
  kind?: "ask" | "sensitive";
  title?: string;
  detail?: { label: string; value: string }[];
  /** 到期时刻（ms 时间戳）：渲染层用它做倒计时并在到期后自动收起。 */
  expiresAt?: number;
}

const MAX_OPTIONS = 8;

/** 换行符常量：避免源码里出现转义序列（易被工具链二次解释）。 */
/**
 * 归一化选项 + 推荐项（纯函数，供工具/壳层/单测共用）。
 *   · 字符串 → { label }；对象取 label/description/value；
 *   · 去空、去重（按 label）、最多 8 个；
 *   · recommendation 支持下标或 label；越界/无匹配则忽略（不猜）。
 */
export function normalizeAskOptions(
  raw: Array<string | AskUserOptionInput> | undefined,
  recommendation?: number | string,
): { options: AskUserOption[]; recommendedIndex?: number } {
  const options: AskUserOption[] = [];
  const seen = new Set<string>();
  for (const item of raw ?? []) {
    const record: AskUserOptionInput = typeof item === "string" ? { label: item } : item;
    const label = String(record?.label ?? "").trim().slice(0, 200);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    const description = typeof record.description === "string" ? record.description.trim().slice(0, 300) : "";
    const value =
      typeof record.value === "string" && record.value.trim()
        ? record.value.trim().slice(0, 200)
        : label;
    options.push({
      label,
      ...(description ? { description } : {}),
      value,
      ...(record.recommended === true ? { recommended: true } : {}),
    });
    if (options.length >= MAX_OPTIONS) break;
  }

  let recommendedIndex: number | undefined;
  if (typeof recommendation === "number" && Number.isInteger(recommendation) && recommendation >= 0 && recommendation < options.length) {
    recommendedIndex = recommendation;
  } else if (typeof recommendation === "string") {
    const wanted = recommendation.trim();
    const match = options.findIndex((option) => option.label === wanted || option.value === wanted);
    if (match >= 0) recommendedIndex = match;
  }
  // 入参已标注过推荐（工具层归一后再交给总线）：显式 recommendation 优先，否则沿用标记。
  if (recommendedIndex === undefined) {
    const flagged = options.findIndex((option) => option.recommended === true);
    if (flagged >= 0) recommendedIndex = flagged;
  }
  if (recommendedIndex !== undefined) {
    // 推荐项只能有一个：先全部清掉再标，避免「双推荐」让用户无法判断模型的真实偏好。
    for (let index = 0; index < options.length; index += 1) {
      const { recommended: _ignored, ...rest } = options[index];
      options[index] = index === recommendedIndex ? { ...rest, recommended: true } : rest;
    }
  }
  return { options, ...(recommendedIndex !== undefined ? { recommendedIndex } : {}) };
}

/** 把回答归一成「文本 + 选择」：取消/跳过与真回答严格区分。 */
export function normalizeAskAnswer(answer: AskUserAnswer): AskUserAnswer {
  const text = typeof answer.answer === "string" ? answer.answer.trim() : "";
  const choice = typeof answer.choice === "string" ? answer.choice.trim() : "";
  const choices = Array.isArray(answer.choices)
    ? Array.from(
        new Set(
          answer.choices
            .map((value) => (typeof value === "string" ? value.trim() : ""))
            .filter((value) => value.length > 0),
        ),
      ).slice(0, MAX_OPTIONS)
    : [];

  if (answer.skipped === true && !text && !choice && choices.length === 0) {
    return { skipped: true };
  }
  if (answer.cancelled === true || (!text && !choice && choices.length === 0)) {
    return { cancelled: true, ...(text ? { answer: text } : {}) };
  }

  const joined = [...(choice ? [choice] : []), ...choices].join("\u3001");
  const custom = text && joined && text !== joined && !choices.includes(text) && text !== choice ? text : undefined;
  const display = text || joined;
  return {
    cancelled: false,
    answer: display,
    ...(choice ? { choice } : {}),
    ...(choices.length > 0 ? { choices } : {}),
    ...(custom ? { custom } : {}),
  };
}

export class AskBus {
  private pending = new Map<
    string,
    {
      resolve: (answer: AskUserAnswer) => void;
      timer: NodeJS.Timeout;
    }
  >();

  constructor(
    private opts: {
      push: (event: string, payload: unknown) => void;
      /** 默认 10 分钟；测试可注入更短值。 */
      defaultTimeoutMs?: number;
      now?: () => number;
    },
  ) {}

  get size(): number {
    return this.pending.size;
  }

  /**
   * 通知渲染层「该 ask 已结算」：回答可能来自界面，也可能来自自动化/另一个窗口。
   * 仅靠界面点击出队时，程序化 ask:respond 会让弹窗和遮罩层永久残留，原生网页视图
   * 一直处于隐藏状态；结算事件让所有入口共用同一条清理路径。
   */
  private emitResolved(requestId: string, reason: "answered" | "timeout" | "cancelled"): void {
    try {
      this.opts.push("ask:resolved", { requestId, reason });
    } catch {
      // 窗口已销毁：结算以 Promise 为准，事件只是 UI 清理提示
    }
  }

  /** 发起一次询问：推送 ask:user 并挂起，直到 ask:respond / 超时。 */
  request(input: AskUserRequestInput): Promise<AskUserAnswer> {
    const question = String(input.question ?? "").trim().slice(0, 2000);
    if (!question) return Promise.resolve({ cancelled: true, answer: "问题为空，已按取消处理" });

    const normalized = normalizeAskOptions(input.options, input.recommendation);
    const options = normalized.options;
    // 选项说明是给用户评估代价用的；没有选项时只剩自由文本。
    const allowFreeText = input.allowFreeText ?? true;
    const multiSelect = input.multiSelect === true && options.length > 0;
    const nowMs = this.opts.now?.() ?? Date.now();
    const requestId = "ask-" + nowMs.toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    const timeoutMs = Math.max(50, Math.floor(input.timeoutMs ?? this.opts.defaultTimeoutMs ?? 600_000));
    const expiresAt = nowMs + timeoutMs;

    return new Promise<AskUserAnswer>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ cancelled: true, answer: "（用户未在 " + Math.round(timeoutMs / 1000) + " 秒内回答，按取消处理）" });
        this.emitResolved(requestId, "timeout");
      }, timeoutMs);
      this.pending.set(requestId, { resolve, timer });
      // 推送失败（窗口已销毁等）也不能让工具永远挂起：直接按取消结算。
      try {
        const header = typeof input.header === "string" ? input.header.trim().slice(0, 24) : "";
        const payload: AskUserEventPayload = {
          requestId,
          question,
          ...(header ? { header } : {}),
          ...(options.length > 0 ? { options } : {}),
          ...(multiSelect ? { multiSelect: true } : {}),
          allowFreeText,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.title ? { title: input.title } : {}),
          ...(input.detail && input.detail.length > 0 ? { detail: input.detail.slice(0, 8) } : {}),
          expiresAt,
        };
        this.opts.push("ask:user", payload);
      } catch {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve({ cancelled: true, answer: "无法把问题推送到界面，按取消处理" });
      }
    });
  }

  /** 渲染层回填（ask:respond）。返回是否命中挂起请求（重复/过期返回 false）。 */
  resolve(requestId: string, answer: AskUserAnswer): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    const normalized = normalizeAskAnswer(answer);
    pending.resolve(normalized);
    this.emitResolved(requestId, normalized.cancelled ? "cancelled" : "answered");
    return true;
  }

  /** 会话终止 / 应用退出：全部按取消结算，避免工具挂死。 */
  clearAll(reason = "会话终止，按取消处理"): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ cancelled: true, answer: reason });
      this.emitResolved(requestId, "cancelled");
    }
    this.pending.clear();
  }
}
