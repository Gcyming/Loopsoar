/**
 * 终端会话管理：生命周期 / 幂等 / 并发上限 / cwd 约束等纯逻辑部分。
 *
 * 为什么不真实 spawn 持久终端：受限环境里交互子进程可能拖住测试进程，且结果依赖本机
 * 解释器安装情况，容易变成 flaky 测试；真实 shell 交互由 Lead 在非受限会话做手工冒烟。
 * 需要覆盖的安全语义（越界/上限/未知 id/幂等）都可以在 spawn 之前断言到。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  TerminalSessionManager,
  isPathWithin,
  resolveCwdWithin,
} from "../../packages/shell/src/main/terminalSession.ts";
import { resolveProfile, type TerminalProfileKey } from "../../packages/shell/src/main/terminalProfiles.ts";

let root = "";
let outside = "";

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-term-session-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-term-session-out-"));
});

afterAll(() => {
  for (const dir of [root, outside]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
    } catch {
      // Windows 上句柄释放稍慢，清理失败不影响断言
    }
  }
});

interface PushRecord {
  event: string;
  payload: unknown;
}

function makeManager(options?: { maxSessions?: number; idleMs?: number; workspaceRoot?: string }) {
  const pushes: PushRecord[] = [];
  const manager = new TerminalSessionManager({
    resolveWorkspaceRoot: () => options?.workspaceRoot ?? root,
    push: (event, payload) => {
      pushes.push({ event, payload });
    },
    maxSessions: options?.maxSessions,
    idleMs: options?.idleMs,
  });
  return { manager, pushes };
}

function firstAvailableProfile(): TerminalProfileKey | null {
  for (const key of ["cmd", "gitbash", "powershell", "node"] as const) {
    if (resolveProfile(key)?.available) return key;
  }
  return null;
}

describe("终端会话管理（纯逻辑）", () => {
  it("空管理器：列表为空，未知终端操作全部安全失败且幂等", () => {
    const { manager } = makeManager();
    expect(manager.list()).toEqual([]);
    expect(manager.history("term-does-not-exist")).toBeNull();
    expect(manager.input("term-does-not-exist", "ls\r\n")).toEqual({
      ok: false,
      error: "终端不存在或已关闭",
    });
    expect(manager.interrupt("term-does-not-exist")).toBe(false);
    expect(manager.close("term-does-not-exist")).toBe(false);
    expect(manager.closeSession("no-such-session")).toBe(0);
    expect(() => manager.closeAll()).not.toThrow();
    expect(() => manager.closeAll()).not.toThrow(); // 幂等
  });

  it("open 未知配置档 → reject，不产生会话也不推事件", async () => {
    const { manager, pushes } = makeManager();
    await expect(manager.open({ profile: "bash" as never })).rejects.toThrow(/未知终端配置档/);
    expect(manager.list()).toEqual([]);
    expect(pushes).toEqual([]);
  });

  it("并发上限：maxSessions=0 时 open 直接拒绝", async () => {
    const profile = firstAvailableProfile();
    if (!profile) return; // 极端环境（无任何可用 shell）下跳过
    const { manager } = makeManager({ maxSessions: 0 });
    await expect(manager.open({ profile })).rejects.toThrow(/上限/);
    expect(manager.list()).toEqual([]);
  });

  it("cwd 越界 / 不存在 → 在 spawn 之前拒绝，不留下半初始化会话", async () => {
    const profile = firstAvailableProfile();
    if (!profile) return;
    const { manager } = makeManager();
    await expect(manager.open({ profile, cwd: outside })).rejects.toThrow(/越界/);
    await expect(manager.open({ profile, cwd: "no-such-dir-for-test" })).rejects.toThrow(/不存在/);
    expect(manager.list()).toEqual([]);
  });

  it("profiles() 返回契约枚举内的六项", async () => {
    const { manager } = makeManager();
    const profiles = await manager.profiles();
    expect(profiles).toHaveLength(6);
    expect(profiles.map((profile) => profile.key)).toEqual([
      "cmd",
      "powershell",
      "gitbash",
      "python",
      "node",
      "cpp",
    ]);
  });

  it("list() 返回副本，外部修改不影响内部状态", () => {
    const { manager } = makeManager();
    const listed = manager.list();
    listed.push({
      terminalId: "term-fake",
      sessionId: "s",
      profile: "cmd",
      cwd: root,
      state: "ready",
      createdAt: 0,
      label: "fake",
    });
    expect(manager.list()).toEqual([]);
  });
});

describe("路径边界纯函数", () => {
  it("isPathWithin 判断工作根内外", () => {
    expect(isPathWithin(root, root)).toBe(true);
    expect(isPathWithin(root, path.join(root, "a", "b"))).toBe(true);
    expect(isPathWithin(root, outside)).toBe(false);
    if (process.platform === "win32") {
      // Windows 路径大小写不敏感：大小写变体仍视为根内
      expect(isPathWithin(root, root.toUpperCase())).toBe(true);
    }
  });

  it("resolveCwdWithin 拒绝越界 / 不存在 / 非文件夹", () => {
    expect(resolveCwdWithin(root)).toBe(fs.realpathSync.native(root));
    expect(() => resolveCwdWithin(root, outside)).toThrow(/越界/);
    expect(() => resolveCwdWithin(root, path.join("..", path.basename(outside)))).toThrow(/越界/);
    expect(() => resolveCwdWithin(root, "missing-dir")).toThrow(/不存在/);
    const filePath = path.join(root, "file.txt");
    fs.writeFileSync(filePath, "x", "utf8");
    expect(() => resolveCwdWithin(root, "file.txt")).toThrow(/不是文件夹/);
  });
});
