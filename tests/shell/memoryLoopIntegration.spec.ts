/**
 * 记忆工具与循环接线：memory_search 按会话工作区检索、命中写回使用信号、触发 UI 刷新回调。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { registerMemoryTools } from "../../packages/shell/src/main/memoryTools.ts";
import { MemoryService } from "../../packages/shell/src/main/memoryService.ts";
import type { LoopsoarPlatform } from "../../packages/core/src/platform/types.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function fakePlatform(): LoopsoarPlatform {
  return {
    fs: {
      readFileUtf8: async (p: string): Promise<string> => fs.promises.readFile(p, "utf8"),
      writeFileUtf8: async (p: string, data: string): Promise<void> => {
        await fs.promises.mkdir(path.dirname(p), { recursive: true });
        await fs.promises.writeFile(p, data, "utf8");
      },
      readDir: async (): Promise<string[]> => [],
      stat: async (p: string): Promise<{ size: number; mtimeMs: number }> => {
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
}

function makeService(): MemoryService {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-memloop-"));
  dirs.push(dir);
  return new MemoryService({ platform: fakePlatform(), filePath: path.join(dir, "memory.json") });
}

describe("记忆工具与循环接线", () => {
  it("按会话工作区检索：A 会话看得到，B 会话看不到", async () => {
    const memory = makeService();
    await memory.captureFromTurn({
      userMessage: "以后项目都用 pnpm 安装依赖",
      assistantReply: "好的",
      sessionId: "s1",
      workspaceId: "ws-a",
    });
    const registry = new ToolRegistry();
    const used: string[][] = [];
    registerMemoryTools(registry, memory, {
      workspaceIdForSession: (sessionId) => (sessionId === "s1" ? "ws-a" : "ws-b"),
      onSearchUsed: (ids) => used.push(ids),
    });
    const tool = registry.get("memory_search")!;
    const ctx = (sessionId: string) => ({ agentId: "a", sessionId, platform: fakePlatform(), params: { query: "pnpm 安装依赖" } });

    const a = await tool.execute(ctx("s1") as never);
    expect(a.content).toContain("pnpm");
    expect(used[0]?.length).toBeGreaterThan(0);

    const b = await tool.execute(ctx("s2") as never);
    expect(b.content).toContain("未找到");
  });

  it("检索命中写回使用信号（accessCount / lastAccessed）", async () => {
    const memory = makeService();
    await memory.captureFromTurn({
      userMessage: "以后项目都用 pnpm 安装依赖",
      assistantReply: "好的",
      sessionId: "s1",
      workspaceId: "ws-a",
    });
    const before = memory.list({ workspaceId: "ws-a" })[0];
    expect(before.accessCount).toBe(0);

    const registry = new ToolRegistry();
    registerMemoryTools(registry, memory, { workspaceIdForSession: () => "ws-a" });
    await registry.get("memory_search")!.execute({
      agentId: "a",
      sessionId: "s1",
      platform: fakePlatform(),
      params: { query: "pnpm 安装依赖" },
    } as never);

    const after = memory.list({ workspaceId: "ws-a" })[0];
    expect(after.accessCount).toBe(1);
    expect(after.lastAccessed).toBeGreaterThanOrEqual(before.lastAccessed);
    // 使用事件也要落到 usage（供图谱 ACT-R 激活）
    expect(memory.usageSnapshot()[`fact:${after.id}`]?.length).toBe(1);
  });

  it("捕获的记忆能被同工作区的自动召回取到（闭环）", async () => {
    const memory = makeService();
    await memory.captureFromTurn({
      userMessage: "以后项目都用 pnpm 安装依赖",
      assistantReply: "好的",
      sessionId: "s1",
      workspaceId: "ws-a",
    });
    const prompt = memory.recallPrompt("上次说的 pnpm 安装依赖", "ws-a");
    expect(prompt).toContain("pnpm");
    expect(memory.recallPrompt("上次说的 pnpm 安装依赖", "ws-b")).toBe("");
  });
});
