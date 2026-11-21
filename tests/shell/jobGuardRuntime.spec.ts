/**
 * 进程树守护接线回归（发布阶段 §4.2：强杀后不留孤儿进程）。
 * 守护实现是 Windows Job Object（C# exe），这里锁「怎么找 exe、怎么拉起、失败是否降级」。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  jobGuardCandidates,
  resolveJobGuardPath,
  startJobGuard,
} from "../../packages/shell/src/main/jobGuardRuntime.js";

let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-guard-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("jobGuardCandidates / resolveJobGuardPath", () => {
  it("优先 resourcesPath，其次 dist/src 上级 resources", () => {
    const list = jobGuardCandidates({ moduleDir: "C:/app/resources/app.asar/dist", resourcesPath: "C:/app/resources" });
    expect(list[0]).toBe(path.join("C:/app/resources", "jobGuard.exe"));
    expect(list.some((item) => item.includes(path.join("app.asar", "resources", "jobGuard.exe")))).toBe(true);
  });

  it("文件存在时返回真实路径，否则 null", () => {
    const resources = path.join(dir, "resources");
    fs.mkdirSync(resources, { recursive: true });
    fs.writeFileSync(path.join(resources, "jobGuard.exe"), "MZ");
    expect(resolveJobGuardPath({ moduleDir: path.join(dir, "dist"), resourcesPath: resources })).toBe(
      path.join(resources, "jobGuard.exe"),
    );
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-guard-empty-"));
    try {
      expect(resolveJobGuardPath({ moduleDir: empty })).toBeNull();
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("startJobGuard", () => {
  it("非 Windows 直接跳过", () => {
    const spawnFn = vi.fn();
    expect(startJobGuard({ guardPath: "x", pid: 1, platform: "darwin", spawnFn: spawnFn as never })).toBe(false);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("缺少守护 exe 时降级并记录，不影响启动", () => {
    const logs: string[] = [];
    expect(
      startJobGuard({ guardPath: null, pid: 1, platform: "win32", log: (message) => logs.push(message) }),
    ).toBe(false);
    expect(logs.join("\n")).toContain("进程树守护未启用");
  });

  it("Windows 下以 detached + 忽略 stdio 拉起并 unref", () => {
    const unref = vi.fn();
    const spawnFn = vi.fn(() => ({ unref }));
    const ok = startJobGuard({
      guardPath: "C:/app/resources/jobGuard.exe",
      pid: 4321,
      platform: "win32",
      spawnFn: spawnFn as never,
      log: () => undefined,
    });
    expect(ok).toBe(true);
    expect(spawnFn).toHaveBeenCalledWith("C:/app/resources/jobGuard.exe", ["4321"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    expect(unref).toHaveBeenCalled();
  });
});
