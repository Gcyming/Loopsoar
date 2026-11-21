/**
 * 主进程日志落盘回归测试（安装包排查）：
 *   · console.error/warn 复制到 main.log，且保留原输出；
 *   · 密钥被脱敏；
 *   · restore 后不再写文件。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMainLog } from "../../packages/shell/src/main/mainLog.js";

let dir = "";
let handle: ReturnType<typeof installMainLog> | null = null;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-mainlog-"));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  handle?.restore();
  handle = null;
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe("installMainLog", () => {
  it("error/warn 写入 logs/main.log，普通 log 不写", () => {
    handle = installMainLog(dir);
    console.error("boom", { code: 1 });
    console.warn("careful");
    console.log("ignored");
    const text = fs.readFileSync(handle.file, "utf8");
    expect(text).toContain("ERROR boom");
    expect(text).toContain("WARN careful");
    expect(text).not.toContain("ignored");
  });

  it("异常对象写堆栈，密钥被脱敏", () => {
    handle = installMainLog(dir);
    console.error(new Error("failed with sk-abcdefgh12345678"));
    const text = fs.readFileSync(handle.file, "utf8");
    expect(text).toContain("Error: failed with");
    expect(text).not.toContain("sk-abcdefgh12345678");
    expect(text).toContain("sk-[redacted]");
  });

  it("restore 后恢复原 console，不再追加", () => {
    handle = installMainLog(dir);
    console.error("before");
    handle.restore();
    console.error("after");
    const text = fs.readFileSync(handle.file, "utf8");
    expect(text).toContain("before");
    expect(text).not.toContain("after");
  });

  it("超过上限轮转到 main.log.1", () => {
    handle = installMainLog(dir, { maxBytes: 10 });
    console.error("x".repeat(64));
    console.error("y".repeat(64));
    expect(fs.existsSync(`${handle.file}.1`)).toBe(true);
  });
});
