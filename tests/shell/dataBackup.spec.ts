/**
 * 升级前数据备份回归测试（发布阶段 §4.4）：
 *   · 首次启动没有旧数据 → 不备份，只写版本记录；
 *   · 同版本重复启动 → 不备份；
 *   · 版本变化 → 备份用户数据、排除缓存、记录 skipped 并更新版本文件。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BACKUP_DIR,
  OFFICE_PREVIEW_CACHE_DIR,
  SKIP_NAMES,
  VERSION_FILE,
  backupBeforeUpgrade,
} from "../../packages/shell/src/main/dataBackup.js";

let root = "";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-backup-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content, "utf8");
}

describe("backupBeforeUpgrade", () => {
  it("首次启动：不备份，写入版本记录", () => {
    const result = backupBeforeUpgrade({ dataDir: root, version: "0.0.1", now: () => 1_700_000_000_000 });
    expect(result.created).toBe(false);
    expect(result.previousVersion).toBeNull();
    const record = JSON.parse(fs.readFileSync(path.join(root, VERSION_FILE), "utf8")) as { version: string };
    expect(record.version).toBe("0.0.1");
    expect(fs.existsSync(path.join(root, BACKUP_DIR))).toBe(false);
  });

  it("同版本：不备份，只更新 lastRunAt", () => {
    backupBeforeUpgrade({ dataDir: root, version: "0.0.1", now: () => 1 });
    write("config/preferences.json", "{}");
    const result = backupBeforeUpgrade({ dataDir: root, version: "0.0.1", now: () => 2 });
    expect(result.created).toBe(false);
    expect(fs.existsSync(path.join(root, BACKUP_DIR))).toBe(false);
    const record = JSON.parse(fs.readFileSync(path.join(root, VERSION_FILE), "utf8")) as { lastRunAt: string };
    expect(record.lastRunAt).toBe(new Date(2).toISOString());
  });

  it("版本变化：备份用户数据、排除缓存、更新版本号", () => {
    backupBeforeUpgrade({ dataDir: root, version: "0.0.1", now: () => 1 });
    write("config/preferences.json", '{"language":"zh"}');
    write("memory/memory.json", "[]");
    write("sessions/s1.jsonl", '{"role":"user"}\n');
    write("Cache/data_0", "cache");
    write("logs/audit-20261121.jsonl", "{}");
    const result = backupBeforeUpgrade({
      dataDir: root,
      version: "0.0.2",
      now: () => Date.parse("2026-11-21T08:00:00.000Z"),
      log: () => undefined,
    });
    expect(result.created).toBe(true);
    expect(result.previousVersion).toBe("0.0.1");
    expect(result.backupDir).toBeTruthy();
    const backupDir = result.backupDir as string;
    expect(fs.existsSync(path.join(backupDir, "config/preferences.json"))).toBe(true);
    expect(fs.existsSync(path.join(backupDir, "memory/memory.json"))).toBe(true);
    expect(fs.existsSync(path.join(backupDir, "sessions/s1.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(backupDir, "Cache"))).toBe(false);
    expect(fs.existsSync(path.join(backupDir, "logs"))).toBe(false);
    expect(result.skipped).toContain("Cache");
    expect(result.copiedFiles).toBe(3);
    const record = JSON.parse(fs.readFileSync(path.join(root, VERSION_FILE), "utf8")) as { version: string };
    expect(record.version).toBe("0.0.2");
  });

  it("Office 预览缓存（office-preview）是可再生缓存，不进入备份", () => {
    backupBeforeUpgrade({ dataDir: root, version: "0.0.1", now: () => 1 });
    write("config/preferences.json", "{}");
    write("office-preview/3f2a.pdf", "%PDF-1.7");
    write("office-preview/soffice-profile/fonts.cache", "cache");
    expect(SKIP_NAMES.has(OFFICE_PREVIEW_CACHE_DIR)).toBe(true);

    const result = backupBeforeUpgrade({
      dataDir: root,
      version: "0.0.2",
      now: () => Date.parse("2026-11-21T08:00:00.000Z"),
      log: () => undefined,
    });

    expect(result.created).toBe(true);
    expect(result.backupDir).toBeTruthy();
    const backupDir = result.backupDir as string;
    expect(fs.existsSync(path.join(backupDir, OFFICE_PREVIEW_CACHE_DIR))).toBe(false);
    expect(fs.existsSync(path.join(backupDir, "config/preferences.json"))).toBe(true);
    expect(result.skipped).toContain(OFFICE_PREVIEW_CACHE_DIR);
    expect(result.copiedFiles).toBe(1);
  });

  it("版本文件损坏：按首次启动处理，不抛错", () => {
    write(VERSION_FILE, "{not json");
    const result = backupBeforeUpgrade({ dataDir: root, version: "0.0.1" });
    expect(result.created).toBe(false);
    expect(result.error).toBeUndefined();
  });
});
