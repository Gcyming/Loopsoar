/**
 * 守卫：chrome:applyLayout（Slice E · 询问后应用会话窗口布局）的链路一致。
 *
 * 为什么需要：事件名/负载取值都走字符串，类型系统管不到跨进程那一跳；
 * 漏一处就表现为「询问完了但窗口没动」或「preload 白名单拒绝订阅」。
 *   · preload 的订阅白名单直接由 contracts 的 EVENTS 注入（--loopsoar-events），
 *     所以只要 EVENTS 里没有，渲染层 api.on 会抛「事件不在契约白名单」；
 *   · 生成物 EVENT_NAMES 必须与 EVENTS 同步（gen 校验之外再兜一层）；
 *   · 壳层 push 的事件名、UI 订阅的事件名必须与 EVENTS 字面一致。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { EVENTS } from "../../packages/contracts/src/schemas.ts";
import { EVENT_NAMES } from "../../packages/contracts/gen/ipc.ts";

const ROOT = process.cwd();
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");

describe("守卫：chrome:applyLayout 事件链路", () => {
  it("契约 EVENTS 与生成物 EVENT_NAMES 都包含该事件", () => {
    expect(EVENTS as readonly string[]).toContain("chrome:applyLayout");
    expect(EVENT_NAMES as readonly string[]).toContain("chrome:applyLayout");
  });

  it("UI 类型声明与 App 订阅一致（订阅名必须与契约逐字相同）", () => {
    expect(read("packages/ui/src/types.d.ts")).toContain('"chrome:applyLayout"');
    expect(read("packages/ui/src/App.tsx")).toContain('api.on("chrome:applyLayout"');
  });

  it("壳层推送该事件，且负载 mode 只有 docked / agentWindow 两种", () => {
    expect(read("packages/shell/src/main/index.ts")).toContain('pushToRenderer("chrome:applyLayout"');
    const decision = read("packages/shell/src/main/browserLayoutChoice.ts");
    expect(decision).toContain('export type BrowserLayoutMode = "docked" | "agentWindow"');
    // 负载里的 mode 直接来自上面这个联合类型，不允许出现第三态
    expect(read("packages/shell/src/main/index.ts")).toContain("apply: (mode, reason) => pushToRenderer");
  });

  it("设置侧的四种策略仍是 ask / docked / agentWindow / keep（与决策模块同一口径）", () => {
    const schemas = read("packages/contracts/src/schemas.ts");
    expect(schemas).toContain('browserOpenLayout: z.enum(["ask", "docked", "agentWindow", "keep"]).optional()');
    const decision = read("packages/shell/src/main/browserLayoutChoice.ts");
    expect(decision).toContain('export type BrowserLayoutPreference = "ask" | "docked" | "agentWindow" | "keep"');
  });
});
