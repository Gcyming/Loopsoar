import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachRendererRecovery } from "../../packages/shell/src/main/rendererRecovery.js";

type Listener = (...args: unknown[]) => void;

class FakeContents {
  readonly listeners = new Map<string, Listener[]>();
  readonly reload = vi.fn();
  readonly loadURL = vi.fn((_url: string) => Promise.resolve());
  osPid = 4242;
  getOSProcessId = vi.fn(() => this.osPid);
  on(event: string, listener: Listener): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

class FakeWindow {
  readonly listeners = new Map<string, Listener[]>();
  destroyed = false;
  visible = true;
  readonly webContents = new FakeContents();
  readonly show = vi.fn(() => {
    this.visible = true;
    this.emit("show");
  });
  readonly focus = vi.fn();
  isDestroyed(): boolean {
    return this.destroyed;
  }
  isVisible(): boolean {
    return this.visible;
  }
  on(event: string, listener: Listener): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

describe("renderer recovery", () => {
  let win: FakeWindow;
  let events: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    win = new FakeWindow();
    events = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function attach() {
    return attachRendererRecovery({
      window: win as never,
      onEvent: (kind) => events.push(kind),
    });
  }

  it("reloads the same window and keeps it visible after a renderer crash", () => {
    attach();
    win.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 133 });

    expect(win.show).toHaveBeenCalledTimes(1);
    expect(win.webContents.reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(249);
    expect(win.webContents.reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(win.webContents.reload).toHaveBeenCalledTimes(1);
    expect(events).toContain("renderer-reload");
  });

  it("does not resurrect a window that is closing with a clean exit", () => {
    attach();
    win.webContents.emit("render-process-gone", {}, { reason: "clean-exit", exitCode: 0 });
    vi.advanceTimersByTime(2_000);
    expect(win.webContents.reload).not.toHaveBeenCalled();
    expect(win.show).not.toHaveBeenCalled();
  });

  it("keeps a hidden window hidden while still recovering its renderer", () => {
    win.visible = false;
    attach();
    win.webContents.emit("render-process-gone", {}, { reason: "killed", exitCode: 1 });
    vi.advanceTimersByTime(300);
    expect(win.show).not.toHaveBeenCalled();
    expect(win.webContents.reload).toHaveBeenCalledTimes(1);
  });

  it("falls back to an actionable page after repeated crashes", () => {
    attach();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      win.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 133 });
      vi.advanceTimersByTime(1_500);
    }
    expect(win.webContents.loadURL).toHaveBeenCalledTimes(1);
    expect(String(win.webContents.loadURL.mock.calls[0]?.[0] ?? "")).toContain("data:text/html");
    expect(events).toContain("renderer-recovery-exhausted");
  });

  it("resets the retry budget after a successful load", () => {
    attach();
    win.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 133 });
    vi.advanceTimersByTime(300);
    expect(win.webContents.reload).toHaveBeenCalledTimes(1);

    win.webContents.emit("did-finish-load");
    win.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 133 });
    vi.advanceTimersByTime(300);
    expect(win.webContents.reload).toHaveBeenCalledTimes(2);
    expect(win.webContents.loadURL).not.toHaveBeenCalled();
  });

  it("reloads a stuck UI after the unresponsive grace period", () => {
    attach();
    win.webContents.emit("unresponsive");
    vi.advanceTimersByTime(9_999);
    expect(win.webContents.reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    vi.advanceTimersByTime(250);
    expect(win.webContents.reload).toHaveBeenCalledTimes(1);
    expect(events).toContain("renderer-reload");
  });

  it("cancels a pending unresponsive reload when the page recovers", () => {
    attach();
    win.webContents.emit("unresponsive");
    vi.advanceTimersByTime(1_000);
    win.webContents.emit("responsive");
    vi.advanceTimersByTime(20_000);
    expect(win.webContents.reload).not.toHaveBeenCalled();
  });
});
