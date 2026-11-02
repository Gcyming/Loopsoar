/**
 * 浏览器工具集（Agent 的"手和眼"）：把 BrowserHost 的适配层能力注册为工具。
 *
 * 设计约束：
 *   · 只依赖 BrowserHost 的公开方法（不 import electron）；无 IPC 变化；
 *   · 权限按类别声明：读取页面 read，导航/点击/输入/抓取 network（默认每次确认）；
 *   · 输出限制大小（模型上下文友好），错误返回 ok:false 而不是抛异常。
 */
import { z } from "zod";
import type { NetAdapter } from "loopsoar-core/platform";
import type { ToolRegistry, ToolResult } from "loopsoar-core/tools/registry";
import type { BrowserHost } from "./browserHost.js";

const MAX_TEXT = 8000;

function clip(text: string, max = MAX_TEXT): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[已截断，共 ${text.length} 字符]`;
}

/** 极简 HTML → 文本（仅用于 web_fetch 的兜底可读化）。 */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function registerBrowserTools(registry: ToolRegistry, browserHost: () => BrowserHost | null): void {
  const needHost = (): BrowserHost => {
    const host = browserHost();
    if (!host) throw new Error("浏览器未就绪");
    return host;
  };

  registry.register({
    name: "browser_snapshot",
    description: "读取当前标签页的地址、标题与可见正文（Agent 浏览网页的首选：先快照再决策）",
    permissions: { read: true },
    schema: z.object({ maxChars: z.number().int().min(200).max(30000).optional() }),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const params = (ctx.params ?? {}) as { maxChars?: number };
        const snapshot = (await needHost().snapshot(ctx.sessionId)) as {
          url: string;
          title: string;
          text: string;
          elements?: { id?: string; tag?: string; type?: string; text?: string; href?: string }[];
        } | null;
        if (!snapshot) return { ok: false, content: "[错误] 当前没有打开的网页标签" };
        const body = clip(snapshot.text, params.maxChars ?? MAX_TEXT);
        const elements = (snapshot.elements ?? [])
          .slice(0, 40)
          .map(
            (el) =>
              `[#${el.id ?? "?"}] <${el.tag ?? "?"}${el.type ? ` type=${el.type}` : ""}> ${el.text ?? ""}${el.href ? ` → ${el.href}` : ""}`,
          )
          .join("\n");
        return {
          ok: true,
          content: `URL: ${snapshot.url}\n标题: ${snapshot.title}\n\n${body}${elements ? `\n\n可交互元素（可用编号或 CSS 选择器点击/输入）：\n${elements}` : ""}`,
        };
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });

  registry.register({
    name: "browser_navigate",
    description: "在当前标签页打开一个 http(s) 网址（等价于用户输入地址回车）",
    permissions: { network: true },
    schema: z.object({ url: z.string().min(1).max(2000) }),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const params = ctx.params as { url?: string };
        if (!params?.url) return { ok: false, content: "[错误] 缺少 url" };
        const result = await needHost().navigate(params.url, undefined, ctx.sessionId);
        return result.ok
          ? { ok: true, content: `已打开：${result.url ?? params.url}` }
          : { ok: false, content: `[错误] 导航失败：${result.error ?? "未知"}` };
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });

  registry.register({
    name: "browser_click",
    description: "点击页面上的元素（CSS 选择器或 a/button 的文本匹配，如 'text=登录'）",
    permissions: { network: true },
    schema: z.object({ target: z.string().min(1).max(500) }),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const params = ctx.params as { target?: string };
        if (!params?.target) return { ok: false, content: "[错误] 缺少 target" };
        const host = needHost();
        const target = params.target;
        const script = `(() => {
          const t = ${JSON.stringify(target)};
          let el = null;
          try { el = document.querySelector(t); } catch {}
          if (!el && t.startsWith('text=')) {
            const want = t.slice(5).trim();
            el = [...document.querySelectorAll('a,button,[role="button"]')].find((n) => (n.textContent || '').trim().includes(want)) || null;
          }
          if (!el) return { ok: false, reason: '未找到元素：' + t };
          el.scrollIntoView({ block: 'center' });
          el.click();
          return { ok: true };
        })()`;
        const out = (await host.executeScript(script, ctx.sessionId)) as { ok?: boolean; reason?: string };
        return out?.ok
          ? { ok: true, content: `已点击：${target}` }
          : { ok: false, content: `[错误] ${out?.reason ?? "点击失败"}` };
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });

  registry.register({
    name: "browser_type",
    description: "在页面输入框中输入文本（CSS 选择器；会触发 input/change 事件）",
    permissions: { network: true },
    schema: z.object({ target: z.string().min(1).max(500), text: z.string().max(4000) }),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const params = ctx.params as { target?: string; text?: string };
        if (!params?.target) return { ok: false, content: "[错误] 缺少 target" };
        const script = `(() => {
          const el = document.querySelector(${JSON.stringify(params.target)});
          if (!el) return { ok: false, reason: '未找到输入框' };
          el.focus();
          const text = ${JSON.stringify(params.text ?? "")};
          if ('value' in el) { el.value = text; } else { el.textContent = text; }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true };
        })()`;
        const out = (await needHost().executeScript(script, ctx.sessionId)) as { ok?: boolean; reason?: string };
        return out?.ok ? { ok: true, content: `已输入到 ${params.target}` } : { ok: false, content: `[错误] ${out?.reason ?? "输入失败"}` };
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });

  registry.register({
    name: "browser_scroll",
    description: "滚动当前页面：down / up / top / bottom（长页面分页阅读）",
    permissions: { network: true },
    schema: z.object({ direction: z.enum(["down", "up", "top", "bottom"]), amount: z.number().int().min(100).max(5000).optional() }),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const params = (ctx.params ?? {}) as { direction?: "down" | "up" | "top" | "bottom"; amount?: number };
        const direction = params.direction ?? "down";
        const amount = params.amount ?? 800;
        const script =
          direction === "top"
            ? "window.scrollTo({ top: 0 }); 'ok'"
            : direction === "bottom"
              ? "window.scrollTo({ top: document.body.scrollHeight }); 'ok'"
              : `window.scrollBy({ top: ${direction === "up" ? -amount : amount} }); 'ok'`;
        await needHost().executeScript(script, ctx.sessionId);
        return { ok: true, content: `已滚动：${direction}` };
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });

  registry.register({
    name: "web_fetch",
    description: "直接抓取一个 http(s) URL 的文本内容（不打开标签页；用于查资料/API）",
    permissions: { network: true },
    schema: z.object({ url: z.string().url().max(2000), maxChars: z.number().int().min(200).max(30000).optional() }),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const params = ctx.params as { url?: string; maxChars?: number };
        if (!params?.url) return { ok: false, content: "[错误] 缺少 url" };
        // 出网必须走注入的 platform.net（DNS 钉扎 + 逐跳 SSRF 校验）；
        // 这里不再裸 fetch：裸 fetch 会重新解析 DNS，把 SSRF 防护降级成"校验后被 TOCTOU 绕过"。
        const net = ctx.platform?.net as NetAdapter | undefined;
        if (!net || typeof net.request !== "function") {
          return { ok: false, content: "[错误] 网络适配器未就绪（无法安全抓取）" };
        }
        const maxChars = params.maxChars ?? MAX_TEXT;
        const response = await net.request({
          url: params.url,
          method: "GET",
          timeoutMs: 12_000,
          maxChars,
          allowLoopback: false,
          headers: {
            "user-agent": "LoopsoarBot/0.0 (+local agent browser)",
            accept: "text/html,application/json,text/plain,*/*",
          },
        });
        const contentType = response.headers["content-type"] ?? "";
        const text = /html/i.test(contentType) ? htmlToText(response.text) : response.text;
        const ok = response.status >= 200 && response.status < 300;
        return {
          ok,
          content: ok
            ? `HTTP ${response.status} ${response.finalUrl}\n\n${clip(text, maxChars)}`
            : `[HTTP ${response.status}] ${clip(text, 1000)}`,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, content: `[错误] ${message}` };
      }
    },
  });
}
