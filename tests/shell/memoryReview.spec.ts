/**
 * 记忆回顾命名（LLM）：提示词、输出校验、超时降级、标题落盘。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockLlmClient } from "../../packages/core/src/llm/index.ts";
import { buildReviewPrompt, parseReviewResponse, reviewTitles } from "../../packages/shell/src/main/memoryReview.ts";
import { MemoryService } from "../../packages/shell/src/main/memoryService.ts";
import type { LoopsoarPlatform } from "../../packages/core/src/platform/types.ts";
import { createFact } from "../../packages/core/src/memory/fact.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function tempFilePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-review-"));
  dirs.push(dir);
  return path.join(dir, "memory.json");
}

function fakePlatform(): LoopsoarPlatform {
  return {
    fs: {
      readFileUtf8: async (p: string) => fs.promises.readFile(p, "utf8"),
      writeFileUtf8: async (p: string, data: string) => {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, data, "utf8");
      },
      readDir: async () => [],
      stat: async (p: string) => {
        const s = fs.statSync(p);
        return { size: s.size, mtimeMs: s.mtimeMs };
      },
      exists: async (p: string) => fs.existsSync(p),
      resolve: (p: string) => path.resolve(p),
      isInside: (root: string, p: string) => path.resolve(p).startsWith(path.resolve(root)),
    },
    process: {},
    sqlite: {},
    net: {},
    embed: {},
  } as unknown as LoopsoarPlatform;
}

const fact = (id: string, content: string) =>
  createFact({ id, content, category: "fact", workspaceId: "default", timestamp: 1_760_000_000_000 });

describe("记忆回顾命名（LLM）", () => {
  it("提示词包含 id、分类和截断正文，并要求只输出 JSON", () => {
    const prompt = buildReviewPrompt([fact("m1", "项目使用 pnpm 管理依赖".repeat(40))]);
    expect(prompt).toContain("id=m1");
    expect(prompt).toContain("分类=fact");
    expect(prompt).toContain("只输出 JSON");
    expect(prompt).toContain("…");
  });

  it("解析容忍代码块与前后废话，过滤未知 id / 重复 / 超长标题", () => {
    const fence = String.fromCharCode(96).repeat(3);
    const text = ["好的，结果如下：", fence + "json",
      '[{"id":"m1","title":"pnpm 依赖约定"},{"id":"m2","title":"pnpm 依赖约定"},',
      '{"id":"unknown","title":"x"},{"id":"m1","title":"重复"},{"id":"m2","title":"' + "长".repeat(80) + '"}]',
      fence].join("\n");
    const out = parseReviewResponse(text, new Set(["m1", "m2"]));
    expect(out.map((item) => item.id)).toEqual(["m1", "m2"]);
    expect(out[0]?.title).toBe("pnpm 依赖约定");
  });

  it("模型缺失或输出非法 → null/空（保留规则标题）", async () => {
    expect(await reviewTitles(undefined, [fact("m1", "内容")])).toBeNull();
    const llm = new MockLlmClient();
    llm.addScript([{ kind: "text", text: "不是 JSON" }, { kind: "done" }]);
    expect(await reviewTitles(llm, [fact("m1", "内容")])).toEqual([]);
  });

  it("合法输出带出建议，且 content 回填供 UI 对照", async () => {
    const llm = new MockLlmClient();
    llm.addScript([{ kind: "text", text: '[{"id":"m1","title":"pnpm 依赖约定"}]' }, { kind: "done" }]);
    const out = await reviewTitles(llm, [fact("m1", "项目使用 pnpm 管理依赖")]);
    expect(out).toEqual([{ id: "m1", title: "pnpm 依赖约定", content: "项目使用 pnpm 管理依赖" }]);
  });

  it("applyTitles 只改 frontmatter title 并落盘，正文与文件名不变", async () => {
    const filePath = tempFilePath();
    const service = new MemoryService({ platform: fakePlatform(), filePath });
    const added = await service.add({ content: "项目使用 pnpm 管理依赖", category: "fact", workspaceId: "default" });
    const applied = await service.applyTitles([{ id: added.id, title: "pnpm 依赖约定" }]);
    expect(applied).toBe(1);

    const notes = fs.readdirSync(path.join(path.dirname(filePath), "vault", "facts"));
    expect(notes).toHaveLength(1);
    const md = fs.readFileSync(path.join(path.dirname(filePath), "vault", "facts", notes[0] as string), "utf8");
    expect(md).toContain('title: "pnpm 依赖约定"');
    expect(md).toContain("项目使用 pnpm 管理依赖");

    const reloaded = new MemoryService({ platform: fakePlatform(), filePath });
    await reloaded.load();
    expect(reloaded.list()[0]?.title).toBe("pnpm 依赖约定");
    service.dispose();
    reloaded.dispose();
  });
});
