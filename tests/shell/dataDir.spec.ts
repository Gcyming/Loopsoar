/**
 * LOOPSOAR_DATA_DIR 归一化回归测试。
 *
 * 真机事故：用 `LOOPSOAR_DATA_DIR=.loopsoar-data`（相对路径）启动时，
 * Electron `app.setPath("userData", …)` 直接抛 “Path must be absolute”，
 * 主进程加载失败、只弹一个错误框。这里锁住归一化行为。
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDataDir } from "../../packages/shell/src/main/dataDir.js";

describe("resolveDataDir", () => {
  it("未设置时落到 appData 下的品牌目录", () => {
    expect(resolveDataDir(undefined, "C:/Users/demo/AppData/Roaming")).toBe(
      path.join("C:/Users/demo/AppData/Roaming", "loopsoar"),
    );
  });

  it("空白值视为未设置", () => {
    expect(resolveDataDir("   ", "/appData")).toBe(path.join("/appData", "loopsoar"));
  });

  it("相对路径归一为绝对路径（不再触发 Path must be absolute）", () => {
    const resolved = resolveDataDir(".loopsoar-data", "/appData");
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved).toBe(path.resolve(".loopsoar-data"));
  });

  it("绝对路径保持原样（仅去掉首尾空白）", () => {
    const absolute = path.resolve("/tmp/loopsoar-data");
    expect(resolveDataDir(`  ${absolute}  `, "/appData")).toBe(absolute);
  });
});
