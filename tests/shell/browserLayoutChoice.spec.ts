/**
 * 「Agent 打开网页时」的会话窗口布局决策（第二阶段 Slice E · 功能②）。
 *
 * 全部用假件跑：ask / remember / apply 都是注入回调，断言的是「问没问、记没记、怎么应用」，
 * 不涉及 electron / 磁盘 / 真实窗口。
 */
import { describe, expect, it } from "vitest";
import {
  browserLayoutCopy,
  parseBrowserLayoutAnswer,
  resolveBrowserOpenLayout,
  type BrowserLayoutDeps,
  type BrowserLayoutMode,
  type BrowserLayoutReason,
} from "../../packages/shell/src/main/browserLayoutChoice.ts";

type Fixed = Partial<Omit<BrowserLayoutDeps, "ask" | "remember" | "apply">>;

interface Harness {
  deps: BrowserLayoutDeps;
  asked: { question: string; options: string[]; allowFreeText: boolean }[];
  remembered: BrowserLayoutMode[];
  applied: { mode: BrowserLayoutMode; reason: BrowserLayoutReason }[];
}

/** 假件装配：默认「ask + 无记忆 + 中文 + 用户选常规布局」。 */
function makeHarness(opts: { answer?: string; cancelled?: boolean; fixed?: Fixed } = {}): Harness {
  const asked: Harness["asked"] = [];
  const remembered: BrowserLayoutMode[] = [];
  const applied: Harness["applied"] = [];
  const fixed = opts.fixed ?? {};
  const deps: BrowserLayoutDeps = {
    browserControl: true,
    preference: "ask",
    remembered: null,
    language: "zh-CN",
    url: "https://example.com/docs",
    ask: async (input) => {
      asked.push(input);
      return opts.cancelled ? { cancelled: true } : { answer: opts.answer ?? "收到右侧（常规布局）" };
    },
    remember: (choice) => remembered.push(choice),
    apply: (mode, reason) => applied.push({ mode, reason }),
    ...fixed,
  };
  return { deps, asked, remembered, applied };
}

describe("resolveBrowserOpenLayout · 决策", () => {
  it("ask + 会话没有记忆 → 询问一次、写记忆、按答案应用", async () => {
    const h = makeHarness({ answer: "变为小窗（独立 Agent 窗口）" });
    const outcome = await resolveBrowserOpenLayout(h.deps);

    expect(outcome.proceed).toBe(true);
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0].allowFreeText).toBe(false);
    expect(h.asked[0].options).toEqual(["收到右侧（常规布局）", "变为小窗（独立 Agent 窗口）"]);
    // 询问文案必须把两种安排解释清楚，并带上要打开的网址
    expect(h.asked[0].question).toContain("https://example.com/docs");
    expect(h.asked[0].question).toContain("收到右侧（常规布局）");
    expect(h.asked[0].question).toContain("变为小窗（独立 Agent 窗口）");
    expect(h.asked[0].question).toContain("设置 · 通用");
    expect(h.remembered).toEqual(["agentWindow"]);
    expect(h.applied).toEqual([{ mode: "agentWindow", reason: "chosen" }]);
    expect(outcome.note).toContain("小窗");
  });

  it("ask + 已有记忆 → 不再询问，直接按记忆应用", async () => {
    const h = makeHarness({ fixed: { remembered: "agentWindow" } });
    const outcome = await resolveBrowserOpenLayout(h.deps);

    expect(h.asked).toHaveLength(0);
    expect(h.remembered).toEqual([]);
    expect(h.applied).toEqual([{ mode: "agentWindow", reason: "session" }]);
    expect(outcome).toMatchObject({ proceed: true });
    expect(outcome.note).toContain("小窗");
  });

  it("设置写死 docked → 不询问、不写会话记忆，每次按设置应用", async () => {
    const h = makeHarness({ fixed: { preference: "docked" } });
    const outcome = await resolveBrowserOpenLayout(h.deps);

    expect(h.asked).toHaveLength(0);
    expect(h.remembered).toEqual([]);
    expect(h.applied).toEqual([{ mode: "docked", reason: "preference" }]);
    expect(outcome.proceed).toBe(true);
    expect(outcome.note).toContain("右侧");
  });

  it("设置写死 agentWindow → 不询问、不写会话记忆", async () => {
    const h = makeHarness({ fixed: { preference: "agentWindow" } });
    const outcome = await resolveBrowserOpenLayout(h.deps);

    expect(h.asked).toHaveLength(0);
    expect(h.remembered).toEqual([]);
    expect(h.applied).toEqual([{ mode: "agentWindow", reason: "preference" }]);
    expect(outcome.note).toContain("小窗");
  });

  it("设置 keep → 什么都不做（不问、不记、不改布局）", async () => {
    const h = makeHarness({ fixed: { preference: "keep" } });
    const outcome = await resolveBrowserOpenLayout(h.deps);

    expect(h.asked).toHaveLength(0);
    expect(h.remembered).toEqual([]);
    expect(h.applied).toEqual([]);
    expect(outcome).toEqual({ proceed: true });
  });

  it("用户取消 → proceed:false、不写记忆、不改布局（fail-closed）", async () => {
    const h = makeHarness({ cancelled: true });
    const outcome = await resolveBrowserOpenLayout(h.deps);

    expect(h.asked).toHaveLength(1);
    expect(h.remembered).toEqual([]);
    expect(h.applied).toEqual([]);
    expect(outcome.proceed).toBe(false);
    expect(outcome.note).toContain("取消了本次打开网页");
    expect(outcome.note).toContain("征得用户同意");
  });

  it("空答案（AskBus 归一为取消）→ 同样不写记忆、不导航", async () => {
    const h = makeHarness({ answer: "   " });
    const outcome = await resolveBrowserOpenLayout(h.deps);
    expect(outcome.proceed).toBe(false);
    expect(h.remembered).toEqual([]);
    expect(h.applied).toEqual([]);
  });

  it("询问抛错（窗口销毁等）→ fail-closed，不导航", async () => {
    const h = makeHarness();
    h.deps.ask = async () => {
      throw new Error("boom");
    };
    const outcome = await resolveBrowserOpenLayout(h.deps);
    expect(outcome.proceed).toBe(false);
    expect(outcome.note).toContain("已取消");
  });

  it("浏览器控制关闭 → 直接放行（工具本不可见，这里只做防御）", async () => {
    const h = makeHarness({ fixed: { browserControl: false, preference: "docked" } });
    const outcome = await resolveBrowserOpenLayout(h.deps);

    expect(outcome).toEqual({ proceed: true });
    expect(h.asked).toHaveLength(0);
    expect(h.applied).toEqual([]);
  });

  it("中文自由文本含「小窗」→ 按小窗解析", async () => {
    const h = makeHarness({ answer: "开个小窗吧" });
    await resolveBrowserOpenLayout(h.deps);
    expect(h.remembered).toEqual(["agentWindow"]);
  });

  it("英文界面：文案/选项/提示全部用英文，且 key 与中文对齐", async () => {
    const h = makeHarness({ answer: "Move to a small window (separate agent window)", fixed: { language: "en-US" } });
    const outcome = await resolveBrowserOpenLayout(h.deps);

    expect(h.asked[0].question).toContain("The agent is about to open a page");
    expect(h.asked[0].options).toEqual([
      "Dock to the right (regular layout)",
      "Move to a small window (separate agent window)",
    ]);
    expect(h.remembered).toEqual(["agentWindow"]);
    expect(outcome.note).toBe("Moved the session into a small window (separate agent window)");

    const zh = browserLayoutCopy("zh-CN", "https://a.test");
    const en = browserLayoutCopy("en-US", "https://a.test");
    expect(zh.options).toHaveLength(en.options.length);
    expect(zh.question).toContain("https://a.test");
    expect(en.question).toContain("https://a.test");
  });
});

describe("parseBrowserLayoutAnswer", () => {
  it("含「小窗 / 窗口」→ agentWindow，其余 → docked", () => {
    expect(parseBrowserLayoutAnswer("变为小窗（独立 Agent 窗口）")).toBe("agentWindow");
    expect(parseBrowserLayoutAnswer("窗口")).toBe("agentWindow");
    expect(parseBrowserLayoutAnswer("收到右侧（常规布局）")).toBe("docked");
    expect(parseBrowserLayoutAnswer("")).toBe("docked");
    expect(parseBrowserLayoutAnswer(undefined)).toBe("docked");
  });

  it("英文选项同样能解析（两种语言口径一致）", () => {
    expect(parseBrowserLayoutAnswer("Move to a small window (separate agent window)")).toBe("agentWindow");
    expect(parseBrowserLayoutAnswer("Dock to the right (regular layout)")).toBe("docked");
  });
});
