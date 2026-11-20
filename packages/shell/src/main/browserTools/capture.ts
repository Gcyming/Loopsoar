/**
 * 浏览器「留证与替代取数」工具：截图（可回灌视觉模型）与 web_fetch（非浏览器抓取）。
 *
 * 拆分自 browserTools.ts（行为与文案不变）。两者都不是浏览器操控：
 * 截图是 read，web_fetch 是 network（默认每次确认），权限档位在各自定义里声明。
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { NetAdapter } from "loopsoar-core/platform";
import type { ToolResult } from "loopsoar-core/tools/registry";
import { clip } from "../browserFormat.js";
import { performScrollIntoView } from "../../browserAdapter/refs.js";
import { MAX_TEXT, activeTabOf, htmlToText, readPngSize, screenshotStamp, type BrowserToolEnv } from "./context.js";

/** 注册截图与抓取类浏览器工具。 */
export function registerCaptureTools(env: BrowserToolEnv): void {
  env.register({
    name: "browser_screenshot",
    description:
      "对当前标签页截图（可见区域，PNG）并保存到会话工作根 .loopsoar/screenshots/；可选 selector 先把元素滚动到可视区。视觉模型会直接收到图片附件，text-only 模型只返回路径",
    permissions: { read: true },
    schema: z.object({ selector: z.string().min(1).max(200).optional() }),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const params = (ctx.params ?? {}) as { selector?: string };
        const host = env.needHost();
        const activeTabId = activeTabOf(host, ctx.sessionId);

        // selector 只负责把目标元素滚进视野（Electron capturePage 截的是当前视口，不是元素级截图）
        // 与 click/type 同一套解析：支持 #eN、CSS 选择器与 text=
        if (params.selector) {
          const tabId = activeTabOf(host, ctx.sessionId);
          const located = await performScrollIntoView(env.bindings.registry(ctx.sessionId, tabId), params.selector, (script) =>
            host.executeScript(script, ctx.sessionId, tabId ?? undefined),
          );
          if (!located.ok) return { ok: false, content: located.message ?? "[错误] 元素定位失败" };
        }

        // 光标/高亮现在画在应用级覆盖窗口里，capturePage 只截网页本身，不会被拍进证据图。
        const data = await host.screenshot(ctx.sessionId);
        if (!data) return { ok: false, content: "[错误] 当前没有打开的网页标签" };
        // 兼容 dataURL（data:image/png;base64,xxx）与裸 base64 两种适配器实现
        const base64 = data.includes(",") ? data.slice(data.indexOf(",") + 1) : data;
        const buffer = Buffer.from(base64, "base64");
        if (buffer.length === 0) return { ok: false, content: "[错误] 截图失败（空图像）" };

        const root = env.resolveSessionRoot?.(ctx.sessionId)?.trim() || process.cwd();
        const dir = path.join(root, ".loopsoar", "screenshots");
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `screenshot-${screenshotStamp()}-${randomUUID().slice(0, 8)}.png`);
        fs.writeFileSync(file, buffer);

        const size = readPngSize(buffer);
        let attachImage = false;
        try {
          attachImage = env.hooks?.visionEnabled?.() === true && buffer.length <= 1_500_000;
        } catch {
          // 能力探测失败不应让截图工具失败；退回只返回路径。
        }
        // 截图通常是设备像素，坐标点击默认吃 CSS 像素；把视口与 DPR 一起告诉视觉模型，避免点偏。
        // 只在图片真的回灌时探测：text-only 路径不需要额外脚本。
        let viewport: { width: number; height: number; dpr: number } | null = null;
        if (attachImage) {
          try {
            const raw = (await host.executeScript(
              "(() => ({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 }))()",
              ctx.sessionId,
              activeTabId ?? undefined,
            )) as { width?: unknown; height?: unknown; dpr?: unknown } | null;
            if (raw && typeof raw.width === "number" && typeof raw.height === "number") {
              viewport = { width: raw.width, height: raw.height, dpr: typeof raw.dpr === "number" ? raw.dpr : 1 };
            }
          } catch {
            // 视口探测失败只影响提示，不影响截图本身。
          }
        }
        return {
          ok: true,
          content: `已截图：${file}\n尺寸：${size ? `${size.width}x${size.height}` : "未知"}（${buffer.length} 字节）${
            viewport ? `\n视口：${viewport.width}x${viewport.height} CSS（DPR ${viewport.dpr}）；坐标点击默认 CSS 像素，若按截图图像像素估坐标请传 space="image"` : ""
          }${attachImage ? "\n图片已附在本轮工具结果中。" : ""}`,
          ...(attachImage ? { images: [{ mime: "image/png", base64 }] } : {}),
        };
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });
  env.register({
    name: "web_fetch",
    description: "直接抓取一个 http(s) URL 的文本内容（不打开标签页；用于查资料/API）",
    // web_fetch 不是「浏览器操控」：直接抓取 URL 文本、不开标签页，语义属于网络访问，
    // 因此留在 network 档（与 browser 档不混用），仍走「每次确认」的默认策略。
    permissions: {
      network: true,
    },
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
