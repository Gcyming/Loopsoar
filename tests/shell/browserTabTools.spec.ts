/**
 * 标签/动作扩展工具（Slice D）：browser_tabs / back / forward / reload /
 * press_key / select / hover，以及「标签级 ref 绑定」的跨标签失效。
 *
 * 假宿主是多标签的：listTabs/activeTabId/getTab/selectTab/closeTab/newTab 都是真状态，
 * 快照令牌来自真实的 RefRegistry（每个标签一份），所以 ref 解析与失效判定都是真跑的。
 */
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { registerBrowserTools } from "../../packages/shell/src/main/browserTools.ts";
import { createTabRegistry, type RawBrowserElement } from "../../packages/shell/src/browserAdapter/refs.ts";

/** 每页都长这样：一个按钮 + 一个下拉框（够 press_key / select / hover 用）。 */
const PAGE: RawBrowserElement[] = [
  { tag: "button", role: "button", name: "提交", selector: "#submit", selectorWhy: "id" },
  { tag: "select", role: "combobox", name: "城市", selector: "#city", selectorWhy: "id", type: "select-one", value: "bj" },
];

interface FakeTab {
  id: string;
  url: string;
  title: string;
  loading: boolean;
}

/** 页面脚本的假回执：按脚本特征回不同的成功形状（与真实脚本的返回契约一致）。 */
function scriptResultFor(script: string): unknown {
  if (script.includes("pointerover")) {
    return { ok: true, events: ["pointerover", "pointerenter", "mouseover", "mouseenter", "mousemove"] };
  }
  if (script.includes("const VALUES")) return { ok: true, selected: ["北京"] };
  if (script.includes("const KEY")) return { ok: true, path: "keydown+keypress+keyup" };
  return { ok: true };
}

function makeHost(initial: FakeTab[], overrides: Record<string, unknown> = {}) {
  const registry = new ToolRegistry();
  const tabs: FakeTab[] = initial.map((tab) => ({ ...tab }));
  let activeId: string | null = tabs[0]?.id ?? null;
  let seq = 100;
  const calls: string[] = [];
  const scripts: { script: string; tabId?: string }[] = [];
  const registries = new Map<string, { token: string; registry: ReturnType<typeof createTabRegistry>["registry"] }>();
  const meta = { lastNew: null as { url?: string; sessionId?: string } | null, lastSelect: null as { tabId: string; sessionId?: string } | null, lastClose: null as { tabId: string; sessionId?: string } | null, lastBack: null as { tabId?: string; sessionId?: string } | null, results: {} as Record<string, unknown> };

  const registryOf = (id: string) => {
    let entry = registries.get(id);
    if (!entry) {
      entry = createTabRegistry();
      registries.set(id, entry);
    }
    return entry;
  };
  const tabOf = (id?: string): FakeTab | null => tabs.find((tab) => tab.id === (id ?? activeId)) ?? null;
  const stateOf = (tab: FakeTab) => ({
    id: tab.id,
    url: tab.url,
    title: tab.title,
    active: tab.id === activeId,
    canBack: false,
    canForward: false,
    loading: tab.loading,
    loadFailure: null,
  });

  const host = {
    activeTabId: (_sessionId?: string) => activeId,
    listTabs: (_sessionId?: string) => tabs.map(stateOf),
    getTab: (_sessionId?: string, tabId?: string) => {
      const tab = tabOf(tabId);
      return tab ? stateOf(tab) : null;
    },
    selectTab: (tabId: string, sessionId?: string) => {
      calls.push("select:" + tabId);
      meta.lastSelect = { tabId, sessionId };
      if (!tabOf(tabId)) return false;
      activeId = tabId;
      return true;
    },
    closeTab: async (tabId: string, sessionId?: string) => {
      calls.push("close:" + tabId);
      meta.lastClose = { tabId, sessionId };
      const index = tabs.findIndex((tab) => tab.id === tabId);
      if (index < 0) return false;
      tabs.splice(index, 1);
      if (activeId === tabId) activeId = tabs[0]?.id ?? null;
      return true;
    },
    newTab: async (url?: string, sessionId?: string) => {
      calls.push("new:" + (url ?? ""));
      meta.lastNew = { url, sessionId };
      seq += 1;
      const id = "tab-" + seq;
      tabs.push({ id, url: url ?? "", title: url ? "新页面" : "新标签页", loading: false });
      activeId = id;
      return { tabId: id, ok: true, ...(url ? { url } : {}) };
    },
    goBack: async (tabId?: string, sessionId?: string) => {
      calls.push("back:" + (tabId ?? ""));
      meta.lastBack = { tabId, sessionId };
      return { ok: true, url: "https://a.example/prev" };
    },
    goForward: async (tabId?: string) => {
      calls.push("forward:" + (tabId ?? ""));
      return { ok: true, url: "https://a.example/next" };
    },
    reload: async (tabId?: string) => {
      calls.push("reload:" + (tabId ?? ""));
      return { ok: true, url: tabOf(tabId)?.url ?? "" };
    },
    snapshot: async () => {
      const id = activeId;
      if (!id) return null;
      const entry = registryOf(id);
      const elements = entry.registry.reset(PAGE);
      const tab = tabOf(id)!;
      return {
        url: tab.url,
        title: tab.title,
        text: "正文",
        elements,
        snapshotGen: entry.registry.gen,
        elementTotal: PAGE.length,
        tabToken: entry.token,
        tabId: id,
      };
    },
    executeScript: async (script: string, _sessionId?: string, tabId?: string) => {
      scripts.push({ script, tabId });
      if (meta.results[script.slice(0, 12)]) return meta.results[script.slice(0, 12)];
      return scriptResultFor(script);
    },
  };

  registerBrowserTools(registry, () => Object.assign({}, host, overrides) as never);
  return { registry, tabs, calls, scripts, meta, activeId: () => activeId };
}

function makeRegistry(
  initial: FakeTab[] = [
    { id: "tab-1", url: "https://a.example/", title: "A 页", loading: false },
    { id: "tab-2", url: "https://b.example/", title: "B 页", loading: false },
  ],
  overrides: Record<string, unknown> = {},
) {
  return makeHost(initial, overrides);
}

function run(registry: ToolRegistry, name: string, params: unknown, sessionId: string) {
  return registry.get(name)!.execute({ agentId: "a", params, platform: {}, sessionId });
}

describe("browser_tabs · 列表/新建/切换/关闭", () => {
  it("list：返回序号/tabId/标题/URL/活动标记 + 状态行", async () => {
    const { registry, calls } = makeRegistry();
    const result = await run(registry, "browser_tabs", { action: "list" }, "tabs-list");
    expect(result.ok).toBe(true);
    expect(result.content).toContain("标签（2 个，活动 tab-1）：");
    expect(result.content).toContain("1. tab-1 ✓ 活动 A 页 https://a.example/");
    expect(result.content).toContain("2. tab-2 B 页 https://b.example/");
    expect(result.content).toContain("[状态] ✓ 标签列表");
    expect(calls).toEqual([]);
  });

  it("new：带 url 时透传 url + sessionId，并自动切到新标签", async () => {
    const { registry, meta, activeId } = makeRegistry();
    const result = await run(registry, "browser_tabs", { action: "new", url: "https://c.example/" }, "tabs-new");
    expect(result.ok).toBe(true);
    expect(meta.lastNew).toEqual({ url: "https://c.example/", sessionId: "tabs-new" });
    expect(activeId()).toBe("tab-101");
    expect(result.content).toContain("已新建标签 tab-101");
    expect(result.content).toContain("活动 tab-101");
    expect(result.content).toContain("[状态]");
  });

  it("new：不带 url → 空白标签，状态行标（空白）", async () => {
    const { registry } = makeRegistry();
    const result = await run(registry, "browser_tabs", { action: "new" }, "tabs-new-blank");
    expect(result.ok).toBe(true);
    expect(result.content).toContain("（空白标签）");
    expect(result.content).toContain("URL （空白）");
    // 空白标签没有发生导航（带 url 的新标签才算）
    expect(result.content).toContain("未发生导航");
  });

  it("select：透传 tabId + sessionId，活动标记随切换变化", async () => {
    const { registry, meta } = makeRegistry();
    const result = await run(registry, "browser_tabs", { action: "select", tabId: "tab-2" }, "tabs-select");
    expect(result.ok).toBe(true);
    expect(meta.lastSelect).toEqual({ tabId: "tab-2", sessionId: "tabs-select" });
    expect(result.content).toContain("已切换到标签 tab-2");
    expect(result.content).toContain("活动 tab-2");
  });

  it("select：标签不存在 → 可行动错误", async () => {
    const { registry } = makeRegistry();
    const result = await run(registry, "browser_tabs", { action: "select", tabId: "tab-9" }, "tabs-select-miss");
    expect(result.ok).toBe(false);
    expect(result.content).toContain("[错误] 标签不存在：tab-9");
    expect(result.content).toContain("action=list");
  });

  it("close：关非最后一页；关最后一页只报「已关闭」，不退出应用", async () => {
    const { registry, meta, tabs } = makeRegistry();
    const first = await run(registry, "browser_tabs", { action: "close", tabId: "tab-2" }, "tabs-close");
    expect(first.ok).toBe(true);
    expect(meta.lastClose).toEqual({ tabId: "tab-2", sessionId: "tabs-close" });
    expect(first.content).toContain("已关闭标签 tab-2");

    const second = await run(registry, "browser_tabs", { action: "close", tabId: "tab-1" }, "tabs-close");
    expect(second.ok).toBe(true);
    expect(tabs).toHaveLength(0);
    expect(second.content).toContain("已关闭标签 tab-1");
    expect(second.content).toContain("只关闭网页，不退出应用");
  });

  it("缺少 action / select 缺少 tabId → 明确报错", async () => {
    const { registry } = makeRegistry();
    const noAction = await run(registry, "browser_tabs", {}, "tabs-bad-1");
    expect(noAction.ok).toBe(false);
    expect(noAction.content).toContain("缺少 action");
    const noTab = await run(registry, "browser_tabs", { action: "select" }, "tabs-bad-2");
    expect(noTab.ok).toBe(false);
    expect(noTab.content).toContain("需要 tabId");
  });
});

describe("标签级 ref 绑定（跨标签失效）", () => {
  it("在 tab-1 快照后切到 tab-2，ref 点击返回 STALE_REF（说明两个标签）", async () => {
    const { registry } = makeRegistry();
    await run(registry, "browser_snapshot", {}, "cross-1");
    await run(registry, "browser_tabs", { action: "select", tabId: "tab-2" }, "cross-1");

    const stale = await run(registry, "browser_click", { target: "e1" }, "cross-1");
    expect(stale.ok).toBe(false);
    expect(stale.content).toContain("[STALE_REF]");
    expect(stale.content).toContain("引用来自标签 tab-1，当前操作标签是 tab-2");
    expect(stale.content).toContain("browser_snapshot");
  });

  it("在目标标签重新快照后，同一 ref 解析到该标签的注册表并落到该标签执行", async () => {
    const { registry, scripts } = makeRegistry();
    await run(registry, "browser_snapshot", {}, "cross-2");
    await run(registry, "browser_tabs", { action: "select", tabId: "tab-2" }, "cross-2");
    await run(registry, "browser_snapshot", {}, "cross-2");

    const click = await run(registry, "browser_click", { target: "e1" }, "cross-2");
    expect(click.ok).toBe(true);
    expect(scripts.at(-1)?.tabId).toBe("tab-2");
    expect(scripts.at(-1)?.script).toContain("#submit");
  });

  it("CSS 选择器不参与跨标签校验（不需要注册表）", async () => {
    const { registry } = makeRegistry();
    await run(registry, "browser_snapshot", {}, "cross-3");
    await run(registry, "browser_tabs", { action: "select", tabId: "tab-2" }, "cross-3");
    const click = await run(registry, "browser_click", { target: "#submit" }, "cross-3");
    expect(click.ok).toBe(true);
  });

  it("关闭标签会丢弃该标签的令牌（关掉再点 ref → STALE_REF）", async () => {
    const { registry } = makeRegistry();
    await run(registry, "browser_snapshot", {}, "cross-4");
    await run(registry, "browser_tabs", { action: "close", tabId: "tab-1" }, "cross-4");
    const stale = await run(registry, "browser_click", { target: "e1" }, "cross-4");
    expect(stale.ok).toBe(false);
    expect(stale.content).toContain("[STALE_REF]");
  });
});

describe("browser_back / forward / reload", () => {
  it("back：透传 tabId + sessionId，返回 URL 与状态行", async () => {
    const { registry, meta } = makeRegistry();
    const result = await run(registry, "browser_back", {}, "nav-back");
    expect(result.ok).toBe(true);
    expect(meta.lastBack).toEqual({ tabId: "tab-1", sessionId: "nav-back" });
    expect(result.content).toContain("已后退 https://a.example/prev");
    expect(result.content).toContain("[状态]");
  });

  it("back：指定 tabId 时按该标签执行", async () => {
    const { registry, meta } = makeRegistry();
    await run(registry, "browser_back", { tabId: "tab-2" }, "nav-back-2");
    expect(meta.lastBack?.tabId).toBe("tab-2");
  });

  it("forward / reload：各自返回 URL", async () => {
    const { registry, calls } = makeRegistry();
    const forward = await run(registry, "browser_forward", {}, "nav-fwd");
    expect(forward.ok).toBe(true);
    expect(forward.content).toContain("已前进 https://a.example/next");
    const reload = await run(registry, "browser_reload", {}, "nav-fwd");
    expect(reload.ok).toBe(true);
    expect(reload.content).toContain("已刷新");
    expect(calls).toContain("reload:tab-1");
  });

  it("没有可后退历史 → 错误文案带原因与下一步", async () => {
    const { registry } = makeRegistry(undefined, {
      goBack: async () => ({ ok: false, error: "没有可后退的历史" }),
    });
    const result = await run(registry, "browser_back", {}, "nav-back-miss");
    expect(result.ok).toBe(false);
    expect(result.content).toContain("[错误] 后退失败：没有可后退的历史");
    expect(result.content).toContain("browser_tabs action=list");
  });
});

describe("browser_press_key", () => {
  it("白名单拒绝非法键（F1 / 组合键 / 空串）", async () => {
    const { registry } = makeRegistry();
    for (const key of ["F1", "Control", "Shift+A", ""]) {
      const result = await run(registry, "browser_press_key", { key }, "key-bad");
      expect(result.ok).toBe(false);
      expect(result.content).toContain("[INVALID_KEY]");
    }
    expect((await run(registry, "browser_press_key", { key: "F1" }, "key-bad")).content).toContain("Enter/Tab/Escape");
  });

  it("合法键 + target：脚本含 keydown/keypress/keyup 与 requestSubmit 兜底，文案给实际路径", async () => {
    const { registry, scripts } = makeRegistry();
    await run(registry, "browser_snapshot", {}, "key-ok");
    const result = await run(registry, "browser_press_key", { key: "Enter", target: "e1" }, "key-ok");
    expect(result.ok).toBe(true);
    const script = scripts.at(-1)!.script;
    expect(script).toContain("#submit");
    expect(script).toContain("'keydown'");
    expect(script).toContain("'keypress'");
    expect(script).toContain("'keyup'");
    expect(script).toContain("requestSubmit");
    expect(script).toContain("keydown+keypress+keyup");
    expect(result.content).toContain("已按键 Enter");
    expect(result.content).toContain("路径：keydown+keypress+keyup");
  });

  it("不带 target：发到当前焦点/body（脚本不注入 querySelector 定位）", async () => {
    const { registry, scripts } = makeRegistry();
    const result = await run(registry, "browser_press_key", { key: "Escape" }, "key-focus");
    expect(result.ok).toBe(true);
    const script = scripts.at(-1)!.script;
    expect(script).toContain("const el = null;");
    expect(script).toContain("document.activeElement");
    expect(result.content).toContain("当前焦点/body");
  });
});

describe("browser_select", () => {
  it("原生 setter + input/change + selectedOptions 回读校验，并回传选中项", async () => {
    const { registry, scripts } = makeRegistry();
    await run(registry, "browser_snapshot", {}, "select-1");
    const result = await run(registry, "browser_select", { target: "e2", values: ["北京"] }, "select-1");
    expect(result.ok).toBe(true);
    const script = scripts.at(-1)!.script;
    expect(script).toContain("#city");
    expect(script).toContain("HTMLSelectElement.prototype");
    expect(script).toContain("selectedOptions");
    expect(script).toContain("new Event('change'");
    expect(result.content).toContain("已选择");
    expect(result.content).toContain("已选中：北京");
  });

  it("回读不一致 → SELECT_NOT_EFFECTIVE + 回读值", async () => {
    const { registry } = makeRegistry(undefined, {
      executeScript: async () => ({ ok: false, code: "SELECT_NOT_EFFECTIVE", actual: "上海" }),
    });
    await run(registry, "browser_snapshot", {}, "select-2");
    const result = await run(registry, "browser_select", { target: "e2", values: ["上海"] }, "select-2");
    expect(result.ok).toBe(false);
    expect(result.content).toContain("[SELECT_NOT_EFFECTIVE]");
    expect(result.content).toContain("上海");
    expect(result.content).toContain("selectedOptions");
  });

  it("目标不是 select → NOT_A_SELECT 可行动错误", async () => {
    const { registry } = makeRegistry(undefined, {
      executeScript: async () => ({ ok: false, code: "NOT_A_SELECT", tag: "input" }),
    });
    await run(registry, "browser_snapshot", {}, "select-4");
    const result = await run(registry, "browser_select", { target: "e1", values: ["北京"] }, "select-4");
    expect(result.ok).toBe(false);
    expect(result.content).toContain("[NOT_A_SELECT]");
    expect(result.content).toContain("browser_type");
  });

  it("缺少 values → 明确报错", async () => {
    const { registry } = makeRegistry();
    const result = await run(registry, "browser_select", { target: "e2" }, "select-3");
    expect(result.ok).toBe(false);
    expect(result.content).toContain("缺少 values");
  });
});

describe("browser_hover", () => {
  it("脚本派发 pointerover/pointerenter/mouseover/mouseenter/mousemove，冒泡按规范", async () => {
    const { registry, scripts } = makeRegistry();
    await run(registry, "browser_snapshot", {}, "hover-1");
    const result = await run(registry, "browser_hover", { target: "e1" }, "hover-1");
    expect(result.ok).toBe(true);
    const script = scripts.at(-1)!.script;
    expect(script).toContain("'pointerover'");
    expect(script).toContain("pointer('pointerover', true)");
    expect(script).toContain("pointer('pointerenter', false)");
    expect(script).toContain("mouse('mouseover', true)");
    expect(script).toContain("mouse('mouseenter', false)");
    expect(script).toContain("scrollIntoView");
    expect(result.content).toContain("派发 5 个事件");
  });

  it("hover 也做跨标签 ref 校验", async () => {
    const { registry } = makeRegistry();
    await run(registry, "browser_snapshot", {}, "hover-2");
    await run(registry, "browser_tabs", { action: "select", tabId: "tab-2" }, "hover-2");
    const result = await run(registry, "browser_hover", { target: "e1" }, "hover-2");
    expect(result.ok).toBe(false);
    expect(result.content).toContain("[STALE_REF]");
  });
});
