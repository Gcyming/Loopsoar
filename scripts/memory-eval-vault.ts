/**
 * 记忆检索评测（真实文本）：把项目文档小节当作记忆，用章节短语做查询，看能否召回来源。
 * 用法：npx tsx scripts/memory-eval-vault.ts [--vault <dir>] [--docs a.md b.md]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFact } from "../packages/core/src/memory/fact.ts";
import { factToMarkdown } from "../packages/core/src/memory/vault.ts";
import { MemoryService } from "../packages/shell/src/main/memoryService.ts";
import type { LoopsoarPlatform } from "../packages/core/src/platform/types.ts";

function platform(): LoopsoarPlatform {
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

function sections(file: string): Array<{ title: string; body: string }> {
  const text = fs.readFileSync(file, "utf8");
  const out: Array<{ title: string; body: string }> = [];
  const parts = text.split("\n## ");
  for (const part of parts) {
    const nl = part.indexOf("\n");
    if (nl < 0) continue;
    const title = part.slice(0, nl).replace(/^#+\s*/, "").trim();
    const body = part.slice(nl + 1).replace(/\s+/g, " ").trim();
    if (title && body.length >= 40) out.push({ title, body });
  }
  return out;
}

function queryOf(text: string): string {
  // 查询从正文里取，不取标题：标题常在正文开头，会把「章节标题」误当成检索词
  const colon = text.indexOf("：");
  const body = colon >= 0 ? text.slice(colon + 1) : text;
  const clean = body.replace(/[「」“”"'`#*_>|]/g, " ").replace(/\s+/g, " ").trim();
  // 关键词式查询（更接近 memory_search 的真实用法）：英文词/数字/中文词组，取 3 个
  const tokens = clean.match(/[A-Za-z][A-Za-z0-9_.-]{2,}|\d{2,}|[\u4e00-\u9fa5]{2,6}/g) ?? [];
  const stop = new Set(["我们", "这个", "那个", "以及", "可以", "需要", "如果", "但是", "因为", "所以", "就是", "没有", "一个"]);
  const useful = tokens.filter((token) => !stop.has(token));
  if (useful.length === 0) return clean.slice(0, 12);
  const picks = useful.length <= 3 ? useful : [useful[0], useful[Math.floor(useful.length / 2)], useful[useful.length - 1]];
  return [...new Set(picks)].join(" ");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const vaultArg = args.includes("--vault") ? args[args.indexOf("--vault") + 1] : undefined;
  const docsIdx = args.indexOf("--docs");
  const docs = docsIdx >= 0 ? args.slice(docsIdx + 1) : ["docs/decisions/ADR.md", "docs/PROGRESS.md", "docs/记忆模块.md"];

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-eval-vault-"));
  const filePath = path.join(dir, "memory.json");
  const factsDir = path.join(dir, "vault", "facts");
  fs.mkdirSync(factsDir, { recursive: true });
  const samples: Array<{ id: string; query: string }> = [];

  if (vaultArg) {
    const src = path.join(vaultArg, "facts");
    for (const name of fs.readdirSync(src).filter((n) => n.endsWith(".md"))) {
      fs.copyFileSync(path.join(src, name), path.join(factsDir, name));
    }
    const service = new MemoryService({ platform: platform(), filePath });
    await service.load();
    await service.whenSettled();
    for (const fact of service.list()) {
      const q = queryOf(fact.content);
      if (q.length >= 4) samples.push({ id: fact.id, query: q });
    }
    service.dispose();
  } else {
    let seq = 0;
    for (const file of docs) {
      if (!fs.existsSync(file)) continue;
      for (const section of sections(file)) {
        seq += 1;
        const id = "doc-" + seq;
        const fact = createFact({
          id,
          content: section.title + "：" + section.body.slice(0, 300),
          category: "doc",
          workspaceId: "default",
          importance: 5,
          timestamp: Date.now() - seq * 60_000,
          provenance: { workspaceId: "default", trust: "user", capturedBy: "user" },
        });
        fs.writeFileSync(path.join(factsDir, id + ".md"), factToMarkdown(fact), "utf8");
        const q = queryOf(fact.content);
        if (q.length >= 4) samples.push({ id, query: q });
      }
    }
  }

  const service = new MemoryService({ platform: platform(), filePath });
  await service.load();
  await service.whenSettled();
  let hit1 = 0;
  let hit3 = 0;
  let rr = 0;
  const positiveTopScores: number[] = [];
  const misses: Array<{ id: string; query: string; got: string[] }> = [];
  for (const sample of samples) {
    const hits = await service.searchAsync(sample.query, 3, "default");
    positiveTopScores.push(hits[0]?.score ?? 0);
    const rank = hits.findIndex((hit) => hit.fact.id === sample.id);
    if (rank === 0) hit1 += 1;
    if (rank >= 0) hit3 += 1;
    if (rank >= 0) rr += 1 / (rank + 1);
    else misses.push({ id: sample.id, query: sample.query, got: hits.map((h) => h.fact.id) });
  }
  const negative = ["zzz 不存在的词 12345", "qqq xyzzy 999", "完全无关的检索词 000"];
  const negativeTopScores: number[] = [];
  for (const q of negative) {
    const hits = await service.searchAsync(q, 3, "default");
    negativeTopScores.push(+(hits[0]?.score ?? 0).toFixed(3));
  }
  const n = samples.length || 1;
  console.log(JSON.stringify({
    corpus: vaultArg ?? "docs",
    facts: n,
    recallAt1: +(hit1 / n).toFixed(3),
    recallAt3: +(hit3 / n).toFixed(3),
    mrr: +(rr / n).toFixed(3),
    avgTopScore: +(positiveTopScores.reduce((sum, score) => sum + score, 0) / n).toFixed(3),
    p10TopScore: +(positiveTopScores.slice().sort((a, b) => a - b)[Math.floor(n * 0.1)] ?? 0).toFixed(3),
    negativeTopScores,
    sampleMisses: misses.slice(0, 3),
  }, null, 2));
  service.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
}

await main();
