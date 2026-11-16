/**
 * MemoryService · D1：崩溃安全写入（tmp+fsync+rename+.bak）、.bak 恢复、旧数据迁移、
 * 工作区隔离召回、自动汇总带 provenance。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryService } from "../../packages/shell/src/main/memoryService.ts";
import type { LoopsoarPlatform } from "../../packages/core/src/platform/types.ts";

const dirs: string[] = [];
function tempFilePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-memws-"));
  dirs.push(dir);
  return path.join(dir, "memory.json");
}
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

function makeService(filePath: string, opts: { recallGate?: boolean } = {}): MemoryService {
  return new MemoryService({
    platform: fakePlatform(),
    filePath,
    ...(opts.recallGate !== undefined ? { recallGate: opts.recallGate } : {}),
  });
}

describe("MemoryService · D1 持久化与隔离", () => {
  it("写入采用 tmp + rename + .bak，且不残留 .tmp", async () => {
    const filePath = tempFilePath();
    const service = makeService(filePath);
    await service.add({ content: "项目使用 pnpm 管理依赖", category: "fact", workspaceId: "ws-a" });

    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.existsSync(`${filePath}.bak`)).toBe(true);
    expect(fs.existsSync(`${filePath}.tmp`)).toBe(false);
  });

  it("主文件损坏时从 .bak 恢复，不丢记忆", async () => {
    const filePath = tempFilePath();
    const first = makeService(filePath);
    await first.add({ content: "项目使用 pnpm 管理依赖", category: "fact", workspaceId: "ws-a" });
    fs.writeFileSync(filePath, "{ 这不是合法 JSON", "utf8");

    const second = makeService(filePath);
    await second.load();
    const facts = second.list({ workspaceId: "ws-a" });
    expect(facts).toHaveLength(1);
    expect(facts[0].content).toContain("pnpm");
  });

  it("旧数据（无 workspaceId / provenance）加载后补齐并回写", async () => {
    const filePath = tempFilePath();
    const legacy = {
      facts: [
        {
          id: "mem-legacy",
          content: "旧版本留下的记忆",
          category: "fact",
          tags: [],
          importance: 5,
          timestamp: 1_700_000_000_000,
          lastAccessed: 1_700_000_000_000,
          links: [],
          backlinks: [],
          repeated: 0,
          layer: "semantic",
          accessCount: 0,
          confidence: 0.8,
          source: "chat",
          status: "active",
          mergeTrail: [],
        },
      ],
      archived: [],
    };
    fs.writeFileSync(filePath, JSON.stringify(legacy, null, 2), "utf8");

    const service = makeService(filePath);
    await service.load();
    expect(service.list()[0].workspaceId).toBe("default");

    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as { facts: Array<{ workspaceId?: string; provenance?: { trust?: string } }> };
    expect(raw.facts[0].workspaceId).toBe("default");
    expect(raw.facts[0].provenance?.trust).toBe("user");
  });

  it("召回按工作区隔离：A 区记忆绝不进入 B 区", async () => {
    const filePath = tempFilePath();
    const service = makeService(filePath, { recallGate: false });
    await service.add({ content: "A 项目使用 pnpm 管理依赖", category: "fact", workspaceId: "ws-a" });
    await service.add({ content: "B 项目使用 npm 管理依赖", category: "fact", workspaceId: "ws-b" });

    const a = service.recallPrompt("pnpm 依赖", "ws-a");
    const b = service.recallPrompt("pnpm 依赖", "ws-b");
    expect(a).toContain("pnpm");
    expect(a).not.toContain("B 项目");
    expect(b).not.toContain("A 项目");
  });

  it("自动汇总写入 provenance（会话 + 用户信任级别 + 工作区）", async () => {
    const filePath = tempFilePath();
    const service = makeService(filePath);
    const result = await service.captureFromTurn({
      userMessage: "以后项目都用 pnpm 安装依赖",
      assistantReply: "好的，记住了。",
      sessionId: "sess-1",
      workspaceId: "ws-a",
    });
    expect(result.added).toBeGreaterThan(0);

    const fact = service.list({ workspaceId: "ws-a" }).find((f) => f.provenance?.sessionId === "sess-1");
    expect(fact).toBeTruthy();
    expect(fact?.provenance?.trust).toBe("user");
    expect(fact?.provenance?.capturedBy).toBe("auto");
    expect(fact?.workspaceId).toBe("ws-a");
  });
});

describe("MemoryService · Markdown 导出（只读投影）", () => {
  it("导出到同目录 memory.md：内容可读、计数一致、不残留 .tmp、不改主库", async () => {
    const filePath = tempFilePath();
    const service = makeService(filePath);
    await service.add({ content: "导出测试：项目使用 pnpm 管理依赖", category: "fact", workspaceId: "ws-a" });
    const result = await service.exportMarkdown();
    expect(result.path).toBe(path.join(path.dirname(filePath), "memory.md"));
    const md = fs.readFileSync(result.path, "utf8");
    expect(md).toContain("# Loopsoar 记忆库");
    expect(md).toContain("导出测试：项目使用 pnpm 管理依赖");
    expect(md).toContain("## ws-a");
    expect(result.count).toBe(1);
    expect(fs.existsSync(`${result.path}.tmp`)).toBe(false);
    const json = JSON.parse(fs.readFileSync(filePath, "utf8")) as { facts: unknown[] };
    expect(json.facts).toHaveLength(1);
  });
});
