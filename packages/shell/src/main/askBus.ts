/**
 * 询问用户（ask_user 工具）请求总线（壳层）。
 *
 * 为什么需要挂起式总线：ask_user 的语义就是「等一个真人回答」，工具执行必须挂起；
 * 与权限确认（PermRequestBus）同构：超时按取消结算（fail-closed），渲染层弹窗经
 * `ask:respond` 通道回填。工具只依赖本总线，不直接碰 electron/IPC。
 */

export interface AskUserRequestInput {
  question: string;
  options?: string[];
  /** 是否允许自由文本（默认 true；仅给选项时可置 false）。 */
  allowFreeText?: boolean;
  /** 超时（默认 10 分钟；MCP/权限确认的超时语义不同，这里给用户足够时间）。 */
  timeoutMs?: number;
  /**
   * 归属会话：渲染层据此只在对应会话里显示弹窗。
   * 为什么需要：Agent 可能在**后台会话**里提问/触发敏感确认，弹窗不能凭空盖在用户正在看的会话上。
   */
  sessionId?: string;
  /** 语义：普通提问（ask_user）或敏感步骤确认；UI 用不同视觉与按钮文案。 */
  kind?: "ask" | "sensitive";
  /** 敏感确认的标题（缺省用通用标题）。 */
  title?: string;
  /** 敏感确认的上下文行（工具 / 目标元素 / 页面 / 原因），让用户看清自己在批准什么。 */
  detail?: { label: string; value: string }[];
}

export interface AskUserAnswer {
  answer?: string;
  cancelled?: boolean;
}

/** 推送给渲染层的 ask:user 事件负载（与 contracts 事件语义一致）。 */
export interface AskUserEventPayload {
  requestId: string;
  question: string;
  options?: string[];
  allowFreeText?: boolean;
  sessionId?: string;
  kind?: "ask" | "sensitive";
  title?: string;
  detail?: { label: string; value: string }[];
  /**
   * 到期时刻（ms 时间戳）：渲染层用它做倒计时并在到期后自动收起。
   * 为什么必须带：shell 超时后已按取消结算，但弹窗留在界面上会让用户以为「还能答」，
   * 点下去得到的是「问题已过期」——体验与事实都不对。
   */
  expiresAt?: number;
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
    const question = String(input.question ?? "").trim();
    if (!question) return Promise.resolve({ cancelled: true, answer: "问题为空，已按取消处理" });
    const options = (input.options ?? [])
      .map((option) => String(option ?? "").trim())
      .filter(Boolean)
      .slice(0, 8);
    const allowFreeText = input.allowFreeText ?? options.length === 0;
    const nowMs = this.opts.now?.() ?? Date.now();
    const requestId = `ask-${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const timeoutMs = Math.max(50, Math.floor(input.timeoutMs ?? this.opts.defaultTimeoutMs ?? 600_000));
    const expiresAt = nowMs + timeoutMs;

    return new Promise<AskUserAnswer>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ cancelled: true, answer: `（用户未在 ${Math.round(timeoutMs / 1000)} 秒内回答，按取消处理）` });
        this.emitResolved(requestId, "timeout");
      }, timeoutMs);
      this.pending.set(requestId, { resolve, timer });
      // 推送失败（窗口已销毁等）也不能让工具永远挂起：直接按取消结算。
      try {
        const payload: AskUserEventPayload = {
          requestId,
          question,
          ...(options.length > 0 ? { options } : {}),
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
    const text = typeof answer.answer === "string" ? answer.answer.trim() : "";
    pending.resolve(
      answer.cancelled || text.length === 0
        ? { cancelled: true, answer: text || undefined }
        : { cancelled: false, answer: text },
    );
    this.emitResolved(requestId, "answered");
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
