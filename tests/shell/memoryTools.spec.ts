/**
 * 记忆工具 memory_search / memory_add / memory_update / memory_delete：
 * 注册与权限声明、返回文本格式（含 id 便于后续操作）、无结果提示、非法参数 fail-closed。
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

/** 最小平台 fake：只实现 MemoryService 用到的 fs（读写真实临时文件）。 */
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

async function setup(): Promise<{ registry: ToolRegistry; service: MemoryService }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-memtools-"));
  dirs.push(dir);
  const service = new MemoryService({ platform: fakePlatform(), filePath: path.join(dir, "memory.json") });
  await service.load();
  const registry = new ToolRegistry();
  registerMemoryTools(registry, service);
  return { registry, service };
}

function tool(registry: ToolRegistry, name: string) {
  const def = registry.get(name);
  if (!def) throw new Error(`工具未注册：${name}`);
  return def;
}

async function run(registry: ToolRegistry, name: string, params: unknown) {
  return tool(registry, name).execute({ agentId: "test-agent", params, platform: {} });
}

describe("memory_* 工具注册与权限声明", () => {
  it("注册 4 个工具；search 只读，add/update/delete 声明 write", async () => {
    const { registry } = await setup();
    const names = registry.list().map((def) => def.name).sort();
    expect(names).toEqual(["memory_add", "memory_delete", "memory_search", "memory_update"]);
    expect(tool(registry, "memory_search").permissions).toEqual({ read: true });
    for (const name of ["memory_add", "memory_update", "memory_delete"]) {
      expect(tool(registry, name).permissions).toEqual({ write: true });
    }
  });

  it("参数 schema 可被 ToolRegistry 转换为 JSON Schema（模型可见参数名/必填）", async () => {
    const { registry } = await setup();
    const schemas = registry.toolSchemas();
    const byName = new Map(schemas.map((schema) => [schema.function.name, schema.function.parameters as {
      properties?: Record<string, unknown>;
      required?: string[];
    }]));
    const search = byName.get("memory_search")!;
    expect(search.properties?.query).toBeDefined();
    expect(search.properties?.limit).toBeDefined();
    expect(search.required).toContain("query");
    expect(search.required).not.toContain("limit");

    const add = byName.get("memory_add")!;
    expect(add.properties?.content).toBeDefined();
    expect(add.required).toContain("content");

    const update = byName.get("memory_update")!;
    expect(update.properties?.id).toBeDefined();
    expect(update.required).toEqual(["id"]);
  });
});

describe("memory_add", () => {
  it("写入记忆并返回 id/分类/重要度，字段落库正确", async () => {
    const { registry, service } = await setup();
    const result = await run(registry, "memory_add", {
      content: "用户偏好深色主题界面",
      category: "preference",
      tags: ["ui"],
      importance: 8,
    });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("已记住记忆");
    const facts = service.list();
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      content: "用户偏好深色主题界面",
      category: "preference",
      tags: ["ui"],
      importance: 8,
      source: "agent",
    });
    // 返回 id 必须可用于后续 update/delete
    expect(result.content).toContain(facts[0].id);
  });

  it("缺省 category 时落为 fact", async () => {
    const { registry, service } = await setup();
    const result = await run(registry, "memory_add", { content: "项目使用 pnpm workspace" });
    expect(result.ok).toBe(true);
    expect(service.list()[0].category).toBe("fact");
  });

  it("重复写入命中已有条目：返回原条目 id（便于后续操作），不新增", async () => {
    const { registry, service } = await setup();
    const a = await run(registry, "memory_add", { content: "项目使用 pnpm workspace 管理多包" });
    const idA = service.list()[0].id;
    await run(registry, "memory_add", { content: "终端默认使用 PowerShell" });
    const idB = service.list().find((fact) => fact.content.includes("PowerShell"))!.id;

    const again = await run(registry, "memory_add", { content: "项目使用 pnpm workspace 管理多包" });
    expect(again.ok).toBe(true);
    expect(service.list().length).toBe(2);
    expect(again.content).toContain(idA);
    expect(again.content).not.toContain(idB);
    expect(a.ok).toBe(true);
  });

  it("非法参数 fail-closed（空内容/超长/重要度越界/标签超限）", async () => {
    const { registry, service } = await setup();
    for (const params of [
      { content: "" },
      { content: "x".repeat(5_001) },
      { content: "ok", importance: 11 },
      { content: "ok", importance: 0 },
      { content: "ok", tags: Array.from({ length: 11 }, (_, index) => `t${index}`) },
    ]) {
      const result = await run(registry, "memory_add", params);
      expect(result.ok, JSON.stringify(params).slice(0, 80)).toBe(false);
      expect(result.content).toContain("[错误] 参数不合法");
    }
    expect(service.list()).toHaveLength(0);
  });
});

describe("memory_search", () => {
  it("返回 id/分类/内容/相关度；limit 生效", async () => {
    const { registry } = await setup();
    await run(registry, "memory_add", { content: "部署前必须先跑契约检查", category: "lesson", importance: 9 });
    await run(registry, "memory_add", { content: "用户偏好深色主题界面", category: "preference", importance: 6 });

    const result = await run(registry, "memory_search", { query: "部署前契约检查" });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("找到");
    expect(result.content).toContain("[lesson]");
    expect(result.content).toContain("部署前必须先跑契约检查");
    expect(result.content).toContain("相关度");

    const limited = await run(registry, "memory_search", { query: "部署前契约检查", limit: 1 });
    expect(limited.ok).toBe(true);
    expect(limited.content).toContain("找到 1 条相关记忆");
  });

  it("无结果明确说明（不报错）", async () => {
    const { registry } = await setup();
    const result = await run(registry, "memory_search", { query: "量子引力波" });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("未找到");
    expect(result.content).toContain("memory_add");
  });

  it("非法参数 fail-closed（空 query / limit 越界 / 超长 query）", async () => {
    const { registry } = await setup();
    for (const params of [
      { query: "" },
      { query: "x".repeat(2_001) },
      { query: "ok", limit: 0 },
      { query: "ok", limit: 21 },
      { query: "ok", limit: 1.5 },
    ]) {
      const result = await run(registry, "memory_search", params);
      expect(result.ok, JSON.stringify(params).slice(0, 80)).toBe(false);
      expect(result.content).toContain("[错误] 参数不合法");
    }
  });
});

describe("memory_update / memory_delete", () => {
  it("按 id 更新内容/分类/标签/重要度", async () => {
    const { registry, service } = await setup();
    await run(registry, "memory_add", { content: "旧内容", category: "fact", importance: 3 });
    const id = service.list()[0].id;

    const result = await run(registry, "memory_update", {
      id,
      content: "新内容：用户偏好深色主题",
      category: "preference",
      tags: ["ui", "theme"],
      importance: 9,
    });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("已更新记忆");
    expect(service.get(id)).toMatchObject({
      content: "新内容：用户偏好深色主题",
      category: "preference",
      tags: ["ui", "theme"],
      importance: 9,
    });
  });

  it("更新不存在的 id → 可读错误；空 patch → 参数不合法", async () => {
    const { registry } = await setup();
    const missing = await run(registry, "memory_update", { id: "mem-不存在", content: "x" });
    expect(missing.ok).toBe(false);
    expect(missing.content).toContain("记忆不存在");

    const empty = await run(registry, "memory_update", { id: "mem-不存在" });
    expect(empty.ok).toBe(false);
    expect(empty.content).toContain("[错误] 参数不合法");
    expect(empty.content).toContain("至少提供");
  });

  it("按 id 删除；重复删除返回可读错误", async () => {
    const { registry, service } = await setup();
    await run(registry, "memory_add", { content: "需要删除的记忆" });
    const id = service.list()[0].id;

    const deleted = await run(registry, "memory_delete", { id });
    expect(deleted.ok).toBe(true);
    expect(deleted.content).toContain("已删除记忆");
    expect(service.get(id)).toBeNull();
    expect(service.list()).toHaveLength(0);

    const again = await run(registry, "memory_delete", { id });
    expect(again.ok).toBe(false);
    expect(again.content).toContain("记忆不存在");
  });

  it("memory_delete 非法参数 fail-closed（空 id）", async () => {
    const { registry } = await setup();
    const result = await run(registry, "memory_delete", { id: "" });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("[错误] 参数不合法");
  });
});
