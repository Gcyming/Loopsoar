/**
 * 浏览器「看与走」工具：快照、导航、标签管理、前进/后退/刷新、等待。
 *
 * 拆分自 browserTools.ts（行为与文案不变）。这一族都是**不改变页面输入状态**的动作，
 * 除了 browser_tabs close 会丢弃标签级快照令牌——那一步必须顺手清绑定，
 * 否则关闭后重开同 id 标签会复活旧 ref。
 */
import { z } from "zod";
import type { ToolResult } from "loopsoar-core/tools/registry";
import { agentLoopbackAllowed, isLoopbackTarget } from "../browserRequestGuard.js";
import { formatTabList, renderSnapshot } from "../browserFormat.js";
import { activeTabOf, readTab, settleTab, sleep, statusLine, type BrowserToolEnv } from "./context.js";

/** 注册只读/导航类浏览器工具。 */
export function registerNavTools(env: BrowserToolEnv): void {
  env.register({
    name: "browser_snapshot",
    description:
      "读取当前标签页的地址、标题、可见正文与可交互元素（元素以 #eN 编号，可直接用于 browser_click/browser_type；Agent 浏览网页的首选：先快照再决策）。像用户一样操作：搜索/输入框用 browser_type 点进去逐字输入，提交用 browser_press_key（Enter），不要用脚本直接改值或 el.click()。#eN 绑定到标签：切换标签后需在该标签重新快照。密集页面可用 view='skeleton' 先看地标/标题/按钮，再用 root='#eN'（可配 depth）只看某个子树。返回头里的 complete 标明元素是否被截断，source 标明来源：agent-tab=本会话任务页，user-tab=用户全局标签（不是 Agent 打开的页面）",
    permissions: { read: true },
    schema: z.object({
      maxChars: z.number().int().min(200).max(30000).optional(),
      view: z.enum(["full", "skeleton"]).optional(),
      /** 子树下钻：只渲染该 ref 及其后代（父子关系来自同一次快照的真实 DOM 树）。 */
      root: z.string().trim().min(1).max(40).optional(),
      /** 相对 root 的深度上限（1=只看直接子级）；缺省不限。 */
      depth: z.number().int().min(1).max(6).optional(),
    }),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const params = (ctx.params ?? {}) as {
          maxChars?: number;
          view?: "full" | "skeleton";
          root?: string;
          depth?: number;
        };
        const host = env.needHost();
        const snapshot = await host.snapshot(ctx.sessionId);
        if (!snapshot) return { ok: false, content: "[错误] 当前没有打开的网页标签" };
        // 把令牌记到「产生它的标签」上：动作解析 ref 时必须用同一标签的注册表（跨标签 → STALE_REF）
        const tabId = snapshot.tabId ?? activeTabOf(host, ctx.sessionId);
        if (snapshot.tabToken) {
          env.bindings.bind(ctx.sessionId, tabId, snapshot.tabToken);
        }
        // P2-4：只读工具回落到用户全局标签时，必须让模型知道「这不是我打开的任务页」。
        const tabInfo =
          tabId && typeof host.listTabs === "function"
            ? (host.listTabs(ctx.sessionId).find((tab) => tab.id === tabId) ?? null)
            : null;
        // 渲染（完整性 / skeleton / root 子树）统一在 browserFormat：这里只负责取数与上下文。
        return renderSnapshot({
          url: snapshot.url,
          title: snapshot.title,
          text: snapshot.text ?? "",
          elements: snapshot.elements ?? [],
          ...(snapshot.elementTotal !== undefined ? { elementTotal: snapshot.elementTotal } : {}),
          ...(snapshot.snapshotGen !== undefined ? { snapshotGen: snapshot.snapshotGen } : {}),
          agentBound: tabInfo?.agentBound === true,
          view: params.view ?? "full",
          ...(params.maxChars !== undefined ? { maxChars: params.maxChars } : {}),
          ...(params.root ? { root: params.root } : {}),
          ...(params.depth !== undefined ? { depth: params.depth } : {}),
        });
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });
  env.register({
    name: "browser_navigate",
    description: "在当前标签页打开一个 http(s) 网址（等价于用户输入地址回车）；返回地址/标题/加载态状态行",
    permissions: { browser: true },
    schema: z.object({ url: z.string().min(1).max(2000) }),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const params = ctx.params as { url?: string };
        if (!params?.url) return { ok: false, content: "[错误] 缺少 url" };
        const host = env.needHost();
        // Agent 标签默认不得访问回环（与 web_fetch 的 allowLoopback:false 对齐）。
        // 在工具层先拒一次：模型拿到的是可行动文案，而不是一次「网页加载失败」。
        if (!agentLoopbackAllowed() && isLoopbackTarget(params.url)) {
          return {
            ok: false,
            content: `[BLOCKED_LOOPBACK] Agent 不允许打开本机/回环地址（${params.url}）。本机服务请让用户自己打开；确实需要时由用户显式放开。`,
          };
        }
        // 打开网页前先过钩子（会话窗口布局询问，Slice E）：必须在真正 host.navigate 之前，
        // 否则「用户取消」已经变成了一次真实导航（源站可见、可能触发登录态/埋点）。
        // 放在 readTab 之前也让「动作前状态」是导航前的真实状态（用户思考期间页面可能变化）。
        const gate = env.hooks?.beforeOpenPage
          ? await env.hooks.beforeOpenPage({ sessionId: ctx.sessionId, url: params.url })
          : null;
        if (gate && !gate.proceed) {
          return { ok: false, content: `[已取消] ${gate.note ?? "用户取消了本次打开网页"}` };
        }
        const tabId = activeTabOf(host, ctx.sessionId);
        const before = readTab(host, ctx.sessionId, tabId);
        // origin="agent"：该标签归属「Agent 工作区」（UI 折叠标签组 + 运行期接管锁）
        const result = await host.navigate(params.url, undefined, ctx.sessionId, "agent");
        if (!result.ok) return { ok: false, content: `[错误] 导航失败：${result.error ?? "未知"}` };
        const created = (result as { tabId?: string }).tabId ?? tabId;
        const settled = await settleTab(host, ctx.sessionId, created, before);
        const line = statusLine(`已打开 ${result.url ?? params.url}`, settled);
        // 布局安排的说明放在状态行之后：状态行是「页面现在怎么样」，note 是「这次为什么这样摆窗口」。
        return { ok: true, content: gate?.note ? `${line}\n${gate.note}` : line };
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });
  env.register({
    name: "browser_tabs",
    description:
      "管理当前会话的标签页：action=list 列出全部标签（序号/tabId/标题/URL/活动标记）；new 新建标签并自动切过去（可选 url）；select 切换；close 关闭（关最后一页只关闭标签，不退出应用）",
    permissions: { browser: true },
    schema: z.object({
      action: z.enum(["list", "new", "select", "close"]),
      url: z.string().min(1).max(2000).optional(),
      tabId: z.string().min(1).max(80).optional(),
    }),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const params = (ctx.params ?? {}) as { action?: "list" | "new" | "select" | "close"; url?: string; tabId?: string };
        const action = params.action;
        if (!action) return { ok: false, content: "[错误] 缺少 action（list / new / select / close）" };
        const host = env.needHost();
        const sessionId = ctx.sessionId;

        if (action === "list") {
          const tabs = host.listTabs(sessionId);
          const tabId = activeTabOf(host, sessionId);
          const note = tabs.length === 0 ? "当前会话没有打开的网页标签" : undefined;
          return {
            ok: true,
            content: `${formatTabList(tabs)}\n${statusLine("标签列表", { tab: readTab(host, sessionId, tabId), navigated: false }, note)}`,
          };
        }

        if (action === "new") {
          const countBefore = host.listTabs(sessionId).length;
          const created = await host.newTab(params.url, sessionId, "agent");
          if (!created?.ok) {
            return {
              ok: false,
              content: `[错误] 新建标签失败：${created?.error ?? "未知"}${created?.tabId ? `（已创建空白标签 ${created.tabId}，可 action=close 关闭）` : ""}`,
            };
          }
          // newTab 对已存在的同 URL 标签是「复用并切过去」，文案要如实说明
          const reused = host.listTabs(sessionId).length === countBefore;
          // 新标签没有「动作前状态」：空白标签不算发生导航，带 URL 才算
          const settled = await settleTab(host, sessionId, created.tabId, null);
          const label = reused ? `已切换到已有标签 ${created.tabId}` : `已新建标签 ${created.tabId}`;
          return { ok: true, content: `${formatTabList(host.listTabs(sessionId))}\n${statusLine(label, settled)}` };
        }

        if (!params.tabId) {
          return { ok: false, content: `[错误] ${action} 需要 tabId（可先用 browser_tabs action=list 查看）` };
        }
        const tabId = params.tabId;

        if (action === "select") {
          const switched = host.selectTab(tabId, sessionId);
          if (!switched) {
            return { ok: false, content: `[错误] 标签不存在：${tabId}；可先用 browser_tabs action=list 查看当前标签` };
          }
          const tab = readTab(host, sessionId, tabId);
          return {
            ok: true,
            content: `${formatTabList(host.listTabs(sessionId))}\n${statusLine(`已切换到标签 ${tabId}`, { tab, navigated: false })}`,
          };
        }

        // close：标签关掉不影响其它标签；关最后一页只是没有网页，应用不退出
        const closed = await host.closeTab(tabId, sessionId);
        if (!closed) {
          return { ok: false, content: `[错误] 标签不存在：${tabId}；可先用 browser_tabs action=list 查看当前标签` };
        }
        env.bindings.forget(sessionId, tabId);
        const tabs = host.listTabs(sessionId);
        const nextId = activeTabOf(host, sessionId);
        const note = tabs.length === 0 ? "当前会话已没有打开的标签（只关闭网页，不退出应用）" : undefined;
        return {
          ok: true,
          content: `${formatTabList(tabs)}\n${statusLine(`已关闭标签 ${tabId}`, { tab: readTab(host, sessionId, nextId), navigated: false }, note)}`,
        };
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });
  env.register({
    name: "browser_back",
    description: "在当前标签（可选 tabId）后退一页，返回 URL、是否成功与状态行",
    permissions: { browser: true },
    schema: z.object({ tabId: z.string().min(1).max(80).optional() }),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const params = (ctx.params ?? {}) as { tabId?: string };
        const host = env.needHost();
        const tabId = params.tabId ?? activeTabOf(host, ctx.sessionId);
        if (!tabId) return { ok: false, content: "[错误] 当前会话没有打开的网页标签" };
        const before = readTab(host, ctx.sessionId, tabId);
        const result = await host.goBack(tabId, ctx.sessionId);
        if (!result?.ok) {
          return { ok: false, content: `[错误] 后退失败：${result?.error ?? "未知"}。可先用 browser_tabs action=list 确认标签` };
        }
        const settled = await settleTab(host, ctx.sessionId, tabId, before);
        return { ok: true, content: statusLine(`已后退 ${result.url ?? ""}`.trim(), settled) };
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });
  env.register({
    name: "browser_forward",
    description: "在当前标签（可选 tabId）前进一页，返回 URL、是否成功与状态行",
    permissions: { browser: true },
    schema: z.object({ tabId: z.string().min(1).max(80).optional() }),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const params = (ctx.params ?? {}) as { tabId?: string };
        const host = env.needHost();
        const tabId = params.tabId ?? activeTabOf(host, ctx.sessionId);
        if (!tabId) return { ok: false, content: "[错误] 当前会话没有打开的网页标签" };
        const before = readTab(host, ctx.sessionId, tabId);
        const result = await host.goForward(tabId, ctx.sessionId);
        if (!result?.ok) {
          return { ok: false, content: `[错误] 前进失败：${result?.error ?? "未知"}。可先用 browser_tabs action=list 确认标签` };
        }
        const settled = await settleTab(host, ctx.sessionId, tabId, before);
        return { ok: true, content: statusLine(`已前进 ${result.url ?? ""}`.trim(), settled) };
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });
  env.register({
    name: "browser_reload",
    description: "刷新当前标签（可选 tabId），返回 URL、是否成功与状态行",
    permissions: { browser: true },
    schema: z.object({ tabId: z.string().min(1).max(80).optional() }),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const params = (ctx.params ?? {}) as { tabId?: string };
        const host = env.needHost();
        const tabId = params.tabId ?? activeTabOf(host, ctx.sessionId);
        if (!tabId) return { ok: false, content: "[错误] 当前会话没有打开的网页标签" };
        const before = readTab(host, ctx.sessionId, tabId);
        const result = await host.reload(tabId, ctx.sessionId);
        if (!result?.ok) {
          return { ok: false, content: `[错误] 刷新失败：${result?.error ?? "未知"}。可先用 browser_tabs action=list 确认标签` };
        }
        const settled = await settleTab(host, ctx.sessionId, tabId, before);
        return { ok: true, content: statusLine(`已刷新 ${result.url ?? ""}`.trim(), settled) };
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });
  env.register({
    name: "browser_wait",
    description:
      "等待页面就绪：轮询指定选择器出现/文本出现在页面中，或简单等待若干毫秒（默认 3000ms，上限 10s）。适合等异步内容加载",
    permissions: { read: true },
    schema: z.object({
      ms: z.number().int().min(100).max(10_000).optional(),
      selector: z.string().min(1).max(200).optional(),
      text: z.string().min(1).max(200).optional(),
    }),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const params = (ctx.params ?? {}) as { ms?: number; selector?: string; text?: string };
        const timeoutMs = params.ms ?? 3000;
        const selector = params.selector?.trim();
        const text = params.text?.trim();
        const host = env.needHost();
        const startedAt = Date.now();

        // 只给 ms：纯等待（让页面自行加载）
        if (!selector && !text) {
          await sleep(timeoutMs);
          return { ok: true, content: `[就绪] 已等待 ${timeoutMs}ms` };
        }

        const description = [selector ? `选择器 ${selector}` : "", text ? `文本「${text}」` : ""]
          .filter(Boolean)
          .join(" 或 ");
        const checkScript = `(() => {
          const selector = ${selector ? JSON.stringify(selector) : "null"};
          const text = ${text ? JSON.stringify(text) : "null"};
          if (selector) {
            let el = null;
            try { el = document.querySelector(selector); } catch { return false; }
            if (!el) return false;
          }
          if (text) {
            const body = document.body ? document.body.innerText : "";
            if (body.indexOf(text) === -1) return false;
          }
          return true;
        })()`;

        while (true) {
          let ready = false;
          try {
            ready = Boolean(await host.executeScript(checkScript, ctx.sessionId));
          } catch (err) {
            return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
          }
          const elapsed = Date.now() - startedAt;
          if (ready) return { ok: true, content: `[就绪] ${description} 已出现（等待 ${elapsed}ms）` };
          if (elapsed >= timeoutMs) {
            return { ok: false, content: `[超时] 等待 ${timeoutMs}ms 仍未检测到 ${description}` };
          }
          await sleep(Math.min(200, Math.max(0, timeoutMs - elapsed)));
        }
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });
}
