/**
 * 浏览器桥行为级用例 ①：preload 沙箱（不依赖 Electron，用 node:vm 加载真实 CJS 预加载脚本）。
 *
 * 攻击面：网页侧（渲染层）能拿到什么？本用例证明：
 *   - 只暴露 window.loopsoarAPI 一个对象，不暴露 ipcRenderer / require / process；
 *   - 域方法只能是契约白名单里的通道（`loopsoar:<channel>` 前缀，由主进程注入）；
 *   - 事件订阅只认契约事件白名单，白名单外直接抛错；
 *   - 返回的撤销函数真的调用 ipcRenderer.removeListener（不泄漏监听）。
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CHANNEL_BINDINGS } from "../../packages/contracts/src/schemas.ts";
import { EVENT_NAMES } from "../../packages/contracts/gen/ipc.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD_PATH = path.resolve(HERE, "../../packages/shell/src/preload/index.cjs");
const preloadSource = fs.readFileSync(PRELOAD_PATH, "utf8");

type Listener = (event: unknown, data: unknown) => void;

interface PreloadHarness {
  api: Record<string, any>;
  exposed: Array<{ name: string; api: Record<string, any> }>;
  invokes: Array<{ channel: string; payload: unknown }>;
  listeners: Map<string, Listener>;
  removed: Array<{ channel: string; listener: Listener }>;
}

/** 契约 → preload 注入参数（与 main/index.ts buildBindings 同源）。 */
function contractBindings(): Array<{ channel: string; domain: string; method: string }> {
  return Object.entries(CHANNEL_BINDINGS).map(([channel, binding]) => ({
    channel,
    domain: binding.domain,
    method: binding.method,
  }));
}

function loadPreload(options: { argv?: string[]; bindings?: unknown[] } = {}): PreloadHarness {
  const harness: PreloadHarness = {
    api: {},
    exposed: [],
    invokes: [],
    listeners: new Map(),
    removed: [],
  };
  const electronMock = {
    contextBridge: {
      exposeInMainWorld(name: string, api: Record<string, any>) {
        harness.exposed.push({ name, api });
      },
    },
    ipcRenderer: {
      async invoke(channel: string, payload: unknown) {
        harness.invokes.push({ channel, payload });
        return { ok: true };
      },
      on(channel: string, listener: Listener) {
        harness.listeners.set(channel, listener);
      },
      removeListener(channel: string, listener: Listener) {
        harness.removed.push({ channel, listener });
      },
    },
  };
  const bindings = options.bindings ?? contractBindings();
  const argv = options.argv ?? [
    "electron",
    "preload/index.cjs",
    `--loopsoar-bindings=${JSON.stringify(bindings)}`,
    `--loopsoar-events=${JSON.stringify([...EVENT_NAMES])}`,
  ];
  const sandbox: Record<string, unknown> = {
    require: (id: string) => {
      if (id === "electron") return electronMock;
      throw new Error(`preload 只允许 require("electron")，实际：${id}`);
    },
    process: { argv },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(preloadSource, sandbox, { filename: "packages/shell/src/preload/index.cjs" });
  harness.api = harness.exposed[0]?.api ?? {};
  return harness;
}

describe("preload 沙箱（行为级）", () => {
  it("只暴露一次 window.loopsoarAPI", () => {
    const harness = loadPreload();
    expect(harness.exposed).toHaveLength(1);
    expect(harness.exposed[0].name).toBe("loopsoarAPI");
    expect(typeof harness.exposed[0].api).toBe("object");
  });

  it("不暴露 ipcRenderer / require / process 等主进程能力", () => {
    const harness = loadPreload();
    const api = harness.api;
    expect("ipcRenderer" in api).toBe(false);
    expect("require" in api).toBe(false);
    expect("process" in api).toBe(false);
    // 预加载脚本里 ipcRenderer 只以闭包形式存在于方法内部，不应出现在 API 对象上
    expect(Object.keys(api)).not.toContain("ipcRenderer");
    expect(api.chat).toBeTruthy();
    expect(typeof api.chat.send).toBe("function");
  });

  it("域方法只来自契约白名单：调用走 loopsoar:<channel> 前缀并透传 payload", async () => {
    const harness = loadPreload();
    const bindings = contractBindings();
    for (const binding of bindings) {
      expect(typeof harness.api[binding.domain]?.[binding.method], `${binding.channel} 未暴露`).toBe(
        "function",
      );
    }
    await harness.api.chat.send({ message: "hi", sessionId: "sess-1" });
    expect(harness.invokes[0]).toEqual({
      channel: "loopsoar:chat:send",
      payload: { message: "hi", sessionId: "sess-1" },
    });
    // 新增的 /compact 通道必须在 preload 白名单里（否则 UI 调不到）
    expect(bindings.some((binding) => binding.channel === "chat:compact")).toBe(true);
    expect(typeof harness.api.chat.compact).toBe("function");
  });

  it("事件订阅只认契约白名单；白名单外直接抛错", () => {
    const harness = loadPreload();
    expect(() => harness.api.on("evil:event", () => {})).toThrow(/不在契约白名单/);
    // 契约事件（含 /compact 的 chat:compacted）全部可订阅
    for (const event of EVENT_NAMES) {
      expect(() => harness.api.on(event, () => {}), `${event} 应可订阅`).not.toThrow();
    }
    expect(EVENT_NAMES).toContain("chat:compacted");
  });

  it("on() 的监听只收到 data（不含 Electron event），且撤销函数真的解绑", () => {
    const harness = loadPreload();
    const received: unknown[] = [];
    const off = harness.api.on("chat:compacted", (data: unknown) => received.push(data));
    expect(typeof off).toBe("function");

    const listener = harness.listeners.get("loopsoar:chat:compacted");
    expect(listener).toBeTruthy();
    listener?.({ sender: "electron-event" }, { sessionId: "sess-1", dropped: 3 });
    expect(received).toEqual([{ sessionId: "sess-1", dropped: 3 }]);

    off();
    expect(harness.removed).toHaveLength(1);
    expect(harness.removed[0].channel).toBe("loopsoar:chat:compacted");
    expect(harness.removed[0].listener).toBe(listener);
  });

  it("空注入参数（无 bindings/events）不崩溃，只保留 on", () => {
    const harness = loadPreload({ argv: ["electron", "preload/index.cjs"] });
    expect(Object.keys(harness.api)).toEqual(["on"]);
    expect(() => harness.api.on("chat:compacted", () => {})).toThrow(/不在契约白名单/);
  });
});
