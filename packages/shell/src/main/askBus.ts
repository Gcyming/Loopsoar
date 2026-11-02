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

  /** 发起一次询问：推送 ask:user 并挂起，直到 ask:respond / 超时。 */
  request(input: AskUserRequestInput): Promise<AskUserAnswer> {
    const question = String(input.question ?? "").trim();
    if (!question) return Promise.resolve({ cancelled: true, answer: "问题为空，已按取消处理" });
    const options = (input.options ?? [])
      .map((option) => String(option ?? "").trim())
      .filter(Boolean)
      .slice(0, 8);
    const allowFreeText = input.allowFreeText ?? options.length === 0;
    const requestId = `ask-${(this.opts.now?.() ?? Date.now()).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const timeoutMs = Math.max(50, Math.floor(input.timeoutMs ?? this.opts.defaultTimeoutMs ?? 600_000));

    return new Promise<AskUserAnswer>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ cancelled: true, answer: `（用户未在 ${Math.round(timeoutMs / 1000)} 秒内回答，按取消处理）` });
      }, timeoutMs);
      this.pending.set(requestId, { resolve, timer });
      // 推送失败（窗口已销毁等）也不能让工具永远挂起：直接按取消结算。
      try {
        const payload: AskUserEventPayload = {
          requestId,
          question,
          ...(options.length > 0 ? { options } : {}),
          allowFreeText,
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
    return true;
  }

  /** 会话终止 / 应用退出：全部按取消结算，避免工具挂死。 */
  clearAll(reason = "会话终止，按取消处理"): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ cancelled: true, answer: reason });
    }
    this.pending.clear();
  }
}
