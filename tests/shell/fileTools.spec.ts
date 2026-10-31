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
