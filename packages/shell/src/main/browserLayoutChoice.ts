/**
 * 「Agent 打开网页时」的会话窗口布局决策（第二阶段 Slice E · 功能②）。
 *
 * 用户诉求：浏览器控制开启的会话里，Agent **第一次**要打开网页之前询问一次——
 * 「会话收到右侧（常规布局）」还是「变为小窗（独立 Agent 窗口）」；默认策略由
 * 设置 · 通用的 browserOpenLayout 决定（ask 默认 / docked / agentWindow / keep）。
 * 询问窗里必须把两种安排解释清楚（不能只丢两个抽象选项）。
 *
 * 为什么单独成模块、且写成「输入 + 回调」：
 *   · 壳层装配（index.ts）只需要接线，不重复实现分支；
 *   · 决策里没有 electron / fs / 全局状态，单元测试用假件就能覆盖全部分支
 *     （是否询问、是否写会话记忆、取消是否 fail-closed）；
 *   · 询问文案与提示文案集中在这里，中英两套 key 对齐，避免散落在装配代码里漂移。
 *
 * 语义要点（与设计一致，改动前先读）：
 *   1. ask + 会话已有记忆 → 不再询问，直接按记忆应用；
 *   2. 设置里写死 docked / agentWindow 属于「每次都这样」，**不写**会话记忆
 *      （否则用户改了设置，旧会话还按当年那次选择走）；
 *   3. keep → 什么都不做（既不询问也不改布局）；
 *   4. 取消 / 超时（AskBus 超时按取消结算）→ 不写记忆、不导航（fail-closed）；
 *   5. 会话没开「浏览器控制」→ 直接放行（工具此时本不可见，这里只做防御）。
 */

/** 会话窗口布局：收到右侧（常规布局）/ 变为小窗（独立 Agent 窗口）。 */
export type BrowserLayoutMode = "docked" | "agentWindow";

/** 设置 · 通用 → Agent 打开网页时的窗口布局（缺省 ask）。 */
export type BrowserLayoutPreference = "ask" | "docked" | "agentWindow" | "keep";

/** 界面语言（与 preferences.language 同形；此处自持联合类型，避免壳层依赖 UI 包）。 */
export type BrowserLayoutLang = "zh-CN" | "en-US";

/** AskBus.request 的窄接口（只取本模块用到的三个字段；测试注入假件）。 */
export interface BrowserLayoutAskInput {
  question: string;
  options: string[];
  allowFreeText: boolean;
}

/** AskBus 的回答形状（超时/取消统一为 cancelled:true）。 */
export interface BrowserLayoutAnswer {
  answer?: string;
  cancelled?: boolean;
}

/** 应用布局的原因（写进 chrome:applyLayout 负载，便于排查「这次为什么变了」）。 */
export type BrowserLayoutReason = "preference" | "session" | "chosen";

export interface BrowserLayoutDeps {
  /** 会话级「浏览器控制」开关（false = 工具对模型不可见，这里只做防御性放行）。 */
  browserControl: boolean;
  /** 设置里的默认策略。 */
  preference: BrowserLayoutPreference;
  /** 会话已记住的选择（null = 从未选过，下次仍会询问）。 */
  remembered: BrowserLayoutMode | null;
  /** 界面语言（询问文案/选项/提示的中英切换）。 */
  language: BrowserLayoutLang;
  /** 待打开的网址（写进询问文案，让用户知道这次要打开什么）。 */
  url: string;
  /** 询问用户一次（AskBus.request；取消/超时都以 cancelled:true 结算）。 */
  ask: (input: BrowserLayoutAskInput) => Promise<BrowserLayoutAnswer>;
  /** 记住本会话的选择（SessionStore.setBrowserLayoutChoice）。 */
  remember: (choice: BrowserLayoutMode) => void;
  /** 应用布局（pushToRenderer("chrome:applyLayout")，渲染层执行真正窗口动作）。 */
  apply: (mode: BrowserLayoutMode, reason: BrowserLayoutReason) => void;
}

/** 勾子返回值：proceed=false 时 browser_navigate 不导航（fail-closed），note 进工具结果文案。 */
export interface BrowserLayoutOutcome {
  proceed: boolean;
  note?: string;
}

/** 中英文案（两语言 key 必须对齐；{url} 为占位符）。 */
interface BrowserLayoutCopy {
  question: (url: string) => string;
  options: [string, string];
  noteDocked: string;
  noteAgentWindow: string;
  /** 询问被取消/超时：不导航，并把「怎么继续」告诉模型。 */
  cancelled: string;
  /** 询问发不出去（窗口已销毁等）：同样 fail-closed，不导航。 */
  askFailed: string;
}

const COPY: Record<BrowserLayoutLang, BrowserLayoutCopy> = {
  "zh-CN": {
    question: (url) =>
      `Agent 准备在当前会话打开网页：${url}

请选择会话窗口的布局（本次会话只需选择一次）：
· 收到右侧（常规布局）——网页占据主区域，会话栏停靠在窗口右侧，适合边看边聊；
· 变为小窗（独立 Agent 窗口）——会话独立成一个小窗浮在桌面上，主窗口的网页铺满全屏，适合专注浏览网页。

选择会记在本会话；之后可以在「设置 · 通用 → Agent 打开网页时的窗口布局」修改默认行为。`,
    options: ["收到右侧（常规布局）", "变为小窗（独立 Agent 窗口）"],
    noteDocked: "已把会话收齐到右侧（常规布局）",
    noteAgentWindow: "已把会话切换为小窗（独立 Agent 窗口）",
    cancelled: "用户取消了本次打开网页；如需继续，请征得用户同意后重试，或询问用户希望怎样安排窗口",
    askFailed: "无法把「窗口布局」询问推送到界面，本次打开网页已取消；请稍后重试或询问用户希望怎样安排窗口",
  },
  "en-US": {
    question: (url) =>
      `The agent is about to open a page in this session: ${url}

Choose the session window layout (you only need to choose once per session):
· Dock to the right (regular layout) — the page fills the main area and the session panel docks on the right, handy for browsing and chatting side by side;
· Move to a small window (separate agent window) — the session floats in its own small window on the desktop while the page fills the main window, handy for focused browsing.

The choice is remembered for this session; you can change the default later in Settings · General → "Window layout when the agent opens a page".`,
    options: ["Dock to the right (regular layout)", "Move to a small window (separate agent window)"],
    noteDocked: "Moved the session back to the right (regular layout)",
    noteAgentWindow: "Moved the session into a small window (separate agent window)",
    cancelled:
      "The user cancelled opening this page; to continue, ask for their consent and retry, or ask how they want the window arranged",
    askFailed:
      "Could not show the window-layout question, so opening this page was cancelled; retry later or ask how the user wants the window arranged",
  },
};

/**
 * 回答解析：含「小窗 / 窗口 / small window / agent window」即按小窗处理，其余按常规布局。
 *
 * 为什么用包含判断而不是全等：选项文案可能被本地化/改写，用户也可能通过自由文本
 * （其它入口复用同一总线时 allowFreeText 可能为 true）表达「开个小窗」「别浮窗」这类说法；
 * 宁可给一个确定答案，也不要因为文案微调就解析失败。
 */
export function parseBrowserLayoutAnswer(answer: string | undefined): BrowserLayoutMode {
  const text = String(answer ?? "").toLowerCase();
  if (/小窗|窗口|浮窗|small window|agent window|separate window|float/.test(text)) return "agentWindow";
  return "docked";
}

/** 查询文案/选项（装配层需要单独取文案时用；两语言 key 对齐）。 */
export function browserLayoutCopy(language: BrowserLayoutLang, url: string): {
  question: string;
  options: string[];
} {
  const copy = COPY[language] ?? COPY["zh-CN"];
  return { question: copy.question(url), options: [...copy.options] };
}

/** 布局应用的提示文案（工具成功结果后追加的一行）。 */
export function browserLayoutNote(language: BrowserLayoutLang, mode: BrowserLayoutMode): string {
  const copy = COPY[language] ?? COPY["zh-CN"];
  return mode === "agentWindow" ? copy.noteAgentWindow : copy.noteDocked;
}

/**
 * 决策主函数：返回「是否继续导航」以及写进工具结果的 note。
 * 纯编排：所有副作用都经 deps 注入（ask / remember / apply）。
 */
export async function resolveBrowserOpenLayout(deps: BrowserLayoutDeps): Promise<BrowserLayoutOutcome> {
  const copy = COPY[deps.language] ?? COPY["zh-CN"];
  const { preference } = deps;

  // 防御：会话没开浏览器控制时 browser_navigate 本就不可见（工具面/执行闸两道闸），
  // 真走到这里说明装配或快照不一致——放行，别把「不该出现的调用」变成用户弹窗。
  if (!deps.browserControl) return { proceed: true };

  // keep：不动当前布局，也不询问（用户明确要求「别管我的窗口」）。
  if (preference === "keep") return { proceed: true };

  // 设置里写死的默认：每次都按它安排；不写会话记忆（设置是「每次都这样」，不是一次性选择）。
  if (preference === "docked" || preference === "agentWindow") {
    deps.apply(preference, "preference");
    return { proceed: true, note: browserLayoutNote(deps.language, preference) };
  }

  // ask：本会话已经选过 → 直接按记忆应用，不再打扰。
  if (deps.remembered) {
    deps.apply(deps.remembered, "session");
    return { proceed: true, note: browserLayoutNote(deps.language, deps.remembered) };
  }

  let answer: BrowserLayoutAnswer;
  try {
    answer = await deps.ask({ question: copy.question(deps.url), options: [...copy.options], allowFreeText: false });
  } catch {
    // 推送失败（窗口销毁等）：AskBus 内部已按取消结算，这里再兜一层，绝不因异常而导航。
    return { proceed: false, note: copy.askFailed };
  }
  if (answer.cancelled || !String(answer.answer ?? "").trim()) {
    // 取消/超时：不写记忆（下次还会问），不导航（fail-closed）。
    return { proceed: false, note: copy.cancelled };
  }

  const mode = parseBrowserLayoutAnswer(answer.answer);
  deps.remember(mode);
  deps.apply(mode, "chosen");
  return { proceed: true, note: browserLayoutNote(deps.language, mode) };
}
