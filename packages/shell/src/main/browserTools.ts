/**
 * 浏览器工具集（Agent 的"手和眼"）：把 BrowserHost 的适配层能力注册为工具。
 *
 * 设计约束：
 *   · 只依赖 BrowserHost 的公开方法（不 import electron）；无 IPC 变化；
 *   · 权限按类别声明：读取页面 read，导航/点击/输入/抓取 network（默认每次确认）；
 *   · 输出限制大小（模型上下文友好），错误返回 ok:false 而不是抛异常。
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NetAdapter } from "loopsoar-core/platform";
import type { ToolRegistry, ToolResult } from "loopsoar-core/tools/registry";
import type { BrowserHost } from "./browserHost.js";

const MAX_TEXT = 8000;

function clip(text: string, max = MAX_TEXT): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[已截断，共 ${text.length} 字符]`;
}

/** 等待指定毫秒（browser_wait 轮询用）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** 读 PNG IHDR 的宽高（截图尺寸展示用）；非 PNG 返回 null。 */
function readPngSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24) return null;
  if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return null;
  if (buffer.subarray(12, 16).toString("ascii") !== "IHDR") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** 截图文件名时间戳（本地时间 YYYYMMDD-HHmmss）。 */
function screenshotStamp(): string {
  const date = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
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

/**
 * 注册浏览器工具集。
 * @param resolveSessionRoot 会话工作根解析（截图落盘 <root>/.loopsoar/screenshots/；缺省 process.cwd()）。
 *   作为可选第三参保持向后兼容（既有调用/测试只传前两个参数）。
 */
export function registerBrowserTools(
  registry: ToolRegistry,
  browserHost: () => BrowserHost | null,
  resolveSessionRoot?: (sessionId?: string) => string,
): void {
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
    name: "browser_screenshot",
    description:
      "对当前标签页截图（可见区域，PNG）并保存到会话工作根 .loopsoar/screenshots/；可选 selector 先把元素滚动到可视区。返回文件路径与像素尺寸",
    permissions: { read: true },
    schema: z.object({ selector: z.string().min(1).max(200).optional() }),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const params = (ctx.params ?? {}) as { selector?: string };
        const host = needHost();

        // selector 只负责把目标元素滚进视野（Electron capturePage 截的是当前视口，不是元素级截图）
        if (params.selector) {
          const selector = JSON.stringify(params.selector);
          const located = (await host.executeScript(
            `(() => {
              let el = null;
              try { el = document.querySelector(${selector}); } catch {}
              if (!el) return { ok: false, reason: "未找到元素：" + ${selector} };
              el.scrollIntoView({ block: "center" });
              return { ok: true };
            })()`,
            ctx.sessionId,
          )) as { ok?: boolean; reason?: string } | null;
          if (!located?.ok) return { ok: false, content: `[错误] ${located?.reason ?? "元素定位失败"}` };
        }

        const data = await host.screenshot(ctx.sessionId);
        if (!data) return { ok: false, content: "[错误] 当前没有打开的网页标签" };
        // 兼容 dataURL（data:image/png;base64,xxx）与裸 base64 两种适配器实现
        const base64 = data.includes(",") ? data.slice(data.indexOf(",") + 1) : data;
        const buffer = Buffer.from(base64, "base64");
        if (buffer.length === 0) return { ok: false, content: "[错误] 截图失败（空图像）" };

        const root = resolveSessionRoot?.(ctx.sessionId)?.trim() || process.cwd();
        const dir = path.join(root, ".loopsoar", "screenshots");
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `screenshot-${screenshotStamp()}-${randomUUID().slice(0, 8)}.png`);
        fs.writeFileSync(file, buffer);

        const size = readPngSize(buffer);
        return {
          ok: true,
          content: `已截图：${file}\n尺寸：${size ? `${size.width}x${size.height}` : "未知"}（${buffer.length} 字节）`,
        };
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });

  registry.register({
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
        const host = needHost();
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
