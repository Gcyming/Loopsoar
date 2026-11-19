/**
 * MemoryService 混合检索（ADR-0007 W5 接线）：
 *   · 默认 hash 向量（纯 TS）+ 四阶段检索，保持既有 search() 同步语义；
 *   · 注入 embed（或 platform.embed 可用）时维护外部向量索引，searchAsync() 走真实语义重排；
 *   · embed 失败/超时/维度非法 → 自动降级 hash，绝不让记忆检索不可用；
 *   · load/写入/删除/清空后索引同步维护。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryService, type MemoryEmbedder } from "../../packages/shell/src/main/memoryService.ts";
import type { LoopsoarPlatform } from "../../packages/core/src/platform/types.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Windows 句柄释放偶尔较慢，清理失败不影响断言
    }
  }
});

function tempFilePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-memhybrid-"));
  dirs.push(dir);
  return path.join(dir, "memory.json");
}

/** 最小平台 fake：只实现 MemoryService 用到的 fs（真实临时文件）。 */
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
    embed: {}, // 默认无 embed 能力 → hash 降级路径
  } as unknown as LoopsoarPlatform;
}

async function makeService(opts: { filePath?: string; embed?: MemoryEmbedder; embedTimeoutMs?: number } = {}) {
  const filePath = opts.filePath ?? tempFilePath();
  const service = new MemoryService({
    platform: fakePlatform(),
    filePath,
    ...(opts.embed ? { embed: opts.embed } : {}),
    ...(opts.embedTimeoutMs ? { embedTimeoutMs: opts.embedTimeoutMs } : {}),
  });
  await service.load();
  return { service, filePath };
}

/** 假「语义模型」：按关键词映射到 3 维空间（用于验证外部 embedding 接线/降级）。 */
const fakeSemanticEmbedder: MemoryEmbedder = async (texts) =>
  texts.map((text) => {
    if (/深色|夜间|主题/.test(text)) return [1, 0, 0];
    if (/部署|发布|契约/.test(text)) return [0, 1, 0];
    return [0, 0, 1];
  });

describe("默认 hash 混合检索（无外部 embedding）", () => {
  it("search 返回 {fact,score}、相关条目排前、embeddingMode=hash", async () => {
    const { service } = await makeService();
    await service.add({ content: "用户偏好深色主题界面", category: "preference", importance: 8 });
    await service.add({ content: "部署前必须先跑契约检查", category: "lesson", importance: 9 });

    const hits = service.search("深色主题", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].fact.content).toContain("深色");
    for (let i = 1; i < hits.length; i++) expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);

    expect(service.embeddingMode()).toBe("hash");
    const stats = service.vectorStats();
    expect(stats.mode).toBe("hash");
    expect(stats.hashDimension).toBe(256);
    expect(stats.hashIndexSize).toBe(2);
    expect(stats.hashIndexBytes).toBeGreaterThan(0);
  });

  it("兼容旧 search 语义：空库=[]、弱相关仍返回、limit 收敛 [1,20]", async () => {
    const { service } = await makeService();
    expect(service.search("任何内容")).toEqual([]);
    await service.add({ content: "只有一条记忆", category: "fact", importance: 10 });
    expect(service.search("你好").length).toBe(1); // 无关键词重叠仍按有效值返回（旧行为）
    expect(service.search("记忆", 0).length).toBe(1); // limit 0 收敛为 1
    expect(service.search("记忆", 999).length).toBe(1); // limit 999 收敛为 20
  });

  it("load 后重建索引：第二个实例能检索到已持久化的记忆", async () => {
    const first = await makeService();
    await first.service.add({ content: "部署前必须先跑契约检查", category: "lesson", importance: 9 });
    expect(first.service.vectorStats().hashIndexSize).toBe(1);

    const second = await makeService({ filePath: first.filePath });
    expect(second.service.vectorStats().hashIndexSize).toBe(1);
    const hits = second.service.search("部署契约检查", 3);
    expect(hits[0].fact.content).toContain("部署前必须先跑契约检查");
  });
});

describe("外部 embedding（注入 embed）", () => {
  it("embed 可用 → embeddingMode=external；searchAsync 用语义向量重排", async () => {
    const { service } = await makeService({ embed: fakeSemanticEmbedder });
    await service.add({ content: "用户偏好深色主题界面", category: "preference", importance: 8 });
    await service.add({ content: "部署前必须先跑契约检查", category: "lesson", importance: 9 });

    expect(service.embeddingMode()).toBe("external");
    const stats = service.vectorStats();
    expect(stats.externalDimension).toBe(3);
    expect(stats.externalIndexSize).toBe(2);

    // 查询「夜间模式」与两条记忆都无关键词重叠；但外部模型把「深色/夜间/主题」映射到同一向量
    const syncHits = service.search("夜间模式", 2);
    const asyncHits = await service.searchAsync("夜间模式", 2);

    expect(asyncHits.length).toBeGreaterThan(0);
    expect(asyncHits[0].fact.content).toContain("深色主题"); // 语义向量把它排第一
    // 同步 hash 路径没有语义信息（按有效值/重要性排序），用于对照
    expect(syncHits.length).toBeGreaterThan(0);
  });

  it("searchAsync 无外部向量/降级时仍按工作区隔离（不串到别的库）", async () => {
    const { service } = await makeService();
    await service.add({ content: "A 项目使用 pnpm 管理依赖", category: "fact", workspaceId: "ws-a" });
    await service.add({ content: "B 项目使用 pnpm 管理依赖", category: "fact", workspaceId: "ws-b" });

    const hits = await service.searchAsync("pnpm 依赖", 20, "ws-a");
    expect(hits.length).toBe(1);
    expect(hits[0].fact.workspaceId).toBe("ws-a");
  });

  it("searchAsync 外部语义命中同样记一次显式使用（accessCount/usage 不丢）", async () => {
    const { service } = await makeService({ embed: fakeSemanticEmbedder });
    const added = await service.add({ content: "用户偏好深色主题界面", category: "preference", importance: 8 });
    expect(service.get(added.id)?.accessCount).toBe(0);

    const hits = await service.searchAsync("夜间模式", 2);
    expect(hits[0]?.fact.id).toBe(added.id);
    expect(service.get(added.id)?.accessCount).toBe(1);
  });

  it("embed 抛错 → 自动降级 hash，search/searchAsync 都不抛错", async () => {
    const failing: MemoryEmbedder = async () => {
      throw new Error("llama-server 未运行");
    };
    const { service } = await makeService({ embed: failing });
    await service.add({ content: "用户偏好深色主题界面", category: "preference", importance: 8 });
    expect(service.embeddingMode()).toBe("hash");
    const hits = service.search("深色主题", 3);
    expect(hits[0].fact.content).toContain("深色");
    const asyncHits = await service.searchAsync("深色主题", 3);
    expect(asyncHits[0].fact.content).toContain("深色");
  });

  it("embed 返回数量/维度非法 → 降级 hash（fail-closed 校验）", async () => {
    // 数量不匹配：少返回一条（真正的非法输入）
    const wrongCount: MemoryEmbedder = async (texts) =>
      texts.slice(0, Math.max(0, texts.length - 1)).map(() => [1, 0]);
    const first = await makeService({ embed: wrongCount });
    await first.service.add({ content: "用户偏好深色主题界面", category: "preference" });
    expect(first.service.embeddingMode()).toBe("hash");

    // 维度在多次调用间变化：外部向量空间不稳定 → 降级 hash
    let embedCall = 0;
    const wrongDim: MemoryEmbedder = async (texts) => {
      embedCall += 1;
      return texts.map(() => (embedCall === 1 ? [1, 0] : [1, 0, 0]));
    };
    const second = await makeService({ embed: wrongDim });
    await second.service.add({ content: "记忆系统写入前去重", category: "insight" });
    await second.service.add({ content: "部署前必须先跑契约检查", category: "lesson" });
    expect(second.service.embeddingMode()).toBe("hash");

    // 合法但维度不同于 hash 维度的外部向量：应接受为 external（外部模型维度本就可能与 fallback 不同）
    const differentDim: MemoryEmbedder = async (texts) => texts.map(() => [1, 0, 0]);
    const third = await makeService({ embed: differentDim });
    await third.service.add({ content: "外部模型使用 3 维测试向量", category: "fact" });
    expect(third.service.embeddingMode()).toBe("external");
    expect(third.service.vectorStats().externalDimension).toBe(3);
  });

  it("embed 超时 → 降级 hash 且 load 不挂起", async () => {
    const slow: MemoryEmbedder = async (texts) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return texts.map(() => [1, 0]);
    };
    const startedAt = Date.now();
    const { service } = await makeService({ embed: slow, embedTimeoutMs: 30 });
    await service.add({ content: "用户偏好深色主题界面", category: "preference" });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(service.embeddingMode()).toBe("hash");
    expect(service.search("深色主题", 1).length).toBe(1);
  });
});

describe("索引维护（写/改/删/清空）", () => {
  it("add/remove/update/clear 后 hash 索引与检索结果同步", async () => {
    const { service } = await makeService();
    await service.add({ content: "记忆系统写入前需要去重", category: "insight", importance: 9 });
    await service.add({ content: "部署前必须先跑契约检查", category: "lesson", importance: 8 });
    await service.add({ content: "用户偏好深色主题界面", category: "preference", importance: 7 });
    expect(service.vectorStats().hashIndexSize).toBe(3);

    const deployId = service.list().find((fact) => fact.content.includes("部署"))!.id;
    expect(await service.remove(deployId)).toBe(true);
    expect(service.vectorStats().hashIndexSize).toBe(2);
    expect(service.search("部署契约检查", 5).some((hit) => hit.fact.id === deployId)).toBe(false);

    const memoryFact = service.list().find((fact) => fact.content.includes("记忆系统"))!;
    await service.update(memoryFact.id, { content: "记忆系统写入后需要向量索引" });
    const hits = service.search("向量索引", 5);
    expect(hits.some((hit) => hit.fact.id === memoryFact.id)).toBe(true);

    await service.clear();
    expect(service.vectorStats().hashIndexSize).toBe(0);
    expect(service.search("任何内容")).toEqual([]);
  });

  it("captureFromTurn 写入后索引同步（抽取 → 五闸 → 索引）", async () => {
    const { service } = await makeService();
    const result = await service.captureFromTurn({
      userMessage: "项目使用 pnpm workspace 管理依赖",
      assistantReply: "已记录项目构建方式",
    });
    expect(result.added).toBeGreaterThan(0);
    expect(service.vectorStats().hashIndexSize).toBe(service.stats().active);
    const hits = service.search("pnpm workspace", 3);
    expect(hits.some((hit) => hit.fact.content.includes("pnpm"))).toBe(true);
  });
});
