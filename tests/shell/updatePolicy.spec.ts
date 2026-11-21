/**
 * 自动更新门禁（发布阶段 §6.2）：只有下载完成、且没有 Agent 回合在跑时才允许安装。
 */
import { describe, expect, it } from "vitest";
import { canCheckForUpdate, canDownloadUpdate, canInstallUpdate } from "../../packages/shell/src/main/updatePolicy.js";

describe("canInstallUpdate", () => {
  it("未下载/未启用都拒绝", () => {
    expect(canInstallUpdate({ state: "disabled" }, false).ok).toBe(false);
    expect(canInstallUpdate({ state: "available" }, false).ok).toBe(false);
    expect(canInstallUpdate({ state: "downloading" }, false).ok).toBe(false);
    expect(canInstallUpdate({ state: "downloaded" }, false).ok).toBe(true);
  });

  it("Agent 运行中禁止安装（不允许静默重启打断任务）", () => {
    const decision = canInstallUpdate({ state: "downloaded" }, true);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.error).toContain("Agent 正在运行");
  });
});

describe("按钮可用性", () => {
  it("检查：disabled/checking/downloading 不可点", () => {
    expect(canCheckForUpdate({ state: "disabled" })).toBe(false);
    expect(canCheckForUpdate({ state: "checking" })).toBe(false);
    expect(canCheckForUpdate({ state: "downloading" })).toBe(false);
    expect(canCheckForUpdate({ state: "idle" })).toBe(true);
  });

  it("下载：只有 available 可点", () => {
    expect(canDownloadUpdate({ state: "available" })).toBe(true);
    expect(canDownloadUpdate({ state: "idle" })).toBe(false);
  });
});
