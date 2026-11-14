/**
 * 权限等级 L0–L5 形式化：命名/元信息/映射必须与 core/sandbox.ts 的刻度严格对齐。
 * 为什么单独测：等级是「策略展示 + 审计 + 报告」的共同语言，一旦与 sandbox.kindToLevel 漂移，
 * 用户看到的等级就不再是实际执行等级（比没有分级更糟）。
 */
import { describe, expect, it } from "vitest";
import {
  SANDBOX_LEVELS,
  PERMISSION_LEVELS,
  levelForPermissionKind,
  levelForTool,
  categoryForToolPermissions,
  type PermissionLevel,
} from "../../packages/core/src/permissions.ts";
import { DEFAULT_LEVEL_POLICY, kindToLevel, type SandboxLevel } from "../../packages/core/src/sandbox.ts";

const KINDS = ["read", "write", "terminal", "network"] as const;

describe("权限等级 L0–L5：命名与元信息", () => {
  it("SANDBOX_LEVELS 是 0–5 的固定命名表", () => {
    expect(SANDBOX_LEVELS).toEqual({
      0: "L0_READ",
      1: "L1_INSPECT",
      2: "L2_WRITE",
      3: "L3_EXEC",
      4: "L4_NETWORK",
      5: "L5_SYSTEM",
    });
  });

  it("PERMISSION_LEVELS 覆盖 0–5 且 name 与 SANDBOX_LEVELS 一致", () => {
    expect(PERMISSION_LEVELS).toHaveLength(6);
    for (const meta of PERMISSION_LEVELS) {
      expect(meta.level).toBeGreaterThanOrEqual(0);
      expect(meta.level).toBeLessThanOrEqual(5);
      expect(meta.name).toBe(SANDBOX_LEVELS[meta.level as PermissionLevel]);
      expect(meta.zh.length).toBeGreaterThan(0);
      expect(meta.en.length).toBeGreaterThan(0);
      expect(meta.description.length).toBeGreaterThan(0);
    }
    // 顺序即 0→5
    expect(PERMISSION_LEVELS.map((m) => m.level)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("权限等级：与 sandbox 刻度对齐（不破坏既有 API）", () => {
  it("levelForPermissionKind 与 kindToLevel 逐项相等", () => {
    for (const kind of KINDS) {
      const mine = levelForPermissionKind(kind);
      const theirs: SandboxLevel = kindToLevel(kind);
      expect(mine).toBe(theirs);
    }
    // 显式钉死映射，避免两边一起改错
    expect(levelForPermissionKind("read")).toBe(0);
    expect(levelForPermissionKind("write")).toBe(2);
    expect(levelForPermissionKind("terminal")).toBe(3);
    expect(levelForPermissionKind("network")).toBe(4);
  });

  it("等级默认策略与 sandbox 的 DEFAULT_LEVEL_POLICY 一致（L0/L1 自动、L2–L4 确认、L5 拒绝）", () => {
    for (const kind of KINDS) {
      const level = levelForPermissionKind(kind);
      const policy = DEFAULT_LEVEL_POLICY[level];
      if (level <= 1) expect(policy).toBe("auto");
      else if (level === 5) expect(policy).toBe("deny");
      else expect(policy).toBe("confirm");
    }
    expect(DEFAULT_LEVEL_POLICY[5]).toBe("deny");
  });
});

describe("levelForTool：工具声明 → 等级", () => {
  it("四类权限标志位映射到 L0–L4", () => {
    expect(levelForTool("file_write", { write: true })).toBe(2);
    expect(levelForTool("terminal_run", { terminal: true })).toBe(3);
    expect(levelForTool("browser_navigate", { network: true })).toBe(4);
  });

  it("read 类再细分：纯读取 L0 / 查看探测 L1", () => {
    expect(levelForTool("file_read", { read: true })).toBe(0);
    expect(levelForTool("read_file", { read: true })).toBe(0);
    expect(levelForTool("browser_snapshot", { read: true })).toBe(1);
    expect(levelForTool("memory_list", { read: true })).toBe(1);
    expect(levelForTool("terminal_history", { read: true })).toBe(1);
    expect(levelForTool("browser_scroll", { read: true })).toBe(1);
  });

  it("多标志位按 terminal > network > write > read 的优先级归类（与 categoryForToolPermissions 一致）", () => {
    const both = { terminal: true, write: true };
    expect(levelForTool("mixed_tool", both)).toBe(3);
    expect(categoryForToolPermissions(both)).toBe("terminal");
    const netWrite = { network: true, write: true };
    expect(levelForTool("mixed_tool", netWrite)).toBe(4);
    expect(categoryForToolPermissions(netWrite)).toBe("network");
  });

  it("browser 比 network 更具体：策略归类取 browser，沙箱等级仍是 L4", () => {
    // 策略层：browser 优先（否则 browser 档永远被 network 接走，永远不会生效）
    expect(categoryForToolPermissions({ browser: true })).toBe("browser");
    expect(categoryForToolPermissions({ browser: true, network: true })).toBe("browser");
    expect(categoryForToolPermissions({ browser: true, terminal: true })).toBe("browser");
    // 沙箱层不新增档位：浏览器动作仍然是 L4 网络访问（PermissionKind 未扩展，等式断言在上面）
    expect(levelForTool("browser_click", { browser: true })).toBe(4);
    expect(levelForTool("browser_navigate", { browser: true })).toBe(4);
    expect(levelForPermissionKind("network")).toBe(4);
    // 未声明 browser 的抓取工具不受影响
    expect(categoryForToolPermissions({ network: true })).toBe("network");
  });

  it("无法归类 → L5（fail-closed）", () => {
    expect(levelForTool("mystery_tool", {})).toBe(5);
    expect(levelForTool("mystery_tool")).toBe(5);
    expect(levelForTool("mystery_tool", null)).toBe(5);
    expect(levelForTool("mystery_tool", { read: false, write: false })).toBe(5);
  });
});
