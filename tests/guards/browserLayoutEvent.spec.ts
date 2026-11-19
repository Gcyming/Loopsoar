/**
 * 守卫：chrome:applyLayout（Slice E · 按偏好应用会话窗口布局）的链路一致。
 *
 * 为什么需要：事件名/负载取值都走字符串，类型系统管不到跨进程那一跳；
 * 漏一处就表现为「窗口没按偏好摆」或「preload 白名单拒绝订阅」。
 *   · preload 的订阅白名单直接由 contracts 的 EVENTS 注入（--loopsoar-events），
 *     所以只要 EVENTS 里没有，渲染层 api.on 会抛「事件不在契约白名单」；
 *   · 生成物 EVENT_NAMES 必须与 EVENTS 同步（gen 校验之外再兜一层）；
 *   · 壳层 push 的事件名、UI 订阅的事件名必须与 EVENTS 字面一致。
 *
 * 语义（用户决定 m00974）：不再每次打开网页前询问——默认布局在首次启动向导里选一次，
 * 之后在设置 · 通用里改；壳层只按偏好应用，keep 时不动窗口。
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

  it("UI 类型声明与订阅一致（订阅名必须与契约逐字相同）", () => {
    expect(read("packages/ui/src/types.d.ts")).toContain('"chrome:applyLayout"');
    expect(read("packages/ui/src/useAgentWindowLayout.ts")).toContain('api.on("chrome:applyLayout"');
  });

  it("壳层按偏好推送该事件，mode 只有 docked / agentWindow，keep 不动窗口", () => {
    const main = read("packages/shell/src/main/index.ts");
    expect(main).toContain('pushToRenderer("chrome:applyLayout"');
    expect(main).toContain('const layout = loadPreferences(dirs.configDir).browserOpenLayout ?? "docked"');
    expect(main).toContain('if (layout === "keep") return { proceed: true };');
    // 已删除的「逐次询问」决策模块不许回归（死代码）
    expect(main).not.toContain("browserLayoutChoice");
  });

  it("设置侧只有 docked / agentWindow / keep：不再有「每次询问」策略", () => {
    const schemas = read("packages/contracts/src/validators.ts");
    expect(schemas).toContain('browserOpenLayout: z.enum(["docked", "agentWindow", "keep"]).optional()');
    expect(schemas).not.toContain('browserOpenLayout: z.enum(["ask"');
  });

  it("首启向导承担「选一次」：完成时把选择交给 App 落库", () => {
    expect(read("packages/ui/src/Onboarding.tsx")).toContain("onChooseLayout");
    expect(read("packages/ui/src/App.tsx")).toContain("onChooseLayout");
    expect(read("packages/ui/src/Settings.tsx")).not.toContain("browserOpenLayout.ask");
  });
});
