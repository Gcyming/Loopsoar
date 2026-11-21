/**
 * 数据导出回归（发布阶段 §4.4/§4.5）：
 *   · 用户备份包含设置/会话/记忆，排除缓存/日志/旧备份；
 *   · 诊断包只含日志/版本/诊断 JSON/README，且附带 Crashpad minidump；
 *   · 不存在的文件被跳过而不是报错。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportDataBackup, exportDiagnostics } from "../../packages/shell/src/main/dataExport.js";

let root = "";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-export-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function write(rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
}

describe("exportDataBackup", () => {
  it("复制用户数据，跳过缓存/日志/旧备份", async () => {
    write("config/preferences.json", "{}");
    write("memory/facts/a.md", "# a");
    write("sessions/s1.jsonl", "{}\n");
    write("Cache/blob", "cache");
    write("logs/main.log", "log");
    write("backups/old/file", "old");
    const target = path.join(root, "out");
    fs.mkdirSync(target, { recursive: true });
    const result = await exportDataBackup({
      dataDir: root,
      targetDir: target,
      version: "0.0.1",
      now: () => Date.parse("2026-11-21T10:00:00.000Z"),
    });
    expect(result.error).toBeUndefined();
    expect(result.path).toContain("loopsoar-backup-0.0.1-");
    expect(fs.existsSync(path.join(result.path, "config/preferences.json"))).toBe(true);
    expect(fs.existsSync(path.join(result.path, "memory/facts/a.md"))).toBe(true);
    expect(fs.existsSync(path.join(result.path, "sessions/s1.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(result.path, "Cache"))).toBe(false);
    expect(fs.existsSync(path.join(result.path, "logs"))).toBe(false);
    expect(result.skipped).toContain("Cache");
    expect(result.skipped).toContain("logs");
    expect(result.skipped).toContain("backups");
    expect(result.files).toBe(3);
  });
});

describe("exportDiagnostics", () => {
  it("收集版本/日志/审计/诊断 JSON，并附带 minidump", async () => {
    write("version.json", '{"version":"0.0.1"}');
    write("logs/main.log", "ERROR boom");
    write("logs/crash.log", "crash");
    write("logs/audit-20261121.jsonl", "{}");
    write("logs/audit-20261120.jsonl", "{}");
    const dumps = path.join(root, "Crashpad");
    fs.mkdirSync(path.join(dumps, "reports"), { recursive: true });
    fs.writeFileSync(path.join(dumps, "abc.dmp"), "dump");
    fs.writeFileSync(path.join(dumps, "reports", "def.dmp"), "nested-dump");
    const target = path.join(root, "out2");
    fs.mkdirSync(target, { recursive: true });
    const result = await exportDiagnostics({
      dataDir: root,
      targetDir: target,
      version: "0.0.1",
      diagnostics: { versions: { app: "0.0.1" } },
      crashDumpsDir: dumps,
      now: () => Date.parse("2026-11-21T10:00:00.000Z"),
    });
    expect(result.error).toBeUndefined();
    expect(result.path).toContain("loopsoar-diagnostics-0.0.1-");
    expect(result.included).toContain("main.log");
    expect(result.included).toContain("crash.log");
    expect(result.included).toContain("diagnostics.json");
    expect(result.included).toContain("README.txt");
    expect(fs.existsSync(path.join(result.path, "audit-20261121.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(result.path, "audit-20261120.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(result.path, "crashdumps/abc.dmp"))).toBe(true);
    expect(fs.existsSync(path.join(result.path, "crashdumps/reports/def.dmp"))).toBe(true);
    const diag = JSON.parse(fs.readFileSync(path.join(result.path, "diagnostics.json"), "utf8")) as {
      versions: { app: string };
    };
    expect(diag.versions.app).toBe("0.0.1");
    expect(fs.readFileSync(path.join(result.path, "README.txt"), "utf8")).toContain("不包含：API Key");
  });

  it("缺失的日志文件被跳过，不报错", async () => {
    const target = path.join(root, "out3");
    fs.mkdirSync(target, { recursive: true });
    const result = await exportDiagnostics({
      dataDir: root,
      targetDir: target,
      version: "0.0.1",
      diagnostics: {},
    });
    expect(result.error).toBeUndefined();
    expect(result.included).toContain("diagnostics.json");
    expect(result.included).not.toContain("main.log");
  });
});
