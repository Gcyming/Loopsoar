/**
 * 浏览器工具集：注册/权限声明/快照格式化/ref 动作（假 BrowserHost，无 electron）。
 * 假件的快照来自真实的 RefRegistry（与适配器同一套 ref 分配），因此 ref 解析链路是真跑的；
 * 假宿主带 activeTabId/getTab，动作后的状态行（URL/标题/就绪/导航）也是真算的。
 */
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { registerBrowserTools } from "../../packages/shell/src/main/browserTools.ts";
import { createTabRegistry, type RawBrowserElement } from "../../packages/shell/src/browserAdapter/refs.ts";

/** 5 个元素的假页面：覆盖 link / textbox / button / heading / navigation 五种形态。 */
const PAGE: RawBrowserElement[] = [
  { tag: "nav", role: "navigation", name: "主导航", selector: "nav", selectorWhy: "path" },
  { tag: "a", role: "link", name: "登录", selector: "#login", selectorWhy: "id", href: "/login" },
  { tag: "input", role: "textbox", name: "搜索", selector: "#search", selectorWhy: "id", type: "text", value: "" },
  { tag: "button", role: "button", name: "提交", selector: "#submit", selectorWhy: "id", disabled: true },
  { tag: "h1", role: "heading", name: "欢迎", selector: "h1", selectorWhy: "path" },
];

interface FakePage {
  url: string;
  title: string;
  loading: boolean;
}

function makeRegistry(page: RawBrowserElement[] = PAGE, scriptResult: unknown = { ok: true }) {
  const registry = new ToolRegistry();
  const calls: string[] = [];
  const scripts: string[] = [];
  const executed: { script: string; tabId?: string }[] = [];
  const tab = createTabRegistry();
  const state: FakePage = { url: "https://example.com/", title: "示例页", loading: false };
  /** 加载计时：命中 0 后自动落定为「已就绪」（避免测试真的等 1.5s）。 */
  const loadingPlan = { ticks: 0 };
  let scriptHook: ((script: string) => void) | null = null;
  let gen = 0;

  const host = {
    activeTabId: (): string => "tab-1",
    getTab: (_sessionId?: string, tabId?: string) => {
      if (loadingPlan.ticks > 0) {
        loadingPlan.ticks -= 1;
        state.loading = true;
      } else if (loadingPlan.ticks === 0 && state.loading) {
        state.loading = false;
      }
      return {
        id: tabId ?? "tab-1",
        url: state.url,
        title: state.title,
        active: true,
        canBack: false,
        canForward: false,
        loading: state.loading,
        loadFailure: null,
      };
    },
    snapshot: async () => {
      gen += 1;
      const elements = tab.registry.reset(page);
      return {
        url: state.url,
        title: state.title,
        text: "正文内容 ABC",
        elements,
        snapshotGen: gen,
        elementTotal: page.length,
        tabToken: tab.token,
        tabId: "tab-1",
      };
    },
    navigate: async (url: string) => {
      calls.push("navigate:" + url);
      state.url = url;
      state.title = "新页面";
      return { ok: true, url, tabId: "tab-1" };
    },
    executeScript: async (script: string, _sessionId?: string, tabId?: string) => {
      calls.push("script");
      scripts.push(script);
      executed.push({ script, tabId });
      if (scriptHook) scriptHook(script);
      // 「只定位不点击」脚本：真实实现回目标中心坐标（getBoundingClientRect 的视口坐标）。
      if (script.includes("loopsoar:target-point")) return { ok: true, x: 120, y: 90, width: 40, height: 20 };
      return scriptResult;
    },
  };
  registerBrowserTools(registry, () => host as never);
  return {
    registry,
    calls,
    scripts,
    executed,
    state,
    loadingPlan,
    setScriptHook: (hook: ((script: string) => void) | null) => {
      scriptHook = hook;
    },
  };
}

/** 每个用例用独立 sessionId：快照令牌是会话级状态，避免用例互相串。 */
function run(registry: ToolRegistry, name: string, params: unknown, sessionId: string) {
  return registry.get(name)!.execute({ agentId: "a", params, platform: {}, sessionId });
}

describe("浏览器工具集", () => {
  it("注册了核心浏览器工具并声明正确权限类别", () => {
    const { registry } = makeRegistry();
    const names = registry.list().map((t) => t.name);
    for (const name of [
      "browser_snapshot",
      "browser_navigate",
      "browser_click",
      "browser_type",
      "browser_scroll",
      "browser_tabs",
      "browser_back",
      "browser_forward",
      "browser_reload",
      "browser_press_key",
      "browser_select",
      "browser_hover",
      "web_fetch",
    ]) {
      expect(names).toContain(name);
    }
    // 只读探测走 read（页面快照/截图/等待永不需要确认）
    for (const name of ["browser_snapshot", "browser_screenshot", "browser_wait"]) {
      const permissions = registry.get(name)!.permissions;
      expect(permissions.read, `${name} 应声明 read`).toBe(true);
      expect(permissions.browser, `${name} 是只读探测，不应声明 browser`).toBeFalsy();
    }
    // 动作型工具统一声明 browser（策略档默认 allow；沙箱层仍按 network/L4，见 services 的 kindOfTool）
    for (const name of [
      "browser_navigate",
      "browser_click",
      "browser_type",
      "browser_scroll",
      "browser_tabs",
      "browser_back",
      "browser_forward",
      "browser_reload",
      "browser_press_key",
      "browser_select",
      "browser_hover",
    ]) {
      const permissions = registry.get(name)!.permissions;
      expect(permissions.browser, `${name} 应声明 browser 权限`).toBe(true);
      expect(permissions.network, `${name} 不应再声明 network（browser 比 network 更具体）`).toBeFalsy();
    }
    // web_fetch 不是浏览器操控：直接抓 URL 文本、不开标签页，语义留在 network 档（默认每次确认）
    expect(registry.get("web_fetch")!.permissions.network).toBe(true);
    expect(registry.get("web_fetch")!.permissions.browser).toBeFalsy();
  });

  it("browser_snapshot：首行代数 + URL + 标题，正文与语义元素行分块", async () => {
    const { registry } = makeRegistry();
    const result = await run(registry, "browser_snapshot", {}, "fmt-1");
    expect(result.ok).toBe(true);
    expect(result.content.split("\n")[0]).toBe("[快照 #1 | https://example.com/ | 示例页]");
    expect(result.content).toContain("正文内容 ABC");
    expect(result.content).toContain("可交互元素（共 5 个");
    expect(result.content).toContain('[#e1] navigation "主导航"');
    expect(result.content).toContain('[#e2] link "登录" → /login');
    expect(result.content).toContain('[#e3] textbox "搜索" (value="")');
    expect(result.content).toContain('[#e4] button "提交" (disabled)');
    expect(result.content).toContain('[#e5] heading "欢迎"');
  });

  it("browser_snapshot：代数单调递增", async () => {
    const { registry } = makeRegistry();
    const first = await run(registry, "browser_snapshot", {}, "gen-1");
    const second = await run(registry, "browser_snapshot", {}, "gen-1");
    expect(first.content.split("\n")[0]).toContain("[快照 #1 |");
    expect(second.content.split("\n")[0]).toContain("[快照 #2 |");
  });

  it("browser_snapshot：元素超过 80 个时截断并提示总数", async () => {
    const many: RawBrowserElement[] = Array.from({ length: 85 }, (_, i) => ({
      tag: "button",
      role: "button",
      name: "按钮" + (i + 1),
      selector: "#b" + (i + 1),
      selectorWhy: "id",
    }));
    const { registry } = makeRegistry(many);
    const result = await run(registry, "browser_snapshot", {}, "many-1");
    expect(result.content).toContain("共 85 个");
    expect(result.content).toContain("已省略 5 个");
    const elementLines = result.content.split("\n").filter((line) => line.startsWith("[#e"));
    expect(elementLines).toHaveLength(80);
  });

  it("browser_click：ref 解析成注册表选择器（#eN → 句柄）", async () => {
    const { registry, scripts, executed } = makeRegistry();
    await run(registry, "browser_snapshot", {}, "click-ref");
    const click = await run(registry, "browser_click", { target: "e3" }, "click-ref");
    expect(click.ok).toBe(true);
    expect(click.content).toContain('已点击 [#e3] textbox "搜索"');
    expect(scripts[scripts.length - 1]).toContain("#search");
    expect(executed[0].tabId).toBe("tab-1");
  });

  it("browser_click：没有快照就传 ref → STALE_REF", async () => {
    const { registry } = makeRegistry();
    const click = await run(registry, "browser_click", { target: "e1" }, "stale-1");
    expect(click.ok).toBe(false);
    expect(click.content).toContain("[STALE_REF]");
    expect(click.content).toContain("browser_snapshot");
  });

  it("browser_click：注册表有 ref 但页面查不到 → ELEMENT_NOT_FOUND + 候选", async () => {
    const { registry } = makeRegistry(PAGE, { ok: false, code: "ELEMENT_NOT_FOUND" });
    await run(registry, "browser_snapshot", {}, "miss-1");
    const click = await run(registry, "browser_click", { target: "e4" }, "miss-1");
    expect(click.ok).toBe(false);
    expect(click.content).toContain("[ELEMENT_NOT_FOUND]");
    expect(click.content).toContain("候选");
    expect(click.content).toContain("#e4");
  });

  it("browser_click：点击被浮层遮挡 → BLOCKED_BY_OVERLAY + 遮挡元素摘要", async () => {
    const { registry } = makeRegistry(PAGE, {
      ok: false,
      code: "BLOCKED_BY_OVERLAY",
      blocker: { tag: "div", className: "modal-mask", text: "登录弹窗" },
    });
    await run(registry, "browser_snapshot", {}, "blocked-1");
    const click = await run(registry, "browser_click", { target: "e4" }, "blocked-1");
    expect(click.ok).toBe(false);
    expect(click.content).toContain("[BLOCKED_BY_OVERLAY]");
    expect(click.content).toContain('div.modal-mask "登录弹窗"');
    expect(click.content).toContain("先关闭浮层");
  });

  it("browser_click：CSS 与 text= 路径回归不破", async () => {
    const { registry, scripts } = makeRegistry();
    await run(registry, "browser_snapshot", {}, "reg-1");
    const byCss = await run(registry, "browser_click", { target: "#submit" }, "reg-1");
    expect(byCss.ok).toBe(true);
    expect(scripts[scripts.length - 1]).toContain("#submit");
    const byText = await run(registry, "browser_click", { target: "text=登录" }, "reg-1");
    expect(byText.ok).toBe(true);
    expect(byText.content).toContain("text=登录");
    expect(scripts[scripts.length - 1]).toContain('const KIND = "text"');
  });

  it("browser_type：ref + 原生 setter 脚本（含回读比对）", async () => {
    const { registry, scripts } = makeRegistry();
    await run(registry, "browser_snapshot", {}, "type-1");
    const typed = await run(registry, "browser_type", { target: "e3", text: "Loopsoar" }, "type-1");
    expect(typed.ok).toBe(true);
    expect(typed.content).toContain("已输入 [#e3]");
    expect(scripts[scripts.length - 1]).toContain("Object.getOwnPropertyDescriptor");
    expect(scripts[scripts.length - 1]).toContain("HTMLInputElement.prototype");
    expect(scripts[scripts.length - 1]).toContain("if (actual !== TEXT)");
  });

  it("browser_type：页面回读不一致 → 输入未生效 + 当前值", async () => {
    const { registry } = makeRegistry(PAGE, { ok: false, code: "TYPE_NOT_EFFECTIVE", actual: "旧值" });
    await run(registry, "browser_snapshot", {}, "type-2");
    const typed = await run(registry, "browser_type", { target: "e3", text: "Loopsoar" }, "type-2");
    expect(typed.ok).toBe(false);
    expect(typed.content).toContain("输入未生效");
    expect(typed.content).toContain("旧值");
  });

  it("browser_navigate / browser_click：调用宿主并返回可读结果", async () => {
    const { registry, calls } = makeRegistry();
    const nav = await run(registry, "browser_navigate", { url: "https://example.com/x" }, "nav-1");
    expect(nav.ok).toBe(true);
    expect(calls.some((c) => c.startsWith("navigate:https://example.com/x"))).toBe(true);
    expect(nav.content).toContain("[状态]");

    const click = await run(registry, "browser_click", { target: "text=登录" }, "nav-1");
    expect(click.ok).toBe(true);
    // 点击 = 定位脚本 + 回退点击脚本（假视图不支持 sendInputEvent，走 performClick 兜底）
    expect(calls.filter((c) => c === "script").length).toBe(2);
  });

  it("动作后状态行：未导航 + 已就绪（URL/标题来自宿主 getTab）", async () => {
    const { registry } = makeRegistry();
    await run(registry, "browser_snapshot", {}, "status-1");
    const click = await run(registry, "browser_click", { target: "e3" }, "status-1");
    expect(click.ok).toBe(true);
    expect(click.content).toContain("[状态] ✓ 已点击 [#e3] textbox \"搜索\"");
    expect(click.content).toContain("URL https://example.com/");
    expect(click.content).toContain("标题 示例页");
    expect(click.content).toContain("已就绪");
    expect(click.content).toContain("未发生导航");
    expect(click.content).not.toContain("页面已变化");
  });

  it("动作后状态行：点击触发导航 → 发生导航 + 提示可重新快照", async () => {
    const { registry, state, setScriptHook } = makeRegistry();
    await run(registry, "browser_snapshot", {}, "status-nav");
    setScriptHook(() => {
      state.url = "https://example.com/next";
      state.title = "下一页";
    });
    const click = await run(registry, "browser_click", { target: "e3" }, "status-nav");
    expect(click.ok).toBe(true);
    expect(click.content).toContain("URL https://example.com/next");
    expect(click.content).toContain("标题 下一页");
    expect(click.content).toContain("发生导航");
    expect(click.content).toContain("browser_snapshot 查看新页面");
  });

  it("动作后状态行：加载未落定 → 仍在加载（不阻塞超过 1.5s 上限）", async () => {
    const { registry, state, loadingPlan, setScriptHook } = makeRegistry();
    await run(registry, "browser_snapshot", {}, "status-loading");
    setScriptHook(() => {
      state.loading = true;
      loadingPlan.ticks = 200;
    });
    const startedAt = Date.now();
    const click = await run(registry, "browser_click", { target: "e3" }, "status-loading");
    const elapsed = Date.now() - startedAt;
    expect(click.ok).toBe(true);
    expect(click.content).toContain("仍在加载");
    expect(click.content).toContain("发生导航");
    expect(elapsed).toBeLessThan(4000);
  });
});
