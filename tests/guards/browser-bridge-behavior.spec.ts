/**
 * 浏览器桥「四攻击路径」行为级守卫（发布门 2 的可执行契约）。
 *
 * ① window.open / target=_blank 逃逸：一律 deny，仅 http(s) 转应用内新标签；
 * ② preload 沙箱行为：见 tests/shell/preloadSandbox.spec.ts（同批补齐）；
 * ③ IPC 冒用：伪造 senderFrame / 未注册通道 / 参数非法 → 拒绝且审计留痕，
 *    并证明 registry 里存的是「四要素包装器」而不是可被直接调用的原始 handler（防绕过）；
 * ④ CDP 滥用：全仓源码断言无 remote-debugging / debugger.attach，且浏览器视图的
 *    webPreferences 三件套（sandbox / contextIsolation / nodeIntegration=false）齐全。
 *
 * 注：本文件 mock 掉 electron，只测「electron API → 注入依赖」这层薄适配里的纯逻辑，
 * 不启动真实窗口（CI 与受限环境都能跑）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
  BrowserWindow: class FakeBrowserWindow {},
  session: {
    fromPartition: () => ({
      webRequest: { onBeforeRequest: () => {} },
      on: () => {},
    }),
  },
  shell: {},
  WebContentsView: class FakeWebContentsView {},
}));

import {
  createWindowOpenHandler,
  isNewTabUrlAllowed,
} from "../../packages/shell/src/main/electronBrowser.ts";
import {
  __resetHandlerRegistryForTests,
  getHandlerRegistry,
  handleTrusted,
  type AuditEntry,
  type TrustedIpcDeps,
} from "../../packages/shell/src/main/trustedIpc.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = path.resolve(HERE, "../../packages");
const SHELL_SRC = path.join(PACKAGES_DIR, "shell/src");
const TRUSTED_FRAME = { senderFrame: { url: "loopsoar://app/index.html" } };
const FORGED_FRAME = { senderFrame: { url: "https://evil.example/attack.html" } };

type Handler = (event: unknown, payload: unknown) => Promise<unknown> | unknown;

function fakeDeps(): { deps: TrustedIpcDeps; audits: AuditEntry[] } {
  const audits: AuditEntry[] = [];
  return {
    deps: {
      ipc: { handle: () => {} },
      audit: (entry) => audits.push(entry),
    },
    audits,
  };
}

/** 递归收集只读源码文件（不扫 dist/node_modules）。 */
function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        walk(full);
      } else if (/\.(ts|tsx|cjs|mjs|js)$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

describe("① window.open / target=_blank 逃逸（行为级）", () => {
  it("任何 URL 都返回 deny（不产生 Electron 独立窗口）", () => {
    const opened: string[] = [];
    const handler = createWindowOpenHandler((url) => opened.push(url));
    for (const url of [
      "https://example.com/",
      "http://example.com/",
      "javascript:alert(1)",
      "file:///C:/Windows/win.ini",
      "data:text/html,<script>alert(1)</script>",
      "loopsoar://app/index.html",
      "about:blank",
    ]) {
      expect(handler({ url })).toEqual({ action: "deny" });
    }
    // 只有 http(s) 进入新标签
    expect(opened).toEqual(["https://example.com/", "http://example.com/"]);
  });

  it("仅 http(s) 放行；伪协议/本地文件/应用内协议全部忽略", () => {
    expect(isNewTabUrlAllowed("https://example.com/a?b=1#c")).toBe(true);
    expect(isNewTabUrlAllowed("http://127.0.0.1:8080/")).toBe(true);
    expect(isNewTabUrlAllowed("javascript:alert(1)")).toBe(false);
    expect(isNewTabUrlAllowed("file:///C:/secret.txt")).toBe(false);
    expect(isNewTabUrlAllowed("data:text/html,hi")).toBe(false);
    expect(isNewTabUrlAllowed("loopsoar://app/index.html")).toBe(false);
    expect(isNewTabUrlAllowed("ftp://example.com/")).toBe(false);
    expect(isNewTabUrlAllowed("")).toBe(false);
    expect(isNewTabUrlAllowed("not a url")).toBe(false);
    expect(isNewTabUrlAllowed("//example.com/")).toBe(false); // 协议相对地址无 base → 不可信
  });
});

describe("④ CDP 滥用（静态全仓断言）", () => {
  const sourceFiles = listSourceFiles(PACKAGES_DIR).filter((file) => /[\\/]src[\\/]/.test(file));

  it("源码无 remote-debugging / debugger.attach / --inspect 等 CDP 外露", () => {
    expect(sourceFiles.length).toBeGreaterThan(20); // 防止「扫了个空目录」的假绿
    const violations: string[] = [];
    for (const file of sourceFiles) {
      const text = fs.readFileSync(file, "utf8");
      if (/remote-debugging|webContents\.debugger|debugger\.attach|--inspect(=|\s|$)/.test(text)) {
        violations.push(path.relative(PACKAGES_DIR, file));
      }
    }
    expect(violations).toEqual([]);
  });

  it("浏览器视图 webPreferences 三件套齐全，且无 nodeIntegration: true", () => {
    const shellSources = listSourceFiles(SHELL_SRC)
      .map((file) => ({ file, text: fs.readFileSync(file, "utf8") }))
      .filter(({ text }) => /webPreferences\s*:/.test(text));
    expect(shellSources.length).toBeGreaterThan(0);

    const joined = shellSources.map(({ text }) => text).join("\n");
    expect(joined).toMatch(/nodeIntegration:\s*false/);
    expect(joined).toMatch(/contextIsolation:\s*true/);
    expect(joined).toMatch(/sandbox:\s*true/);
    expect(joined).not.toMatch(/nodeIntegration:\s*true/);
    // 浏览器分区视图（electronBrowser）必须用持久化分区，不能落到默认 session
    const browserText = fs.readFileSync(path.join(SHELL_SRC, "main/electronBrowser.ts"), "utf8");
    expect(browserText).toMatch(/partition:\s*SESSION_PARTITION/);
  });
});

describe("③ IPC 冒用（伪造帧 / 未注册通道 / 参数非法 → 拒绝且审计）", () => {
  beforeEach(() => {
    __resetHandlerRegistryForTests();
  });

  it("伪造 senderFrame：拒绝调用、审计留痕、原始 handler 一次都没被调用", async () => {
    const { deps, audits } = fakeDeps();
    let rawCalls = 0;
    handleTrusted(deps, "chat:compact", () => {
      rawCalls += 1;
      return { ok: true };
    });
    const handler = getHandlerRegistry().get("chat:compact")!.handler as unknown as Handler;

    await expect(handler(FORGED_FRAME, { apply: false })).rejects.toThrow(/帧来源不可信/);
    expect(rawCalls).toBe(0); // 关键：校验不过，业务 handler 绝不执行
    expect(audits).toEqual([
      {
        channel: "chat:compact",
        sender: "https://evil.example/attack.html",
        status: "rejected",
        reason: "sender 帧来源不可信",
      },
    ]);
  });

  it("缺少 senderFrame（伪造为空事件）→ 拒绝（fail-closed）", async () => {
    const { deps, audits } = fakeDeps();
    handleTrusted(deps, "chat:compact", () => ({ ok: true }));
    const handler = getHandlerRegistry().get("chat:compact")!.handler as unknown as Handler;

    await expect(handler({}, undefined)).rejects.toThrow(/帧来源不可信/);
    expect(audits[0]?.status).toBe("rejected");
  });

  it("未在契约 manifest 内的通道：拒绝注册并审计", () => {
    const { deps, audits } = fakeDeps();
    expect(() => handleTrusted(deps, "evil:channel", () => ({}))).toThrow(/不在契约/);
    expect(audits[0]).toMatchObject({
      channel: "evil:channel",
      status: "rejected",
      reason: "channel 不在契约 manifest",
    });
    expect(getHandlerRegistry().has("evil:channel")).toBe(false);
  });

  it("参数违反契约 schema：拒绝、审计、原始 handler 不执行", async () => {
    const { deps, audits } = fakeDeps();
    let rawCalls = 0;
    handleTrusted(deps, "chat:compact", () => {
      rawCalls += 1;
      return { ok: true };
    });
    const handler = getHandlerRegistry().get("chat:compact")!.handler as unknown as Handler;

    await expect(handler(TRUSTED_FRAME, { apply: "yes" })).rejects.toThrow(/参数校验失败/);
    expect(rawCalls).toBe(0);
    const rejected = audits.filter((entry) => entry.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toContain("参数校验失败");
  });

  it("合法帧 + 合法参数 → 通过（证明拒绝不是无差别拦截），并审计 ok", async () => {
    const { deps, audits } = fakeDeps();
    handleTrusted(deps, "chat:compact", () => ({ ok: true }));
    const handler = getHandlerRegistry().get("chat:compact")!.handler as unknown as Handler;

    await expect(handler(TRUSTED_FRAME, { sessionId: "sess-1", apply: false })).resolves.toEqual({
      ok: true,
    });
    expect(audits[0]).toMatchObject({ channel: "chat:compact", status: "ok" });
  });

  it("registry 存的是校验包装器（不能拿 registry 绕过四要素直接调业务 handler）", async () => {
    const { deps } = fakeDeps();
    let rawCalls = 0;
    handleTrusted(deps, "chat:compact", () => {
      rawCalls += 1;
      return { ok: true };
    });
    const entry = getHandlerRegistry().get("chat:compact");
    expect(entry).toBeTruthy();
    // 即使拿到 registry 条目，用不可信帧调用仍会被拒
    await expect(
      (entry!.handler as unknown as Handler)(FORGED_FRAME, { apply: true }),
    ).rejects.toThrow(/帧来源不可信/);
    expect(rawCalls).toBe(0);
  });
});
