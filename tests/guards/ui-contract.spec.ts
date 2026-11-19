/**
 * 守卫：UI 与契约一致（事件白名单 / 布局单一产地 / 会话通道对齐）。
 * 为什么守卫：UI 里写错的字符串不会被类型系统拦住（事件名、域方法名都走字符串），
 * 只能在构建期扫源码兜底，否则表现为「点了没反应」。
 *
 * 2026-11-02 更新：App.tsx 拆分后事件订阅移动到 useChatStreamEvents.ts 等模块，
 * 扫描目标改为「ui/src 全部源码」，避免拆分后守卫失效（此前只扫 App+Settings）。
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { EVENTS, CHANNEL_BINDINGS } from "../../packages/contracts/src/schemas.ts";
import { LAYOUT } from "../../packages/contracts/src/layout.ts";

const ROOT = process.cwd();
const UI_SRC = path.join(ROOT, "packages/ui/src");

function walkUiFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walkUiFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/** UI 全部界面源码（主界面 + 拆分组件 + 钩子 + 设置面板）。 */
function readAllUi(): string {
  return walkUiFiles(UI_SRC)
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
}

describe("守卫：UI ↔ 契约一致", () => {
  it("UI 订阅的事件全部在契约 EVENTS 白名单内", () => {
    const src = readAllUi();
    const used = [...src.matchAll(/api\??\.on\("([^"]+)"/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const event of used) {
      expect(EVENTS as readonly string[], `UI 订阅了契约外事件 ${event}`).toContain(event);
    }
  });

  it("UI 调用的 IPC 域方法在契约通道中存在", () => {
    const src = readAllUi();
    // api.<domain>.<method>( / api?.<domain>.<method>( → domain:method
    const calls = [...src.matchAll(/api\??\.([a-zA-Z]+)\.([a-zA-Z]+)\(/g)].map((m) => `${m[1]}.${m[2]}`);
    expect(calls.length).toBeGreaterThan(0);
    const methodMap: Record<string, string> = {
      "runtime.status": "boot:status",
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
    const src = readAllUi();
    expect(src).toContain("LAYOUT");
    expect(src).not.toMatch(/SIDEBAR_WIDTH\s*=\s*360/);
    expect(src).not.toMatch(/TOP_BAR_HEIGHT\s*=\s*48/);
    expect(LAYOUT.SIDEBAR_WIDTH).toBe(360);
  });

  it("preload 白名单注入与契约通道一致（index.ts 用 CHANNEL_BINDINGS 构建）", () => {
    const src = readFileSync(path.join(ROOT, "packages/shell/src/main/index.ts"), "utf8");
    expect(src).toContain("CHANNEL_BINDINGS");
    expect(src).toContain("--loopsoar-bindings=");
  });
});

describe("守卫：图标与动效资源", () => {
  const ICONS_DIR = path.join(ROOT, "packages/ui/public/icons");
  const appSrc = readAllUi();

  it("UI 引用的每个图标都在 ui/public/icons 中存在", () => {
    const direct = [...appSrc.matchAll(/<Icon\s+name="([a-z0-9-]+)"/g)].map((m) => m[1]);
    const navIcons = [...appSrc.matchAll(/icon:\s*"([a-z0-9-]+)"/g)].map((m) => m[1]);
    const used = [...direct, ...navIcons];
    expect(used.length).toBeGreaterThan(8);
    for (const name of new Set(used)) {
      expect(existsSync(path.join(ICONS_DIR, `${name}.svg`)), `缺少图标文件 ${name}.svg`).toBe(true);
    }
  });

  it("图标资产来自本地图标库（目录非空、数量达标）", () => {
    const files = readdirSync(ICONS_DIR).filter((f) => f.endsWith(".svg"));
    expect(files.length).toBeGreaterThanOrEqual(20);
    for (const required of ["back.svg", "forward.svg", "reload.svg", "search.svg", "send.svg", "stop.svg"]) {
      expect(files, `缺少核心图标 ${required}`).toContain(required);
    }
  });

  it("交互反馈与动画在样式表中定义（含减动效降级）", () => {
    const html = readFileSync(path.join(ROOT, "packages/ui/index.html"), "utf8");
    for (const keyframe of ["spin", "blink", "streamUnitIn", "pulseDot", "toastIn"]) {
      expect(html, `缺少动画 ${keyframe}`).toContain(`@keyframes ${keyframe}`);
    }
    expect(html).toMatch(/\.icon-btn:active[^{]*\{[^}]*scale\(0\.88\)/);
    expect(html).toContain("prefers-reduced-motion: reduce");
    expect(html).toContain("fadeOnly");
  });
});
