/**
 * 可选 sqlite-vec 向量后端（ADR-0007 F8 收口）：
 *   · flat 后端语义（默认）；
 *   · 原生模块不可用（未安装 / ABI 不匹配 / 加载抛错）→ createSqliteVecBackend 返回 null、绝不抛；
 *   · resolveVectorBackend / MemoryService 自动降级 flat 并在 vectorStats 暴露原因；
 *   · 原生后端真正可用时：写入/查询/取回/删除/清空 全链路（本机 Node 安装 N-API prebuild 时应通过；
 *     若 CI 未安装原生依赖，则该分支自动跳过并只断言「返回 null」的降级语义）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FlatVectorBackend,
  createSqliteVecBackend,
  resolveVectorBackend,
  type VectorBackend,
} from "../../packages/shell/src/main/sqliteVectorBackend.ts";
import { MemoryService, type MemoryServiceOptions } from "../../packages/shell/src/main/memoryService.ts";
import type { LoopsoarPlatform } from "../../packages/core/src/platform/types.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Windows 句柄释放偶尔较慢，不影响断言
    }
  }
});

function tempFilePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-vecbackend-"));
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

async function makeService(opts: Partial<MemoryServiceOptions> = {}) {
  const service = new MemoryService({ platform: fakePlatform(), filePath: tempFilePath(), ...opts });
  await service.load();
  return service;
}

/** 测试用「原生后端」替身：验证 MemoryService 与后端接口接线（不依赖真实原生模块）。 */
class FakeNativeBackend implements VectorBackend {
  readonly kind = "sqlite-vec" as const;
  readonly dimension: number;
  closed = false;
  readonly vectors = new Map<string, Float32Array>();

  constructor(dimension: number) {
    this.dimension = dimension;
  }

  size(): number {
    return this.vectors.size;
  }

  upsert(id: string, vector: Float32Array): void {
    if (!(vector instanceof Float32Array) || vector.length !== this.dimension) throw new Error("维度不匹配");
    this.vectors.set(id, Float32Array.from(vector));
  }

  remove(id: string): boolean {
    return this.vectors.delete(id);
  }

  get(id: string): Float32Array | null {
    return this.vectors.get(id) ?? null;
  }

  search(query: Float32Array, topK: number): { id: string; score: number }[] {
    const scoreOf = (vector: Float32Array): number => {
      let dot = 0;
      let normA = 0;
      let normB = 0;
      for (let i = 0; i < vector.length; i++) {
        dot += query[i] * vector[i];
        normA += query[i] * query[i];
        normB += vector[i] * vector[i];
      }
      const denom = Math.sqrt(normA) * Math.sqrt(normB);
      return denom === 0 ? 0 : dot / denom;
    };
    return [...this.vectors.entries()]
      .map(([id, vector]) => ({ id, score: scoreOf(vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, topK));
  }

  clear(): void {
    this.vectors.clear();
  }

  memoryBytes(): number {
    return this.vectors.size * this.dimension * 4;
  }

  stats() {
    return { backend: this.kind, size: this.size(), dimension: this.dimension, memoryBytes: this.memoryBytes() };
  }

  close(): void {
    this.closed = true;
  }
}

describe("FlatVectorBackend（默认后端）", () => {
  it("upsert/search/get/remove/clear 语义与 core FlatVectorIndex 一致", () => {
    const backend = new FlatVectorBackend(4, 2);
    expect(backend.kind).toBe("flat");
    expect(backend.dimension).toBe(4);
    backend.upsert("a", new Float32Array([1, 0, 0, 0]));
    backend.upsert("b", new Float32Array([0, 1, 0, 0]));
    expect(backend.size()).toBe(2);

    const hits = backend.search(new Float32Array([1, 0, 0, 0]), 2);
    expect(hits.map((hit) => hit.id)).toEqual(["a", "b"]);
    expect(hits[0].score).toBeCloseTo(1, 5);

    const vector = backend.get("a");
    expect(vector).not.toBeNull();
    expect(Array.from(vector!)).toEqual([1, 0, 0, 0]);
    vector![0] = 42;
    expect(Array.from(backend.get("a")!)).toEqual([1, 0, 0, 0]); // get 返回副本

    expect(backend.remove("a")).toBe(true);
    expect(backend.remove("a")).toBe(false);
    expect(backend.get("a")).toBeNull();
    expect(backend.size()).toBe(1);

    backend.clear();
    expect(backend.size()).toBe(0);
    expect(backend.search(new Float32Array([1, 0, 0, 0]), 3)).toEqual([]);
    backend.close(); // flat 无资源，不应抛
  });

  it("维度不符 fail-closed（upsert 同名向量覆盖）", () => {
    const backend = new FlatVectorBackend(4, 2);
    expect(() => backend.upsert("bad", new Float32Array([1, 2]))).toThrow(/维度/);
    backend.upsert("a", new Float32Array([1, 0, 0, 0]));
    backend.upsert("a", new Float32Array([0, 1, 0, 0]));
    expect(backend.size()).toBe(1);
    expect(backend.stats().memoryBytes).toBeGreaterThan(0);
  });
});

describe("createSqliteVecBackend：不可用时返回 null（绝不抛）", () => {
  it("原生模块加载抛错（例如 Electron/Node ABI 不匹配）→ null", () => {
    const backend = createSqliteVecBackend({
      dimension: 8,
      loadModule: () => {
        throw new Error("NODE_MODULE_VERSION mismatch (ABI)");
      },
    });
    expect(backend).toBeNull();
  });

  it("better-sqlite3 导出形状不合法 / sqlite-vec 无 load → null", () => {
    expect(
      createSqliteVecBackend({ dimension: 8, loadModule: (name) => (name === "better-sqlite3" ? {} : { load: () => {} }) }),
    ).toBeNull();
    expect(
      createSqliteVecBackend({
        dimension: 8,
        loadModule: (name) => (name === "better-sqlite3" ? class {} : {}),
      }),
    ).toBeNull();
  });

  it("维度非法 → null", () => {
    expect(createSqliteVecBackend({ dimension: 0, loadModule: () => ({}) })).toBeNull();
    expect(createSqliteVecBackend({ dimension: -3, loadModule: () => ({}) })).toBeNull();
  });
});

// 原生后端可用性探测：安装了 better-sqlite3@13（N-API prebuild）+ sqlite-vec 的机器上应为可用。
const nativeBackend = createSqliteVecBackend({ dimension: 4 });

describe("sqlite-vec 原生后端（可用时全链路；不可用时自动跳过）", () => {
  it(
    nativeBackend === null ? "本机不可用：create 返回 null（降级契约）" : "本机可用：写入/查询/取回/删除/清空",
    () => {
      if (nativeBackend === null) {
        expect(nativeBackend).toBeNull();
        return;
      }
      expect(nativeBackend.kind).toBe("sqlite-vec");
      expect(nativeBackend.dimension).toBe(4);
      nativeBackend.upsert("x", new Float32Array([1, 0, 0, 0]));
      nativeBackend.upsert("y", new Float32Array([0, 1, 0, 0]));
      nativeBackend.upsert("z", new Float32Array([0, 0, 1, 0]));
      expect(nativeBackend.size()).toBe(3);

      const hits = nativeBackend.search(new Float32Array([1, 0, 0, 0]), 2);
      expect(hits).toHaveLength(2);
      expect(hits[0].id).toBe("x");
      expect(hits[0].score).toBeCloseTo(1, 3);

      const stored = nativeBackend.get("x");
      expect(stored).not.toBeNull();
      expect(Array.from(stored!)).toEqual([1, 0, 0, 0]);

      // 覆盖写入：size 不涨
      nativeBackend.upsert("x", new Float32Array([0, 0, 0, 1]));
      expect(nativeBackend.size()).toBe(3);
      expect(nativeBackend.get("x")![3]).toBeCloseTo(1, 5);

      expect(nativeBackend.remove("y")).toBe(true);
      expect(nativeBackend.remove("y")).toBe(false);
      expect(nativeBackend.size()).toBe(2);

      nativeBackend.clear();
      expect(nativeBackend.size()).toBe(0);
      expect(nativeBackend.search(new Float32Array([1, 0, 0, 0]), 3)).toEqual([]);
      nativeBackend.close();
    },
  );
});

describe("resolveVectorBackend：请求 sqlite-vec 失败自动降级 flat", () => {
  it("默认 flat（不触碰原生模块）；请求 flat 时 requested=flat", () => {
    const resolution = resolveVectorBackend({ dimension: 8 });
    expect(resolution.backend.kind).toBe("flat");
    expect(resolution.requested).toBe("flat");
    expect(resolution.note).toBeUndefined();
    resolution.backend.close();
  });

  it("sqlite-vec 不可用（工厂返回 null）→ flat + note 记录原因", () => {
    const resolution = resolveVectorBackend({ dimension: 8, requested: "sqlite-vec", factory: () => null });
    expect(resolution.backend.kind).toBe("flat");
    expect(resolution.requested).toBe("sqlite-vec");
    expect(resolution.note).toMatch(/降级 flat/);
    resolution.backend.close();
  });

  it("sqlite-vec 工厂抛错 → flat + note（不抛）", () => {
    const resolution = resolveVectorBackend({
      dimension: 8,
      requested: "sqlite-vec",
      factory: () => {
        throw new Error("boom");
      },
    });
    expect(resolution.backend.kind).toBe("flat");
    expect(resolution.note).toMatch(/初始化失败/);
    resolution.backend.close();
  });

  it("sqlite-vec 工厂维度不符 → flat + note", () => {
    const wrongDim = new FlatVectorBackend(4);
    const resolution = resolveVectorBackend({ dimension: 8, requested: "sqlite-vec", factory: () => wrongDim });
    expect(resolution.backend.kind).toBe("flat");
    expect(resolution.note).toMatch(/维度不符/);
    resolution.backend.close();
  });
});

describe("MemoryService 后端接线与降级", () => {
  it("默认 flat：vectorStats 标记 requested/backend；写入检索正常", async () => {
    const service = await makeService();
    await service.add({ content: "用户偏好深色主题界面", category: "preference", importance: 8 });
    const stats = service.vectorStats();
    expect(stats.requestedBackend).toBe("flat");
    expect(stats.backend).toBe("flat");
    expect(stats.hashIndexSize).toBe(1);
    expect(service.search("深色主题", 3)[0].fact.content).toContain("深色");
    service.dispose();
  });

  it("请求 sqlite-vec 但工厂返回 null → 自动降级 flat，检索不受影响", async () => {
    const service = await makeService({ vectorBackend: "sqlite-vec", vectorBackendFactory: () => null });
    await service.add({ content: "部署前必须先跑契约检查", category: "lesson", importance: 9 });
    const stats = service.vectorStats();
    expect(stats.requestedBackend).toBe("sqlite-vec");
    expect(stats.backend).toBe("flat");
    expect(stats.backendNote).toMatch(/降级 flat/);
    expect(service.search("契约检查", 3)[0].fact.content).toContain("部署前必须先跑契约检查");
    service.dispose();
  });

  it("自定义后端（模拟原生可用）→ MemoryService 用其索引并暴露 backend=sqlite-vec", async () => {
    const backend = new FakeNativeBackend(256);
    const service = await makeService({
      vectorBackend: "sqlite-vec",
      vectorBackendFactory: () => backend,
    });
    await service.add({ content: "记忆系统写入前需要去重", category: "insight", importance: 9 });
    await service.add({ content: "用户偏好深色主题界面", category: "preference", importance: 6 });
    const stats = service.vectorStats();
    expect(stats.backend).toBe("sqlite-vec");
    expect(stats.requestedBackend).toBe("sqlite-vec");
    expect(backend.size()).toBe(service.stats().active);
    const hits = service.search("深色主题", 3);
    expect(hits[0].fact.content).toContain("深色");
    await service.clear();
    expect(backend.size()).toBe(0);
    service.dispose();
    expect(backend.closed).toBe(true);
  });

  it(
    nativeBackend === null ? "原生不可用：sqlite-vec 请求走默认工厂 → flat 降级" : "原生可用：默认工厂真实创建 sqlite-vec 后端",
    async () => {
      const service = await makeService({ vectorBackend: "sqlite-vec" });
      await service.add({ content: "部署前必须先跑契约检查", category: "lesson", importance: 9 });
      await service.add({ content: "用户偏好深色主题界面", category: "preference", importance: 6 });
      const stats = service.vectorStats();
      expect(stats.requestedBackend).toBe("sqlite-vec");
      if (createSqliteVecBackend({ dimension: 256 }) === null) {
        expect(stats.backend).toBe("flat");
        expect(stats.backendNote).toMatch(/降级 flat/);
      } else {
        expect(stats.backend).toBe("sqlite-vec");
        expect(stats.hashIndexSize).toBe(2);
      }
      expect(service.search("深色主题", 3)[0].fact.content).toContain("深色");
      service.dispose();
    },
  );
});
