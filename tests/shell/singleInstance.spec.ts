/**
 * 单实例守卫回归：锁不可用时必须继续启动（打不开比多开更糟），
 * 只有「PID 锁被存活进程持有」才退出。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSingleInstance } from "../../packages/shell/src/main/singleInstance.js";

let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-single-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function fakeApp(lockResult: boolean) {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  return {
    requestSingleInstanceLock: vi.fn(() => lockResult),
    quit: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
    }),
    handlers,
  };
}

describe("ensureSingleInstance", () => {
  it("拿到 PID 锁且 Chromium 锁可用 → 正常启动并注册 second-instance", () => {
    const app = fakeApp(true);
    const onSecond = vi.fn();
    expect(ensureSingleInstance(app as never, onSecond, { dataDir: dir, log: () => undefined })).toBe(true);
    expect(fs.readFileSync(path.join(dir, "instance.lock"), "utf8")).toBe(String(process.pid));
    expect(app.handlers.has("second-instance")).toBe(true);
    app.handlers.get("will-quit")?.();
    expect(fs.existsSync(path.join(dir, "instance.lock"))).toBe(false);
  });

  it("PID 锁被存活进程持有 → 第二个实例退出（先申请 Chromium 锁以转交 URL）", () => {
    fs.writeFileSync(path.join(dir, "instance.lock"), String(process.pid));
    const app = fakeApp(false);
    const logs: string[] = [];
    expect(
      ensureSingleInstance(app as never, () => undefined, { dataDir: dir, log: (m) => logs.push(m), exit: () => undefined }),
    ).toBe(false);
    expect(app.requestSingleInstanceLock).toHaveBeenCalled();
    expect(app.quit).toHaveBeenCalled();
    expect(logs.join("\n")).toContain("已有实例在运行");
  });

  it("残留的死 PID 锁 → 清理后继续", () => {
    fs.writeFileSync(path.join(dir, "instance.lock"), "999999");
    const app = fakeApp(false);
    expect(ensureSingleInstance(app as never, () => undefined, { dataDir: dir, log: () => undefined })).toBe(true);
    expect(fs.readFileSync(path.join(dir, "instance.lock"), "utf8")).toBe(String(process.pid));
  });

  it("锁文件不可写（数据目录是普通文件）→ 记警告但继续启动", () => {
    const bogus = path.join(dir, "not-a-dir");
    fs.writeFileSync(bogus, "x");
    const app = fakeApp(false);
    const logs: string[] = [];
    expect(ensureSingleInstance(app as never, () => undefined, { dataDir: bogus, log: (m) => logs.push(m) })).toBe(true);
    expect(app.quit).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("PID 锁不可用");
  });

  it("Chromium 锁不可用但 PID 锁成功 → 继续启动（不退出）", () => {
    const app = fakeApp(false);
    const logs: string[] = [];
    expect(ensureSingleInstance(app as never, () => undefined, { dataDir: dir, log: (m) => logs.push(m) })).toBe(true);
    expect(app.quit).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("Chromium 单实例锁不可用");
  });
});
