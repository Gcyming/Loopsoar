/**
 * 审计落盘（JSONL）：写读往返、字段截断、5MB 轮转（小阈值模拟）、flush、目录自动创建、跨天换文件。
 * 审计是旁路：任何异常都不能抛出影响主流程。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditFileLogger } from "../../packages/shell/src/main/auditFile.ts";

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-audit-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function readLines(file: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function auditFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => /^audit-\d{8}(\.\d+)?\.jsonl$/.test(name)).sort();
}

/** 2026-11-02 10:00 本地时间（与测试运行时区无关的「固定一天」）。 */
const DAY = new Date(2026, 10, 2, 10, 0, 0).getTime();

describe("AuditFileLogger", () => {
  it("append → flush → 读回 JSONL（按日期命名，字段完整）", async () => {
    const dir = tempDir();
    const logger = new AuditFileLogger({ dir, now: () => DAY });
    logger.append({ channel: "chat:stream", sender: "loopsoar://app/index.html", status: "ok" });
    logger.append({ channel: "file:write", sender: "loopsoar://app/index.html", status: "rejected", reason: "参数校验失败" });
    await logger.flush();

    const file = path.join(dir, "audit-20261102.jsonl");
    expect(fs.existsSync(file)).toBe(true);
    const lines = readLines(file);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ channel: "chat:stream", status: "ok", sender: "loopsoar://app/index.html" });
    expect(lines[1]).toMatchObject({ channel: "file:write", status: "rejected", reason: "参数校验失败" });
    expect(typeof lines[0].ts).toBe("string");
    expect(logger.stats().queued).toBe(0);
    expect(logger.stats().file).toBe(file);
    expect(logger.stats().bytes).toBeGreaterThan(0);
  });

  it("字段截断：channel ≤120、reason ≤500、sender ≤512", async () => {
    const dir = tempDir();
    const logger = new AuditFileLogger({ dir, now: () => DAY });
    logger.append({
      channel: "c".repeat(500),
      sender: "s".repeat(900),
      status: "rejected",
      reason: "r".repeat(2000),
    });
    await logger.flush();
    const [line] = readLines(path.join(dir, "audit-20261102.jsonl"));
    expect((line.channel as string).length).toBe(120);
    expect((line.reason as string).length).toBe(500);
    expect((line.sender as string).length).toBe(512);
  });

  it("目录不存在自动创建（多级）", async () => {
    const dir = path.join(tempDir(), "nested", "logs");
    expect(fs.existsSync(dir)).toBe(false);
    const logger = new AuditFileLogger({ dir, now: () => DAY });
    logger.append({ channel: "app:version", sender: "-", status: "ok" });
    await logger.flush();
    expect(auditFiles(dir)).toEqual(["audit-20261102.jsonl"]);
    expect(readLines(path.join(dir, "audit-20261102.jsonl")).length).toBe(1);
  });

  it("轮转：超过 maxBytes 归档为 audit-YYYYMMDD.N.jsonl，最多保留 keepFiles 份", async () => {
    const dir = tempDir();
    const logger = new AuditFileLogger({ dir, maxBytes: 200, keepFiles: 2, now: () => DAY });
    for (let i = 0; i < 8; i += 1) {
      logger.append({ channel: `channel-${i}`, sender: "loopsoar://app/index.html", status: "ok", reason: "x".repeat(20) });
      // 逐条 flush：确保每批独立落盘，轮转按「当前文件字节数」逐次触发
      await logger.flush();
    }

    const files = auditFiles(dir);
    expect(files).toContain("audit-20261102.jsonl");
    expect(files).toContain("audit-20261102.1.jsonl");
    // keepFiles=2：最多两份归档 + 当前文件；N≥3 必须被清掉
    expect(files.some((name) => /\.3\.jsonl$/.test(name))).toBe(false);
    expect(files.filter((name) => /\.\d+\.jsonl$/.test(name)).length).toBeLessThanOrEqual(2);
    // 当前文件仍可解析
    expect(readLines(path.join(dir, "audit-20261102.jsonl")).length).toBeGreaterThan(0);
  });

  it("跨天自动切换到新日期文件", async () => {
    const dir = tempDir();
    let clock = DAY;
    const logger = new AuditFileLogger({ dir, now: () => clock });
    logger.append({ channel: "a", sender: "-", status: "ok" });
    await logger.flush();
    clock = DAY + 24 * 60 * 60 * 1000;
    logger.append({ channel: "b", sender: "-", status: "ok" });
    await logger.flush();
    const files = auditFiles(dir);
    expect(files).toContain("audit-20261102.jsonl");
    expect(files).toContain("audit-20261103.jsonl");
  });

  it("永不抛异常：空/异常入参、flush 失败也 resolve", async () => {
    const dir = tempDir();
    const logger = new AuditFileLogger({ dir, now: () => DAY });
    expect(() => logger.append(null as never)).not.toThrow();
    expect(() => logger.append(undefined as never)).not.toThrow();
    expect(() => logger.append({ channel: undefined, sender: undefined, status: "weird" } as never)).not.toThrow();
    await expect(logger.flush()).resolves.toBeUndefined();
    const line = readLines(path.join(dir, "audit-20261102.jsonl"))[0];
    expect(line).toMatchObject({ channel: "-", sender: "-", status: "rejected" });
  });
});
