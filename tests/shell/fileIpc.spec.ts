/**
 * file:read / file:write IPC 的会话工作根约束：
 *   - 目标路径必须 resolve 后落在「会话工作根」内（relative/absolute 皆可）；
 *   - 越界一律拒绝（[错误] 路径越界），file:read 先 stat 再读、超上限拒绝；
 *   - file:write 5MB 上限；
 *   - payload.sessionId 决定根（不同会话不同工作区互不串根）。
 * 装配方式参考 tests/guards/channels-have-handlers.spec.ts：注册域 + 假 ipc 对象，不 import electron。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FILE_READ_MAX_BYTES,
  FILE_WRITE_MAX_BYTES,
} from "../../packages/contracts/src/security-policy.ts";
import { registerWorkspaceDomain } from "../../packages/shell/src/main/domains/workspace.ts";
import type { LoopsoarPlatform } from "../../packages/core/src/platform/types.ts";

interface FileResult {
  ok: boolean;
  content: string;
  totalLines?: number;
}

const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
/** 记录真实写盘次数：越界/超限必须在调用 platform.fs.writeFileUtf8 之前被拦下。 */
const writtenPaths: string[] = [];
let dirA = "";
let dirB = "";

const platform = {
  fs: {
    readFileUtf8: async (p: string): Promise<string> => fs.promises.readFile(p, "utf8"),
    writeFileUtf8: async (p: string, data: string): Promise<void> => {
      writtenPaths.push(p);
      await fs.promises.mkdir(path.dirname(p), { recursive: true });
      await fs.promises.writeFile(p, data, "utf8");
    },
    readDir: async (): Promise<string[]> => [],
    stat: async (p: string): Promise<{ size: number; mtimeMs: number }> => {
      // big.txt 假装超过读取上限：不用真的造 5MB 文件，测试更快
      if (path.basename(p) === "big.txt") return { size: FILE_READ_MAX_BYTES + 1, mtimeMs: 0 };
      const stat = await fs.promises.stat(p);
      return { size: stat.size, mtimeMs: stat.mtimeMs };
    },
    exists: async (p: string): Promise<boolean> => fs.existsSync(p),
    resolve: (p: string): string => path.resolve(p),
    isInside: (root: string, p: string): boolean => path.resolve(p).startsWith(path.resolve(root)),
  },
  process: {},
  sqlite: {},
  net: {},
  embed: {},
} as unknown as LoopsoarPlatform;

/** 调用受信 IPC 包装器（带可信帧来源；参数校验由 trustedIpc 自动执行）。 */
async function invoke(channel: string, payload?: unknown): Promise<FileResult> {
  const fn = handlers.get(`loopsoar:${channel}`);
  if (!fn) throw new Error(`未注册通道 ${channel}`);
  const result = await fn({ senderFrame: { url: "loopsoar://app/index.html" } }, payload);
  return result as FileResult;
}

beforeAll(() => {
  dirA = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-fileA-"));
  dirB = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-fileB-"));
  fs.writeFileSync(path.join(dirA, "hello.txt"), "line1\nline2\nline3\n", "utf8");
  fs.writeFileSync(path.join(dirA, "big.txt"), "small", "utf8");
  fs.writeFileSync(path.join(dirB, "onlyB.txt"), "B-only", "utf8");

  registerWorkspaceDomain({
    ipc: {
      handle(channel: string, fn: (event: unknown, payload: unknown) => unknown) {
        handlers.set(channel, fn);
      },
    },
    audit: () => {},
    platform,
    // 模拟 index.ts 装配：会话 B 绑定工作区 B，其余会话绑定工作区 A
    resolveSessionRoot: (sessionId?: string) => (sessionId === "sess-b" ? dirB : dirA),
  });
});

afterAll(() => {
  for (const dir of [dirA, dirB]) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

describe("file:read · 工作根约束", () => {
  it("根内相对路径：返回分页内容与总行数", async () => {
    const result = await invoke("file:read", { path: "hello.txt", offset: 1, limit: 1 });
    expect(result.ok).toBe(true);
    expect(result.content).toBe("line2");
    expect(result.totalLines).toBe(4);
  });

  it("根内绝对路径同样放行", async () => {
    const result = await invoke("file:read", { path: path.join(dirA, "hello.txt"), limit: 2 });
    expect(result.ok).toBe(true);
    expect(result.content).toBe("line1\nline2");
  });

  it("相对路径穿越 → 路径越界拒绝（不读文件）", async () => {
    const result = await invoke("file:read", { path: "../outside.txt" });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("路径越界");
  });

  it("绝对路径越出工作根 → 拒绝；指定会话后按其根放行", async () => {
    const outside = path.join(dirB, "onlyB.txt");
    const rejected = await invoke("file:read", { path: outside });
    expect(rejected.ok).toBe(false);
    expect(rejected.content).toContain("路径越界");

    const allowed = await invoke("file:read", { path: "onlyB.txt", sessionId: "sess-b" });
    expect(allowed.ok).toBe(true);
    expect(allowed.content).toBe("B-only");
  });

  it("超过 FILE_READ_MAX_BYTES → 读取前拒绝", async () => {
    const result = await invoke("file:read", { path: "big.txt" });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("文件过大");
    expect(result.content).toContain(String(FILE_READ_MAX_BYTES));
  });

  it("非法 sessionId 在 IPC 参数校验层被拒（fail-closed）", async () => {
    for (const sessionId of ["../evil", "a/b", "..", ""]) {
      await expect(invoke("file:read", { path: "hello.txt", sessionId })).rejects.toThrow(/参数校验失败/);
    }
  });
});

describe("file:write · 工作根约束与上限", () => {
  it("根内写入成功（自动建父目录）", async () => {
    const target = path.join(dirA, "sub", "new.txt");
    const result = await invoke("file:write", { path: "sub/new.txt", content: "hi" });
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("hi");
  });

  it("指定会话时写入该会话的工作根", async () => {
    const result = await invoke("file:write", { path: "bwrite.txt", content: "B!", sessionId: "sess-b" });
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(path.join(dirB, "bwrite.txt"), "utf8")).toBe("B!");
  });

  it("越界写入 → 拒绝且不落盘", async () => {
    const before = writtenPaths.length;
    const escaped = path.join(dirA, "..", "escaped-by-test.txt");
    const result = await invoke("file:write", { path: escaped, content: "x" });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("路径越界");
    expect(fs.existsSync(escaped)).toBe(false);
    expect(writtenPaths.length).toBe(before);
  });

  it("超过 FILE_WRITE_MAX_BYTES → 拒绝且不落盘", async () => {
    const before = writtenPaths.length;
    const result = await invoke("file:write", {
      path: "too-big.txt",
      content: "x".repeat(FILE_WRITE_MAX_BYTES + 1),
    });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("5MB");
    expect(writtenPaths.length).toBe(before);
    expect(fs.existsSync(path.join(dirA, "too-big.txt"))).toBe(false);
  });

  it("非法 sessionId 被参数校验拒绝", async () => {
    await expect(
      invoke("file:write", { path: "x.txt", content: "x", sessionId: "../../evil" }),
    ).rejects.toThrow(/参数校验失败/);
  });
});
