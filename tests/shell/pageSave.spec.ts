/**
 * 页面保存（packages/shell/src/main/pageSave.ts + domains/pageSave.ts）：
 * 落盘路径/文件名清洗/UTF-8 声明/大小限制/失败文案/域通道转发。
 * 用临时目录 + 假 BrowserHost，不联网、不启 Electron。
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SAVE_PAGE_MAX_BYTES,
  ensureUtf8Meta,
  sanitizeFileName,
  saveActivePage,
  type SavePageHost,
} from "../../packages/shell/src/main/pageSave.ts";
import { registerPageSaveDomain } from "../../packages/shell/src/main/domains/pageSave.ts";
import { __resetHandlerRegistryForTests } from "../../packages/shell/src/main/trustedIpc.ts";

const HTML = "<html><head><title>示例页</title></head><body><h1>正文 ABC</h1></body></html>";

/** 假页面上下文：返回固定 title/html；可配置抛出。 */
function makeHost(
  capture: unknown | (() => unknown) = { title: "示例 标题", html: HTML },
): { host: SavePageHost; scripts: string[] } {
  const scripts: string[] = [];
  const host: SavePageHost = {
    async executeScript(script: string): Promise<unknown> {
      scripts.push(script);
      return typeof capture === "function" ? (capture as () => unknown)() : capture;
    },
  };
  return { host, scripts };
}

let roots: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  roots = [];
  __resetHandlerRegistryForTests();
});

describe("pageSave · 基础能力", () => {
  it("保存成功：写入 <dataDir>/saved-pages/*.html，返回 path/title/bytes", async () => {
    const dataDir = tempDir("loopsoar-save-");
    const { host, scripts } = makeHost();
    const result = await saveActivePage({
      host,
      dataDir,
      downloadDir: "",
      now: () => new Date(2026, 0, 2, 3, 4, 5).getTime(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.title).toBe("示例 标题");
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.path.startsWith(path.join(dataDir, "saved-pages"))).toBe(true);
    expect(result.path.endsWith(".html")).toBe(true);
    expect(result.path).toContain("20260102-030405");
    expect(existsSync(result.path)).toBe(true);
    const saved = readFileSync(result.path, "utf8");
    expect(saved).toContain("正文 ABC");
    expect(saved.startsWith("<!DOCTYPE html>")).toBe(true);
    // 执行的是「取 title + outerHTML」的脚本（不含 electron API）
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain("document.title");
    expect(scripts[0]).toContain("outerHTML");
  });

  it("downloadDir 优先于 dataDir", async () => {
    const dataDir = tempDir("loopsoar-data-");
    const downloadDir = tempDir("loopsoar-dl-");
    const { host } = makeHost();
    const result = await saveActivePage({ host, dataDir, downloadDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path.startsWith(path.join(downloadDir, "saved-pages"))).toBe(true);
    expect(existsSync(path.join(dataDir, "saved-pages"))).toBe(false);
  });

  it("标题清洗 + Windows 保留名兜底", async () => {
    const dataDir = tempDir("loopsoar-save-");
    const { host } = makeHost({ title: 'a/b:c*?"<>| 标题', html: HTML });
    const first = await saveActivePage({ host, dataDir, now: () => 0 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(path.basename(first.path)).toMatch(/^a_b_c_+ 标题-[\d-]+\.html$/);
    expect(path.basename(first.path)).not.toMatch(/[\\/:*?"<>|]/);

    const conHost = makeHost({ title: "CON", html: HTML }).host;
    const conResult = await saveActivePage({ host: conHost, dataDir, now: () => 0 });
    expect(conResult.ok).toBe(true);
    if (conResult.ok) expect(path.basename(conResult.path).startsWith("_CON-")).toBe(true);
  });

  it("同一秒重复保存不覆盖（追加序号）", async () => {
    const dataDir = tempDir("loopsoar-save-");
    const { host } = makeHost();
    const now = () => 42;
    const first = await saveActivePage({ host, dataDir, now });
    const second = await saveActivePage({ host, dataDir, now });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.path).not.toBe(second.path);
    expect(existsSync(first.path)).toBe(true);
    expect(existsSync(second.path)).toBe(true);
    expect(readdirSync(path.join(dataDir, "saved-pages")).length).toBe(2);
  });

  it("空标题用 saved-page 兜底；空 HTML 拒绝", async () => {
    const dataDir = tempDir("loopsoar-save-");
    const emptyTitle = await saveActivePage({ host: makeHost({ title: "  ", html: HTML }).host, dataDir });
    expect(emptyTitle.ok).toBe(true);
    if (emptyTitle.ok) expect(path.basename(emptyTitle.path).startsWith("saved-page-")).toBe(true);

    const emptyHtml = await saveActivePage({ host: makeHost({ title: "x", html: "" }).host, dataDir });
    expect(emptyHtml.ok).toBe(false);
    if (!emptyHtml.ok) expect(emptyHtml.error).toMatch(/无法读取页面内容|为空/);

    const missing = await saveActivePage({ host: makeHost({ title: "x" }).host, dataDir });
    expect(missing.ok).toBe(false);
  });

  it("超过 20MB 拒绝保存", async () => {
    const dataDir = tempDir("loopsoar-save-");
    const huge = { title: "大页面", html: `<html><body>${"x".repeat(SAVE_PAGE_MAX_BYTES + 16)}</body></html>` };
    const result = await saveActivePage({ host: makeHost(huge).host, dataDir });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/过大/);
  });

  it("executeScript 抛错 → 可读错误（不抛出）", async () => {
    const dataDir = tempDir("loopsoar-save-");
    const { host } = makeHost(() => {
      throw new Error("页面已关闭");
    });
    const result = await saveActivePage({ host, dataDir });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("保存页面失败");
      expect(result.error).toContain("页面已关闭");
    }
  });
});

describe("pageSave · 文本工具函数", () => {
  it("sanitizeFileName：非法字符/首尾点/超长/保留名", () => {
    expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe("a_b_c_d_e_f_g_h_i_j");
    expect(sanitizeFileName("...hidden")).toBe("hidden");
    expect(sanitizeFileName("名称.")).toBe("名称");
    expect(sanitizeFileName("")).toBe("saved-page");
    expect(sanitizeFileName("x".repeat(200)).length).toBe(80);
    expect(sanitizeFileName("AUX")).toBe("_AUX");
  });

  it("ensureUtf8Meta：缺 charset 时注入，已有则不重复", () => {
    expect(ensureUtf8Meta("<html><head></head></html>")).toBe('<html><head><meta charset="utf-8"></head></html>');
    const withMeta = '<html><head><meta charset="GBK"></head></html>';
    expect(ensureUtf8Meta(withMeta)).toBe(withMeta);
    expect(ensureUtf8Meta("<div>x</div>")).toContain('<meta charset="utf-8">');
  });
});

describe("pageSave · browser:savePage 域通道", () => {
  const TRUSTED = { senderFrame: { url: "loopsoar://app/index.html" } };

  function makeDomain(browser: unknown, dataDir: string, downloadDir?: string | (() => string)) {
    __resetHandlerRegistryForTests();
    const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
    registerPageSaveDomain({
      ipc: { handle: (channel: string, fn: unknown) => handlers.set(channel.replace(/^loopsoar:/, ""), fn as never) },
      audit: () => {},
      browser: browser as never,
      dataDir,
      downloadDir,
    });
    return handlers;
  }

  it("宿主未装配 → { ok:false, error }", async () => {
    const dataDir = tempDir("loopsoar-save-");
    const handlers = makeDomain(undefined, dataDir);
    const result = (await handlers.get("browser:savePage")!(TRUSTED, {})) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain("浏览器宿主未装配");
  });

  it("保存活动标签 → ok/path；指定 tabId 时先校验存在并切换", async () => {
    const dataDir = tempDir("loopsoar-save-");
    const calls: string[] = [];
    const browser = {
      activeTabId: () => "tab-2",
      listTabs: () => [
        { id: "tab-1", url: "https://a.example/", title: "A", active: false },
        { id: "tab-2", url: "https://b.example/", title: "B", active: true },
      ],
      selectTab: (tabId: string) => {
        calls.push(`select:${tabId}`);
        return true;
      },
      executeScript: async () => {
        calls.push("script");
        return { title: "保存标题", html: HTML };
      },
    };
    const handlers = makeDomain(browser, dataDir, () => "");
    const handler = handlers.get("browser:savePage")!;

    const okResult = (await handler(TRUSTED, { tabId: "tab-1" })) as { ok: boolean; path?: string };
    expect(okResult.ok).toBe(true);
    expect(okResult.path).toBeTruthy();
    expect(calls).toContain("select:tab-1");
    expect(calls.filter((call) => call === "script").length).toBe(1);

    const missing = (await handler(TRUSTED, { tabId: "tab-404" })) as { ok: boolean; error?: string };
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("标签不存在");
  });

  it("downloadDir getter 每次执行时读取（偏好即时生效）", async () => {
    const dataDir = tempDir("loopsoar-data-");
    const downloadDir = tempDir("loopsoar-dl-");
    const browser = {
      activeTabId: () => "tab-1",
      listTabs: () => [{ id: "tab-1", url: "https://a.example/", title: "A", active: true }],
      selectTab: () => true,
      executeScript: async () => ({ title: "标题", html: HTML }),
    };
    const handlers = makeDomain(browser, dataDir, () => downloadDir);
    const result = (await handlers.get("browser:savePage")!(TRUSTED, {})) as { ok: boolean; path?: string };
    expect(result.ok).toBe(true);
    expect(result.path?.startsWith(path.join(downloadDir, "saved-pages"))).toBe(true);
  });
});
