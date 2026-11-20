/**
 * 元素引用（ref）注册表与动作解析（P0-2）：
 * 快照产物 → 注册表 → ref 解析 → 可行动错误 → 原生 setter 输入 → 导航失效。
 * 全部用假 WebContents（不引 electron），页面脚本直接按字符串断言。
 */
import { describe, expect, it } from "vitest";
import { createWebContentsViewAdapter } from "../../packages/shell/src/browserAdapter/backends/webContentsView.ts";
import {
  NAMED_KEYS,
  RefRegistry,
  SNAPSHOT_SCRIPT,
  buildAgentDrivingScript,
  buildClickScript,
  buildFocusProbeScript,
  buildHoverScript,
  buildPressKeyScript,
  buildSelectScript,
  buildTargetPointScript,
  buildUserLockScript,
  buildTypeScript,
  findCandidates,
  formatCandidates,
  isSupportedKey,
  keyCodeOf,
  normalizeRef,
  performClick,
  performHover,
  performPressKey,
  performSelect,
  performType,
  resolveTarget,
  type RawBrowserElement,
} from "../../packages/shell/src/browserAdapter/refs.ts";

/** 假页面的快照产物：5 个元素，覆盖 link / textbox / button / heading / navigation。 */
const PAGE: RawBrowserElement[] = [
  { tag: "nav", role: "navigation", name: "主导航", selector: "nav", selectorWhy: "path" },
  { tag: "a", role: "link", name: "登录", selector: "#login", selectorWhy: "id", href: "/login" },
  { tag: "input", role: "textbox", name: "搜索", selector: "input[name=q]", selectorWhy: "name", type: "text", value: "" },
  { tag: "button", role: "button", name: "提交", selector: "button", selectorWhy: "text", matchText: "提交" },
  { tag: "h1", role: "heading", name: "欢迎", selector: "h1", selectorWhy: "path" },
];

describe("焦点探测脚本（press_key 的敏感判定）", () => {
  it("带可识别标记，读 activeElement 的 tag/type/role/name", () => {
    const script = buildFocusProbeScript();
    expect(script).toContain("loopsoar:focus-probe");
    expect(script).toContain("document.activeElement");
    expect(script).toContain("aria-label");
    expect(script).toContain("return { ok: true, tag: tag");
  });
});

function fakeView(scriptResult: unknown = { ok: true }) {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const scripts: string[] = [];
  let snapshotPayload: unknown = {
    url: "https://example.com/",
    title: "示例页",
    text: "正文",
    elements: PAGE,
    elementTotal: PAGE.length,
  };
  const view = {
    webContents: {
      async loadURL() {},
      getURL: () => "https://example.com/",
      async capturePage() {
        return { toPNG: () => Buffer.from("") };
      },
      async executeJavaScript(code: string) {
        scripts.push(code);
        return code.startsWith("/* loopsoar:snapshot */") ? snapshotPayload : scriptResult;
      },
      on(event: string, cb: (...args: unknown[]) => void) {
        handlers.set(event, cb);
      },
      setAudioMuted() {},
      close() {},
    },
  };
  return { view, handlers, scripts };
}

describe("元素引用注册表", () => {
  it("快照脚本不写 DOM 属性，选择器按稳定性阶梯回退", () => {
    expect(SNAPSHOT_SCRIPT).not.toContain("setAttribute");
    expect(SNAPSHOT_SCRIPT).not.toContain("data-loops-el");
    for (const token of ["aria-label", "data-testid", "nth-child", "matchText"]) {
      expect(SNAPSHOT_SCRIPT).toContain(token);
    }
    // 注入页面的脚本必须是合法 JS（否则快照会静默失败）
    expect(() => new Function(SNAPSHOT_SCRIPT)).not.toThrow();
  });

  it("每次快照按文档顺序分配 ref；重快照不复用旧 ref，代数单调递增", () => {
    const registry = new RefRegistry();
    const first = registry.reset(PAGE);
    expect(first.map((el) => el.ref)).toEqual(["e1", "e2", "e3", "e4", "e5"]);
    expect(first[1].name).toBe("登录");
    expect(registry.gen).toBe(1);
    // matchText 是内部判别条件，不进入对外元素
    expect("matchText" in first[3]).toBe(false);
    const second = registry.reset([PAGE[1]]);
    expect(registry.gen).toBe(2);
    expect(registry.size).toBe(1);
    // 旧 e1 不再存在；新快照从 e6 起，避免旧 ref 静默落到新元素
    expect(second.map((el) => el.ref)).toEqual(["e6"]);
    const stale = resolveTarget(registry, "e1");
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe("STALE_REF");
  });

  it("快照父子关系：parentIndex 映射为同代 ref，内部字段不外泄", () => {
    const registry = new RefRegistry();
    const out = registry.reset([
      { tag: "main", role: "main", name: "容器", selector: "main", selectorWhy: "path" },
      { tag: "button", role: "button", name: "A", selector: "#a", selectorWhy: "id", parentIndex: 0 },
      { tag: "button", role: "button", name: "B", selector: "#b", selectorWhy: "id", parentIndex: 0 },
      { tag: "span", role: "button", name: "C", selector: "#c", selectorWhy: "id", parentIndex: 1 },
    ]);
    expect(out.map((el) => el.ref)).toEqual(["e1", "e2", "e3", "e4"]);
    expect(out[0].parent).toBeUndefined();
    expect(out[1].parent).toBe("e1");
    expect(out[3].parent).toBe("e2");
    expect("parentIndex" in out[1]).toBe(false);
  });

  it("ref 别名归一化：#e5 / e5 / 5 都指向 e5，CSS 不被误判", () => {
    expect(normalizeRef("e5")).toBe("e5");
    expect(normalizeRef("E5")).toBe("e5");
    expect(normalizeRef("5")).toBe("e5");
    expect(normalizeRef("#e5")).toBe("e5");
    expect(normalizeRef("[#e5]")).toBe("e5");
    expect(normalizeRef("button#submit")).toBeNull();
    expect(normalizeRef("text=登录")).toBeNull();
  });

  it("解析顺序：ref → 注册表句柄；CSS 原样；text= 走文本匹配", () => {
    const registry = new RefRegistry();
    registry.reset(PAGE);
    const byRef = resolveTarget(registry, "e2");
    expect(byRef.ok && byRef.kind === "ref" && byRef.selector === "#login").toBe(true);
    const byNumber = resolveTarget(registry, "2");
    expect(byNumber.ok && byNumber.selector === "#login").toBe(true);
    // 精确文本句柄：选择器 + matchText 两段
    const byTextHandle = resolveTarget(registry, "e4");
    expect(byTextHandle.ok && byTextHandle.mode === "exactText" && byTextHandle.matchText === "提交").toBe(true);
    const css = resolveTarget(registry, "button.primary");
    expect(css.ok && css.kind === "css" && css.selector === "button.primary").toBe(true);
    const text = resolveTarget(registry, "text=登录");
    expect(text.ok && text.kind === "text" && text.matchText === "登录").toBe(true);
  });

  it("注册表没有该 ref → STALE_REF（导航清空 / 从未快照都覆盖）", () => {
    const registry = new RefRegistry();
    registry.reset(PAGE);
    registry.clear(); // 导航
    const gone = resolveTarget(registry, "e2");
    expect(gone.ok).toBe(false);
    expect(!gone.ok && gone.code).toBe("STALE_REF");
    expect(!gone.ok && gone.message).toContain("browser_snapshot");
    const never = resolveTarget(null, "e1");
    expect(!never.ok && never.message).toContain("[STALE_REF]");
  });

  it("ELEMENT_NOT_FOUND 候选 ≤3 且带 #eN 与 name", () => {
    const registry = new RefRegistry();
    registry.reset(PAGE);
    const candidates = findCandidates(registry, "text=提交");
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThanOrEqual(3);
    expect(candidates[0].name).toBe("提交");
    expect(formatCandidates(candidates)).toContain("#e4");
  });
});

describe("Agent 真实输入 · 坐标与锁", () => {
  it("落点脚本：带定位标记、命中验证与中心坐标（不点击）", () => {
    const registry = new RefRegistry();
    registry.reset(PAGE);
    const resolved = resolveTarget(registry, "e2");
    if (!resolved.ok) throw new Error("解析失败");
    const script = buildTargetPointScript(resolved);
    expect(script).toContain("loopsoar:target-point");
    // 隐藏/后台标签的 rAF 不触发：定位脚本必须有超时兜底，否则工具调用会挂到任务超时
    expect(script).toContain("document.visibilityState === 'hidden'");
    expect(script).toContain("setTimeout(finish, 100)");
    expect(script).toContain("elementFromPoint");
    expect(script).toContain("#login");
    expect(script).toContain("return { ok: true, x: cx, y: cy");
    expect(script).not.toContain("el.click()");
  });

  it("放行脚本：只切驱动标志；锁层始终保持 pointer-events:none", () => {
    const on = buildAgentDrivingScript(true);
    expect(on).toContain("__loopsoarAgentDriving = true");
    expect(on).toContain("pointerEvents = 'none'");
    const off = buildAgentDrivingScript(false);
    expect(off).toContain("__loopsoarAgentDriving = false");
    // 回归：解锁时若把锁层改回 auto，会夺走 Agent 鼠标的 :hover，
    // 悬浮菜单会在 hover→click 之间塌陷（评测任务 24）。
    expect(off).toContain("pointerEvents = 'none'");
    expect(off).not.toContain("pointerEvents = 'auto'");
  });

  it("接管锁：记住 mask，并在驱动标志为真时放行可信事件", () => {
    const script = buildUserLockScript(true, "Agent 正在操作");
    expect(script).toContain("__loopsoarAgentDriving === true");
    expect(script).toContain("mask: mask");
    expect(script).toContain("isTrusted !== true");
  });
});

describe("动作解析与执行", () => {
  it("click：ref 解析成注册表选择器并注入页面脚本", async () => {
    const registry = new RefRegistry();
    registry.reset(PAGE);
    const scripts: string[] = [];
    const result = await performClick(registry, "e2", async (script) => {
      scripts.push(script);
      return { ok: true };
    });
    expect(result.ok).toBe(true);
    // 光标/高亮已移到应用级覆盖窗口：performClick 只注入一次真正的点击脚本
    expect(scripts.length).toBe(1);
    expect(scripts[0]).toContain("#login");
    expect(() => new Function(scripts[0])).not.toThrow();
    expect(result.label).toContain("登录");
  });

  it("页面里查不到元素 → ELEMENT_NOT_FOUND + top3 候选", async () => {
    const registry = new RefRegistry();
    registry.reset(PAGE);
    const result = await performClick(registry, "e4", async () => ({ ok: false, code: "ELEMENT_NOT_FOUND" }));
    expect(result.ok).toBe(false);
    expect(result.code).toBe("ELEMENT_NOT_FOUND");
    expect(result.message).toContain("[ELEMENT_NOT_FOUND]");
    expect(result.message).toContain("候选");
    expect(result.candidates?.length ?? 0).toBeLessThanOrEqual(3);
  });

  it("输入脚本走原生 setter 并回读比对（React 受控组件）", () => {
    const registry = new RefRegistry();
    registry.reset(PAGE);
    const resolved = resolveTarget(registry, "e3");
    if (!resolved.ok) throw new Error("解析失败");
    const script = buildTypeScript(resolved, "Loopsoar");
    expect(script).toContain("Object.getOwnPropertyDescriptor");
    expect(script).toContain("HTMLInputElement.prototype");
    expect(script).toContain("HTMLTextAreaElement.prototype");
    expect(script).toContain("desc.set.call(el, TEXT)");
    expect(script).toContain("InputEvent");
    expect(script).toContain("if (actual !== TEXT)");
    expect(script).toContain('"Loopsoar"');
    expect(() => new Function(script)).not.toThrow();
  });

  it("输入被受控组件回滚 → 错误里带当前值", async () => {
    const registry = new RefRegistry();
    registry.reset(PAGE);
    const result = await performType(registry, "e3", "Loopsoar", async () => ({
      ok: false,
      code: "TYPE_NOT_EFFECTIVE",
      actual: "旧值",
    }));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("输入未生效");
    expect(result.message).toContain("旧值");
    expect(result.actualValue).toBe("旧值");
  });

  it("text= 不支持输入（提示改用 #eN）", async () => {
    const registry = new RefRegistry();
    registry.reset(PAGE);
    const result = await performType(registry, "text=搜索", "x", async () => ({ ok: true }));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("#eN");
  });
});

describe("WebContentsView 适配器：注册表生命周期", () => {
  it("快照重建注册表、代数递增，导航后重新快照生成新句柄", async () => {
    const ctx = fakeView();
    const adapter = createWebContentsViewAdapter({ view: ctx.view });
    const first = await adapter.snapshot();
    expect(first.snapshotGen).toBe(1);
    expect(first.elements.map((el) => el.ref)).toEqual(["e1", "e2", "e3", "e4", "e5"]);
    expect(first.tabToken).toBeTruthy();
    expect(first.elementTotal).toBe(PAGE.length);

    const second = await adapter.snapshot();
    expect(second.snapshotGen).toBe(2);

    // 主框架导航 → 旧注册表失效；下一次快照重建并递增代数
    ctx.handlers.get("did-navigate")?.({}, "https://example.com/next");
    const third = await adapter.snapshot();
    expect(third.snapshotGen).toBe(3);
  });

  it("精确文本句柄：click 脚本按文本消歧", async () => {
    const registry = new RefRegistry();
    registry.reset(PAGE);
    const scripts: string[] = [];
    const result = await performClick(registry, "e4", async (script) => {
      scripts.push(script);
      return { ok: true };
    });
    expect(result.ok).toBe(true);
    expect(scripts.at(-1)).toContain("exactText");
    expect(scripts.at(-1)).toContain("提交");
  });
});

describe("点击命中验证（BLOCKED_BY_OVERLAY）", () => {
  it("点击脚本在 el.click() 前用 elementFromPoint 校验中心点归属", () => {
    const registry = new RefRegistry();
    registry.reset(PAGE);
    const resolved = resolveTarget(registry, "e2");
    if (!resolved.ok) throw new Error("解析失败");
    const script = buildClickScript(resolved);
    expect(script).toContain("elementFromPoint");
    expect(script).toContain("hit !== el && !el.contains(hit)");
    expect(script).toContain("BLOCKED_BY_OVERLAY");
    // 命中校验必须发生在 click 之前（顺序断言，防止后来者把校验挪到点后）
    expect(script.indexOf("elementFromPoint")).toBeLessThan(script.indexOf("el.click()"));
    expect(() => new Function(script)).not.toThrow();
  });

  it("被遮挡 → 错误文案带遮挡元素摘要（tag.class + 文本，≤60 字）", async () => {
    const registry = new RefRegistry();
    registry.reset(PAGE);
    const result = await performClick(registry, "e4", async () => ({
      ok: false,
      code: "BLOCKED_BY_OVERLAY",
      blocker: { tag: "div", className: "modal-mask", text: "登录弹窗" },
    }));
    expect(result.ok).toBe(false);
    expect(result.code).toBe("BLOCKED_BY_OVERLAY");
    expect(result.message).toContain("[BLOCKED_BY_OVERLAY]");
    expect(result.message).toContain('div.modal-mask "登录弹窗"');
    expect(result.message).toContain("先关闭浮层");
    expect(result.blocker).toBe('div.modal-mask "登录弹窗"');
    expect((result.blocker ?? "").length).toBeLessThanOrEqual(60);
  });
});

describe("按键 / 下拉 / 悬停脚本", () => {
  it("按键白名单：命名键与单个可见字符通过，功能键/组合键拒绝", () => {
    for (const key of NAMED_KEYS) expect(isSupportedKey(key)).toBe(true);
    expect(isSupportedKey("a")).toBe(true);
    expect(isSupportedKey("1")).toBe(true);
    expect(isSupportedKey("/")).toBe(true);
    expect(isSupportedKey(" ")).toBe(true);
    expect(isSupportedKey("F1")).toBe(false);
    expect(isSupportedKey("Control")).toBe(false);
    expect(isSupportedKey("Shift+A")).toBe(false);
    expect(isSupportedKey("")).toBe(false);
    expect(keyCodeOf("Enter")).toBe("Enter");
    expect(keyCodeOf("a")).toBe("KeyA");
    expect(keyCodeOf("7")).toBe("Digit7");
  });

  it("按键脚本：keydown/keypress/keyup 齐全，Enter 有 requestSubmit 兜底，且是合法 JS", () => {
    const registry = new RefRegistry();
    registry.reset(PAGE);
    const resolved = resolveTarget(registry, "e3");
    if (!resolved.ok) throw new Error("解析失败");
    const script = buildPressKeyScript(resolved, "Enter");
    expect(script).toContain("'keydown'");
    expect(script).toContain("'keypress'");
    expect(script).toContain("'keyup'");
    expect(script).toContain("requestSubmit");
    expect(script).toContain('"Enter"');
    expect(script).toContain("input[name=q]");
    expect(() => new Function(script)).not.toThrow();
    // 无 target：发到当前焦点/body，不注入定位代码
    const bare = buildPressKeyScript(null, "Escape");
    expect(bare).toContain("const el = null;");
    expect(bare).toContain("document.activeElement");
    expect(() => new Function(bare)).not.toThrow();
  });

  it("下拉脚本：原生 setter + input/change + selectedOptions 回读，且是合法 JS", () => {
    const registry = new RefRegistry();
    registry.reset(PAGE);
    const resolved = resolveTarget(registry, "e2");
    if (!resolved.ok) throw new Error("解析失败");
    const script = buildSelectScript(resolved, ["北京", "上海"]);
    expect(script).toContain("HTMLSelectElement.prototype");
    expect(script).toContain("desc.set.call(el");
    expect(script).toContain("new Event('input'");
    expect(script).toContain("new Event('change'");
    expect(script).toContain("selectedOptions");
    expect(script).toContain("SELECT_NOT_EFFECTIVE");
    expect(script).toContain('"北京"');
    expect(() => new Function(script)).not.toThrow();
  });

  it("悬停脚本：五个事件齐全、over 冒泡 / enter 不冒泡，且是合法 JS", () => {
    const registry = new RefRegistry();
    registry.reset(PAGE);
    const resolved = resolveTarget(registry, "e2");
    if (!resolved.ok) throw new Error("解析失败");
    const script = buildHoverScript(resolved);
    for (const type of ["pointerover", "pointerenter", "mouseover", "mouseenter", "mousemove"]) {
      expect(script).toContain(`'${type}'`);
    }
    expect(script).toContain("pointer('pointerover', true)");
    expect(script).toContain("pointer('pointerenter', false)");
    expect(script).toContain("mouse('mouseenter', false)");
    expect(() => new Function(script)).not.toThrow();
  });

  it("performPressKey：回传实际路径（含 requestSubmit 兜底）", async () => {
    const registry = new RefRegistry();
    registry.reset(PAGE);
    const result = await performPressKey(registry, "e3", "Enter", async () => ({
      ok: true,
      path: "keydown+keypress+keyup+requestSubmit 兜底",
    }));
    expect(result.ok).toBe(true);
    expect(result.label).toContain("搜索");
    expect(result.detail).toContain("requestSubmit 兜底");
  });

  it("performSelect：回传选中项；performHover：回传派发事件数", async () => {
    const registry = new RefRegistry();
    registry.reset(PAGE);
    const selected = await performSelect(registry, "e2", ["北京"], async () => ({ ok: true, selected: ["北京"] }));
    expect(selected.ok).toBe(true);
    expect(selected.detail).toContain("已选中：北京");
    const hovered = await performHover(registry, "e2", async () => ({
      ok: true,
      events: ["pointerover", "pointerenter", "mouseover", "mouseenter", "mousemove"],
    }));
    expect(hovered.ok).toBe(true);
    expect(hovered.detail).toContain("派发 5 个事件");
  });

  it("performSelect：选项不存在 → OPTION_NOT_FOUND + 可用选项", async () => {
    const registry = new RefRegistry();
    registry.reset(PAGE);
    const result = await performSelect(registry, "e2", ["广州"], async () => ({
      ok: false,
      code: "OPTION_NOT_FOUND",
      missing: ["广州"],
      options: ["bj", "sh"],
    }));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("[OPTION_NOT_FOUND]");
    expect(result.message).toContain("广州");
    expect(result.message).toContain("bj；sh");
  });
});
