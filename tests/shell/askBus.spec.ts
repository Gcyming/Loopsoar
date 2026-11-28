/**
 * AskBus：ask_user 挂起/回填/超时/清理 + 结构化选项（推荐/多选/跳过/自填）。
 * 为什么单独测：这是「等真人回答」的挂起点，超时与取消必须 fail-closed（绝不伪造回答）；
 * 跳过则是「不回答但要求继续」——两者语义不同，不能混成一个 cancelled。
 */
import { describe, expect, it, vi } from "vitest";
import { AskBus, normalizeAskAnswer, normalizeAskOptions } from "../../packages/shell/src/main/askBus.ts";

describe("AskBus", () => {
  it("request 推送 ask:user 事件；resolve 回填回答", async () => {
    const pushed: { event: string; payload: unknown }[] = [];
    const bus = new AskBus({ push: (event, payload) => pushed.push({ event, payload }) });
    const pending = bus.request({ question: "选哪个方案？", options: ["A", "B"] });
    expect(bus.size).toBe(1);
    expect(pushed).toHaveLength(1);
    expect(pushed[0].event).toBe("ask:user");
    const payload = pushed[0].payload as {
      requestId: string;
      question: string;
      options: { label: string; value: string }[];
    };
    expect(payload.question).toBe("选哪个方案？");
    // 选项归一为结构化对象：label 给用户看，value 回传（字符串输入 → 两者相同）
    expect(payload.options).toEqual([
      { label: "A", value: "A" },
      { label: "B", value: "B" },
    ]);

    const received = bus.resolve(payload.requestId, { answer: "B" });
    expect(received).toBe(true);
    await expect(pending).resolves.toEqual({ cancelled: false, answer: "B" });
    expect(bus.size).toBe(0);
    // 结算事件：程序化 ask:respond（自动化/E2E）也能让界面出队并撤掉遮罩
    expect(pushed).toContainEqual({
      event: "ask:resolved",
      payload: { requestId: payload.requestId, reason: "answered" },
    });
    // 重复回填不生效
    expect(bus.resolve(payload.requestId, { answer: "A" })).toBe(false);
  });

  it("敏感确认携带会话归属 / 语义 / 上下文 / 到期时刻", async () => {
    const pushed: { payload: unknown }[] = [];
    const now = 1_700_000_000_000;
    const bus = new AskBus({ push: (_e, payload) => pushed.push({ payload }), now: () => now });
    const pending = bus.request({
      question: "Agent 准备点击「立即支付」",
      options: ["确认执行", "取消"],
      allowFreeText: false,
      timeoutMs: 180_000,
      sessionId: "sess-42",
      kind: "sensitive",
      title: "敏感操作确认",
      detail: [
        { label: "操作", value: "browser_click" },
        { label: "目标", value: "立即支付" },
      ],
    });
    const payload = pushed[0].payload as {
      requestId: string;
      sessionId?: string;
      kind?: string;
      title?: string;
      detail?: { label: string; value: string }[];
      expiresAt?: number;
    };
    // 会话归属：渲染层据此只在对应会话弹窗（后台会话不抢界面）
    expect(payload.sessionId).toBe("sess-42");
    expect(payload.kind).toBe("sensitive");
    expect(payload.title).toBe("敏感操作确认");
    expect(payload.detail).toEqual([
      { label: "操作", value: "browser_click" },
      { label: "目标", value: "立即支付" },
    ]);
    // 到期时刻 = now + timeout：渲染层倒计时与自动收起都靠它
    expect(payload.expiresAt).toBe(now + 180_000);

    bus.resolve(payload.requestId, { answer: "confirm" });
    await expect(pending).resolves.toEqual({ cancelled: false, answer: "confirm" });
  });

  it("超时按取消结算，不伪造回答", async () => {
    const pushed: { event: string; payload: unknown }[] = [];
    const bus = new AskBus({ push: (event, payload) => pushed.push({ event, payload }) });
    const pending = bus.request({ question: "还在吗？", timeoutMs: 60 });
    const answer = await pending;
    expect(answer.cancelled).toBe(true);
    expect(answer.answer).toContain("未在");
    expect(bus.size).toBe(0);
    expect(pushed).toContainEqual({
      event: "ask:resolved",
      payload: { requestId: (pushed[0].payload as { requestId: string }).requestId, reason: "timeout" },
    });
  });

  it("空回答 / 显式取消都按取消处理", async () => {
    const pushed: { event: string; payload: unknown }[] = [];
    const bus = new AskBus({ push: (event, payload) => pushed.push({ event, payload }) });
    const first = bus.request({ question: "q1" });
    const firstId = (pushed.find((item) => item.event === "ask:user")!.payload as { requestId: string }).requestId;
    bus.resolve(firstId, { answer: "   " });
    await expect(first).resolves.toMatchObject({ cancelled: true });

    const second = bus.request({ question: "q2" });
    const secondId = (pushed.filter((item) => item.event === "ask:user")[1].payload as { requestId: string }).requestId;
    bus.resolve(secondId, { cancelled: true });
    await expect(second).resolves.toMatchObject({ cancelled: true });
  });

  it("clearAll 结算全部挂起请求；push 抛错时按取消结算", async () => {
    const bus = new AskBus({ push: () => {} });
    const a = bus.request({ question: "a" });
    const b = bus.request({ question: "b" });
    expect(bus.size).toBe(2);
    bus.clearAll();
    await expect(a).resolves.toMatchObject({ cancelled: true });
    await expect(b).resolves.toMatchObject({ cancelled: true });

    const broken = new AskBus({
      push: () => {
        throw new Error("窗口已销毁");
      },
    });
    await expect(broken.request({ question: "c" })).resolves.toMatchObject({ cancelled: true });
  });

  it("空问题直接取消；超时下限被钳制到合理值", async () => {
    const bus = new AskBus({ push: () => {} });
    await expect(bus.request({ question: "   " })).resolves.toMatchObject({ cancelled: true });
    const pending = bus.request({ question: "x", timeoutMs: 1 });
    const started = Date.now();
    await pending;
    expect(Date.now() - started).toBeGreaterThanOrEqual(40); // 下限 50ms（计时抖动容差）
    vi.useRealTimers();
  });
});

describe("normalizeAskOptions（结构化选项）", () => {
  it("字符串与对象混排：保留 description，去重、截断、标注推荐", () => {
    const result = normalizeAskOptions(
      [
        "Docker 部署",
        { label: "裸机部署", description: "排障直观，但依赖要自己装" },
        "Docker 部署",
        { label: "  ", description: "空标签被丢弃" },
      ],
      1,
    );
    expect(result.options).toHaveLength(2);
    expect(result.options[1].description).toContain("排障直观");
    expect(result.options[1].recommended).toBe(true);
    expect(result.recommendedIndex).toBe(1);
    expect(result.options[0].recommended).toBeUndefined();
  });

  it("推荐项支持字符串 label；不存在/越界时不猜", () => {
    expect(normalizeAskOptions(["A", "B"], "B").recommendedIndex).toBe(1);
    expect(normalizeAskOptions(["A", "B"], "C").recommendedIndex).toBeUndefined();
    expect(normalizeAskOptions(["A", "B"], 9).recommendedIndex).toBeUndefined();
  });

  it("已标注的推荐项在二次归一时保留（工具 → 总线不会丢标记）", () => {
    const first = normalizeAskOptions(["A", "B"], 0);
    const second = normalizeAskOptions(first.options);
    expect(second.recommendedIndex).toBe(0);
    expect(second.options.filter((option) => option.recommended)).toHaveLength(1);
  });

  it("最多 8 个选项", () => {
    const options = Array.from({ length: 20 }, (_, i) => "选项" + i);
    expect(normalizeAskOptions(options).options).toHaveLength(8);
  });
});

describe("normalizeAskAnswer（回答语义）", () => {
  it("多选 + 自填：choices 与 custom 分离", () => {
    const answer = normalizeAskAnswer({ choices: ["A", "B"], answer: "另外也考虑 C" });
    expect(answer.cancelled).toBe(false);
    expect(answer.choices).toEqual(["A", "B"]);
    expect(answer.custom).toBe("另外也考虑 C");
    expect(answer.answer).toBe("另外也考虑 C");
  });

  it("只选了选项：answer 回填为选项文本，不产生 custom", () => {
    const answer = normalizeAskAnswer({ choice: "Docker 部署" });
    expect(answer.choice).toBe("Docker 部署");
    expect(answer.answer).toBe("Docker 部署");
    expect(answer.custom).toBeUndefined();
  });

  it("跳过与取消严格区分", () => {
    expect(normalizeAskAnswer({ skipped: true })).toEqual({ skipped: true });
    expect(normalizeAskAnswer({})).toEqual({ cancelled: true });
    // 既跳过又填了文本：按真回答处理（用户其实说了话）
    const answered = normalizeAskAnswer({ skipped: true, answer: "用 Docker" });
    expect(answered.cancelled).toBe(false);
    expect(answered.answer).toBe("用 Docker");
  });
});

describe("AskBus（结构化回填）", () => {
  it("多选 + 自填：choices 与 custom 都回传", async () => {
    const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const bus = new AskBus({ push: (event, payload) => events.push({ event, payload: payload as Record<string, unknown> }) });
    const pending = bus.request({
      question: "还要改哪些模块？",
      options: ["压缩", "提问", "UI"],
      multiSelect: true,
    });
    const asked = events.find((item) => item.event === "ask:user");
    expect(asked?.payload.multiSelect).toBe(true);
    bus.resolve(String(asked?.payload.requestId), { choices: ["压缩", "提问"], answer: "顺便看下 UI" });
    const answer = await pending;
    expect(answer.choices).toEqual(["压缩", "提问"]);
    expect(answer.custom).toBe("顺便看下 UI");
  });

  it("跳过：返回 skipped，不冒充用户选择", async () => {
    const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const bus = new AskBus({ push: (event, payload) => events.push({ event, payload: payload as Record<string, unknown> }) });
    const pending = bus.request({ question: "选哪个？", options: ["A", "B"] });
    const asked = events.find((item) => item.event === "ask:user");
    bus.resolve(String(asked?.payload.requestId), { skipped: true });
    const answer = await pending;
    expect(answer.skipped).toBe(true);
    expect(answer.cancelled).toBeUndefined();
  });
});
