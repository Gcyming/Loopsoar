/**
 * Agent 覆盖指针（应用级窗口）：懒创建、几何贴网页、光标/高亮/涟漪/键盘提示、空闲隐藏。
 * 纯逻辑 + 假窗口，不依赖 electron。
 */
import { describe, expect, it } from "vitest";
import {
  buildPointerHtml,
  createAgentPointerWindow,
  type PointerWindowLike,
} from "../../packages/shell/src/main/agentPointerWindow.ts";

interface FakeWindow extends PointerWindowLike {
  bounds: { x: number; y: number; width: number; height: number } | null;
  shown: boolean;
  hidden: boolean;
  ignored: boolean;
  scripts: string[];
}

function makeFakeWindow(): FakeWindow {
  const win: FakeWindow = {
    bounds: null,
    shown: false,
    hidden: false,
    ignored: false,
    scripts: [],
    setBounds(bounds) {
      win.bounds = bounds;
    },
    loadURL() {
      return Promise.resolve();
    },
    showInactive() {
      win.shown = true;
      win.hidden = false;
    },
    hide() {
      win.hidden = true;
    },
    setIgnoreMouseEvents(ignore) {
      win.ignored = ignore;
    },
    moveTop() {},
    destroy() {},
    webContents: {
      async executeJavaScript(code: string) {
        win.scripts.push(code);
        return true;
      },
    },
  };
  return win;
}

function makeController() {
  const wins: FakeWindow[] = [];
  const timers = new Map<number, () => void>();
  let seq = 0;
  const controller = createAgentPointerWindow({
    createWindow: () => {
      const win = makeFakeWindow();
      wins.push(win);
      return win;
    },
    idleHideMs: 1000,
    setTimeoutFn: (callback) => {
      seq += 1;
      timers.set(seq, callback);
      return seq;
    },
    clearTimeoutFn: (handle) => {
      timers.delete(handle as number);
    },
  });
  return { controller, wins, timers };
}

/** 等 loadURL 的 then 链跑完（两次微任务）。 */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("覆盖指针 · 文档与素材", () => {
  it("HTML 内联用户提供的箭头 SVG，并提供 __lsPointer 入口", () => {
    const html = decodeURIComponent(buildPointerHtml().replace("data:text/html;charset=utf-8,", ""));
    expect(html).toContain("__lsPointer");
    expect(html).toContain("M146.928 122.768");
    expect(html).toContain("#cursor");
    expect(html).toContain("border-radius:999px");
  });
});

describe("覆盖指针 · 生命周期", () => {
  it("setArea 不创建窗口（懒）；第一次动作才创建并贴住网页矩形", async () => {
    const { controller, wins } = makeController();
    controller.setArea({ x: 10, y: 20, width: 300, height: 200 });
    expect(wins.length).toBe(0);

    controller.moveTo(140, 90);
    await settle();
    expect(wins.length).toBe(1);
    expect(wins[0].bounds).toEqual({ x: 10, y: 20, width: 300, height: 200 });
    expect(wins[0].shown).toBe(true);
    expect(wins[0].ignored).toBe(true);
    const last = wins[0].scripts[wins[0].scripts.length - 1];
    expect(last).toContain("__lsPointer");
    expect(last).toContain('"x":140');
    expect(last).toContain('"y":90');
  });

  it("点击产生涟漪序号、键盘提示带文案；地址变更后窗口跟随", async () => {
    const { controller, wins } = makeController();
    controller.setArea({ x: 0, y: 0, width: 200, height: 100 });
    controller.moveTo(50, 40);
    await settle();
    controller.click(50, 40);
    await settle();
    const clickScript = wins[0].scripts[wins[0].scripts.length - 1];
    expect(clickScript).toContain('"ripple":1');

    controller.chip("⌨ Enter");
    await settle();
    expect(wins[0].scripts[wins[0].scripts.length - 1]).toContain("⌨ Enter");

    controller.setArea({ x: 40, y: 60, width: 400, height: 300 });
    expect(wins[0].bounds).toEqual({ x: 40, y: 60, width: 400, height: 300 });
  });

  it("空闲计时到点隐藏；setArea(null) 立即隐藏", async () => {
    const { controller, wins, timers } = makeController();
    controller.setArea({ x: 0, y: 0, width: 200, height: 100 });
    controller.moveTo(30, 30);
    await settle();
    const pending = [...timers.values()];
    expect(pending.length).toBeGreaterThan(0);
    pending[pending.length - 1]();
    expect(wins[0].hidden).toBe(true);

    controller.setArea(null);
    expect(wins[0].hidden).toBe(true);
  });
});
