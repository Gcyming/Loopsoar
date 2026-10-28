/**
 * 守卫：UI 与契约一致（事件白名单 / 布局单一产地 / 会话通道对齐）。
 * 为什么守卫：UI 里写错的字符串不会被类型系统拦住（事件名、域方法名都走字符串），
 * 只能在构建期扫源码兜底，否则表现为「点了没反应」。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { EVENTS, CHANNEL_BINDINGS } from "../../packages/contracts/src/schemas.ts";
import { LAYOUT } from "../../packages/contracts/src/layout.ts";

const ROOT = process.cwd();
const APP_TSX = path.join(ROOT, "packages/ui/src/App.tsx");

function readApp(): string {
  return readFileSync(APP_TSX, "utf8");
}

describe("守卫：UI ↔ 契约一致", () => {
  it("UI 订阅的事件全部在契约 EVENTS 白名单内", () => {
    const src = readApp();
    const used = [...src.matchAll(/api\.on\("([^"]+)"/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const event of used) {
      expect(EVENTS as readonly string[], `UI 订阅了契约外事件 ${event}`).toContain(event);
    }
  });

  it("UI 调用的 IPC 域方法在契约通道中存在", () => {
    const src = readApp();
    // api.<domain>.<method>(  → 映射为 domain:method（runtime.bootStatus 的特例由契约 boot:status 提供）
    const calls = [...src.matchAll(/api\.([a-zA-Z]+)\.([a-zA-Z]+)\(/g)].map((m) => `${m[1]}.${m[2]}`);
    expect(calls.length).toBeGreaterThan(0);
    const methodMap: Record<string, string> = {
      "runtime.status": "boot:status",
      "runtime.version": "app:version",
      "agents.list": "agents:list",
      "settings.getProvider": "settings:getProvider",
      "chat.stream": "chat:stream",
      "chat.stop": "chat:stop",
      "browser.navigate": "browser:navigate",
      "browser.snapshot": "browser:snapshot",
      "browser.screenshot": "browser:screenshot",
      "perm.respond": "perm:respond",
      "window.minimize": "window:minimize",
      "window.maximize": "window:maximize",
      "window.close": "window:close",
      "window.state": "window:state",
    };
    for (const call of calls) {
      const channel = methodMap[call] ?? call.replace(".", ":");
      expect(CHANNEL_BINDINGS[channel], `UI 调用了契约外通道 ${call} → ${channel}`).toBeTruthy();
    }
  });

  it("布局数字只来自契约（UI 不硬编码侧栏/顶栏尺寸）", () => {
    const src = readApp();
    expect(src).toContain("LAYOUT");
    // 硬编码的关键尺寸不允许出现在 UI 里（320/48/32 只应该来自 LAYOUT 引用）
    expect(src).not.toMatch(/SIDEBAR_WIDTH\s*=\s*320/);
    expect(src).not.toMatch(/TOP_BAR_HEIGHT\s*=\s*48/);
    expect(LAYOUT.SIDEBAR_WIDTH).toBe(320);
  });

  it("preload 白名单注入与契约通道一致（index.ts 用 CHANNEL_BINDINGS 构建）", () => {
    const src = readFileSync(path.join(ROOT, "packages/shell/src/main/index.ts"), "utf8");
    expect(src).toContain("CHANNEL_BINDINGS");
    expect(src).toContain("--loopsoar-bindings=");
  });
});
