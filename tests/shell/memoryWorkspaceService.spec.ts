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

function listTmpFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".tmp")) out.push(full);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

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
  it("写入落地为 vault：一条记忆一个 md + sidecar，且不残留 .tmp", async () => {
    const filePath = tempFilePath();
    const service = makeService(filePath);
    await service.add({ content: "项目使用 pnpm 管理依赖", category: "fact", workspaceId: "ws-a" });

    const root = path.dirname(filePath);
    const factsDir = path.join(root, "vault", "facts");
    const notes = fs.readdirSync(factsDir);
    expect(notes).toHaveLength(1);
    const note = fs.readFileSync(path.join(factsDir, notes[0] as string), "utf8");
    expect(note.startsWith("---\n")).toBe(true);
    expect(note).toContain("category: fact");
    expect(note).toContain("workspace: ws-a");
    expect(note).toContain("项目使用 pnpm 管理依赖");
    expect(fs.existsSync(path.join(root, "usage.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "vault", "index.md"))).toBe(true);
    expect(listTmpFiles(path.join(root, "vault"))).toEqual([]);
    // md 是唯一真相：旧的 memory.json 不再被写
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("首次落盘用人类可读文件名；更新内容不改名；同内容不同条目不会互相覆盖", async () => {
    const filePath = tempFilePath();
    const service = makeService(filePath);
    const added = await service.add({ content: "项目使用 pnpm 管理依赖", category: "fact", workspaceId: "ws-a" });
    const factsDir = path.join(path.dirname(filePath), "vault", "facts");
    const first = fs.readdirSync(factsDir).filter((name) => name.endsWith(".md"));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatch(/^\d{4}-\d{2}-\d{2}-.+\.md$/);
    expect(first[0]).toContain("项目使用");

    await service.update({ id: added.id, content: "项目统一使用 pnpm 管理依赖（已确认）" });
    expect(fs.readdirSync(factsDir).filter((name) => name.endsWith(".md"))).toEqual(first);

    await service.add({ content: "项目使用 pnpm 管理依赖", category: "fact", workspaceId: "ws-b" });
    expect(fs.readdirSync(factsDir).filter((name) => name.endsWith(".md"))).toHaveLength(2);
  });

  it("vault 里坏文件被跳过，其余记忆照常加载", async () => {
    const filePath = tempFilePath();
    const first = makeService(filePath);
    await first.add({ content: "项目使用 pnpm 管理依赖", category: "fact", workspaceId: "ws-a" });
    const factsDir = path.join(path.dirname(filePath), "vault", "facts");
    fs.writeFileSync(path.join(factsDir, "broken.md"), "这不是 frontmatter", "utf8");

    const second = makeService(filePath);
    await second.load();
    const facts = second.list({ workspaceId: "ws-a" });
    expect(facts).toHaveLength(1);
    expect(facts[0]?.content).toContain("pnpm");
  });

  it("旧 JSON 一次性迁移到 vault，原文件改名 .migrated 且字段补齐", async () => {
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
    expect(service.list()[0]?.workspaceId).toBe("default");

    const factsDir = path.join(path.dirname(filePath), "vault", "facts");
    const notes = fs.readdirSync(factsDir);
    expect(notes).toHaveLength(1);
    const note = fs.readFileSync(path.join(factsDir, notes[0] as string), "utf8");
    expect(note).toContain("workspace: default");
    expect(note).toContain("旧版本留下的记忆");
    expect(fs.existsSync(`${filePath}.migrated`)).toBe(true);
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
    // 导出不改主库：vault 里仍是一条，memory.json 不再是存储格式
    expect(fs.readdirSync(path.join(path.dirname(filePath), "vault", "facts"))).toHaveLength(1);
    expect(fs.existsSync(filePath)).toBe(false);
  });
});
