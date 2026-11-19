/**
 * 记忆 LLM 重排（方案 §3.4，可选）：适配器解析 + MemoryService 集成 + fail-open 回退。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmChunk, LlmClient } from "../../packages/core/src/llm/index.ts";
import type { LoopsoarPlatform } from "../../packages/core/src/platform/types.ts";
import { MemoryService, type MemoryReranker } from "../../packages/shell/src/main/memoryService.ts";
import { createMemoryReranker } from "../../packages/shell/src/main/memoryRerank.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function tempFilePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-memrerank-"));
  dirs.push(dir);
  return path.join(dir, "memory.json");
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

async function makeService(): Promise<MemoryService> {
  const service = new MemoryService({ platform: fakePlatform(), filePath: tempFilePath() });
  await service.load();
  return service;
}

function scriptedLlm(chunks: LlmChunk[]): LlmClient {
  return {
    async *invoke(): AsyncIterable<LlmChunk> {
      for (const chunk of chunks) yield chunk;
    },
  };
}

describe("createMemoryReranker", () => {
  it("解析模型返回的 JSON id 数组", async () => {
    const reranker = createMemoryReranker(() => scriptedLlm([{ kind: "text", text: '结果：["b","a"]' }, { kind: "done" }]));
    const ids = await reranker({ query: "q", candidates: [{ id: "a", content: "x", category: "fact", tags: [], score: 1 }] });
    expect(ids).toEqual(["b", "a"]);
  });

  it("无模型 / 解析失败 / 抛错 / error chunk → null（调用方回退）", async () => {
    expect(await createMemoryReranker(() => undefined)({ query: "q", candidates: [] })).toBeNull();
    const noJson = createMemoryReranker(() => scriptedLlm([{ kind: "text", text: "不知道" }]));
    expect(await noJson({ query: "q", candidates: [{ id: "a", content: "x", category: "fact", tags: [], score: 1 }] })).toBeNull();
    const broken = { async *invoke(): AsyncIterable<LlmChunk> { throw new Error("boom"); } } as LlmClient;
    expect(await createMemoryReranker(() => broken)({ query: "q", candidates: [{ id: "a", content: "x", category: "fact", tags: [], score: 1 }] })).toBeNull();
    const errorChunk = createMemoryReranker(() => scriptedLlm([{ kind: "error", message: "upstream 500" }]));
    expect(await errorChunk({ query: "q", candidates: [{ id: "a", content: "x", category: "fact", tags: [], score: 1 }] })).toBeNull();
  });
});

describe("MemoryService · LLM 重排（只作用于显式搜索）", () => {
  async function seed(service: MemoryService): Promise<void> {
    await service.add({ content: "pnpm 工作区依赖安装命令", category: "fact", importance: 9 });
    await service.add({ content: "构建脚本通过 pnpm 运行", category: "fact", importance: 5 });
    await service.add({ content: "发布前用 pnpm 检查契约", category: "fact", importance: 3 });
  }

  it("候选池 > limit 时按模型顺序重排；未选中的按原序补齐", async () => {
    const service = await makeService();
    await seed(service);
    const before = await service.searchAsync("pnpm 命令", 2);
    expect(before.length).toBe(2);

    const seen: string[] = [];
    const reranker: MemoryReranker = async ({ candidates }) => {
      seen.push(...candidates.map((candidate) => candidate.id));
      return [...seen].reverse();
    };
    service.setReranker(reranker);
    const after = await service.searchAsync("pnpm 命令", 2);
    expect(seen.length).toBeGreaterThanOrEqual(3); // 池子比 limit 大
    expect(after.length).toBe(2);
    expect(after.map((hit) => hit.fact.id)).toEqual([...seen].reverse().slice(0, 2));
  });

  it("重排抛错 → 回退 ranker 原顺序（fail-open）", async () => {
    const service = await makeService();
    await seed(service);
    let poolIds: string[] = [];
    service.setReranker(async ({ candidates }) => {
      poolIds = candidates.map((candidate) => candidate.id);
      throw new Error("model down");
    });
    const after = await service.searchAsync("pnpm 命令", 2);
    expect(poolIds.length).toBeGreaterThanOrEqual(3);
    expect(after.map((hit) => hit.fact.id)).toEqual(poolIds.slice(0, 2));
  });

  it("候选数 <= limit 或未注入重排器 → 不调用模型", async () => {
    const service = await makeService();
    await service.add({ content: "只有一条 pnpm 记忆", category: "fact", importance: 9 });
    const rerank = vi.fn(async () => ["x"]);
    service.setReranker(rerank);
    const hits = await service.searchAsync("pnpm 记忆", 6);
    expect(hits.length).toBe(1);
    expect(rerank).not.toHaveBeenCalled();
  });
});
