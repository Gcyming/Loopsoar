/**
 * file_write：工作区边界、写入内容、diff 标记可由 UI 解析。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { registerFileTools } from "../../packages/shell/src/main/fileTools.ts";
import { parseDiffResult } from "../../packages/ui/src/artifacts.ts";

function makeTool(root: string) {
  const registry = new ToolRegistry();
  registerFileTools(registry, () => root);
  return registry.get("file_write")!;
}

function makeSessionTool(roots: Record<string, string>) {
  const registry = new ToolRegistry();
  registerFileTools(registry, (sessionId) => roots[sessionId ?? ""] ?? roots.default ?? "");
  return registry.get("file_write")!;
}

describe("file_write 工具", () => {
  it("写入新文件并带可解析 diff 标记；覆盖时包含旧内容", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-file-"));
    const tool = makeTool(root);
    try {
      expect(tool.permissions.write).toBe(true);
      const first = await tool.execute({ agentId: "a", params: { path: "notes/a.md", content: "hello\nworld" }, platform: {} });
      expect(first.ok).toBe(true);
      expect(fs.readFileSync(path.join(root, "notes/a.md"), "utf8")).toBe("hello\nworld");
      const parsedFirst = parseDiffResult(first.content);
      expect(parsedFirst.diff).toMatchObject({ path: "notes/a.md", oldText: "", newText: "hello\nworld" });

      const second = await tool.execute({ agentId: "a", params: { path: "notes/a.md", content: "hello\nWORLD" }, platform: {} });
      const parsedSecond = parseDiffResult(second.content);
      expect(parsedSecond.diff?.oldText).toBe("hello\nworld");
      expect(parsedSecond.diff?.newText).toBe("hello\nWORLD");
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 20000);

  it("拒绝越界路径", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-file-"));
    const tool = makeTool(root);
    try {
      const result = await tool.execute({ agentId: "a", params: { path: "../escape.txt", content: "x" }, platform: {} });
      expect(result.ok).toBe(false);
      expect(result.content).toContain("越界");
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 20000);
});


describe("file_write 按会话根目录", () => {
  it("不同会话写入各自工作区/worktree，不串根", async () => {
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-sess-a-"));
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-sess-b-"));
    const tool = makeSessionTool({ "sess-a": rootA, "sess-b": rootB, default: rootA });
    try {
      await tool.execute({ agentId: "a", sessionId: "sess-a", params: { path: "same.txt", content: "A" }, platform: {} });
      await tool.execute({ agentId: "a", sessionId: "sess-b", params: { path: "same.txt", content: "B" }, platform: {} });
      expect(fs.readFileSync(path.join(rootA, "same.txt"), "utf8")).toBe("A");
      expect(fs.readFileSync(path.join(rootB, "same.txt"), "utf8")).toBe("B");
    } finally {
      fs.rmSync(rootA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      fs.rmSync(rootB, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 20000);
});
