/**
 * MemoryService：召回门控（recallGate）+ 显式检索（search）+ 门控诊断（recallSignals）。
 * 重点验证：
 *   - 门控默认开启：无信号 → recallPrompt 返回 ""（即使库里有相关记忆也不自动注入）；
 *   - 有信号 → 才召回并注入相关条目；
 *   - recallGate:false 可绕过门控（兼容旧行为 / 对照测试）；
 *   - search 是显式检索，不走门控，按 score 降序且 limit 生效。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryService } from "../../packages/shell/src/main/memoryService.ts";
import type { LoopsoarPlatform } from "../../packages/core/src/platform/types.ts";

const dirs: string[] = [];
function tempFilePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-memsvc-"));
  dirs.push(dir);
  return path.join(dir, "memory.json");
}
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

async function makeService(opts: { recallGate?: boolean; filePath?: string } = {}): Promise<{
  service: MemoryService;
  filePath: string;
}> {
  const filePath = opts.filePath ?? tempFilePath();
  const service = new MemoryService({
    platform: fakePlatform(),
    filePath,
    ...(opts.recallGate !== undefined ? { recallGate: opts.recallGate } : {}),
  });
  await service.load();
  return { service, filePath };
}

describe("MemoryService · 召回门控（默认开启）", () => {
  it("无信号 → recallPrompt 返回空字符串（库里有内容也不自动注入）", async () => {
    const { service } = await makeService();
    await service.add({ content: "用户偏好深色主题界面", category: "preference" });
    expect(service.stats().active).toBe(1);

    // 寒暄/普通请求没有 past_tense / reference / new_entity 信号
    expect(service.recallPrompt("你好")).toBe("");
    expect(service.recallPrompt("帮我写个周报")).toBe("");
    expect(service.recallSignals("你好")).toEqual([]);
  });

  it("命中信号 → 注入相关记忆（含分类与内容）", async () => {
    const { service } = await makeService();
    await service.add({ content: "用户偏好深色主题界面", category: "preference" });

    const query = "上次说的那个深色主题方案";
    const signals = service.recallSignals(query);
    expect(signals).toContain("past_tense");
    expect(signals).toContain("reference");

    const prompt = service.recallPrompt(query);
    expect(prompt).not.toBe("");
    expect(prompt).toContain("以下是过往会话的长期记忆");
    // D1：读取侧格式带分类 / 时间 / 来源，模型能判断「这条从哪来」
    expect(prompt).toMatch(/- \[preference\] \d{4}-\d{2}-\d{2} · /);
    expect(prompt).toContain("深色主题");
  });

  it("recallGate:false 只绕过信号门控，仍要求相关性（D4 拒答门控）", async () => {
    const { service } = await makeService({ recallGate: false });
    await service.add({ content: "用户偏好深色主题界面", category: "preference" });
    // 旧行为是「相似度为 0 也注入」（基础有效值直接过阈值）——D4 起改为必须有实词 bigram 命中，
    // 否则「你好」这类无关消息会把记忆库里的旧条目全捞出来。
    expect(service.recallPrompt("你好")).toBe("");
    expect(service.recallPrompt("深色主题")).toContain("深色主题");
  });

  it("recallSignals：路径/引号/专有名词与任务类型信号可诊断", async () => {
    const { service } = await makeService();
    expect(service.recallSignals("打开 D:/work/report.docx")).toContain("new_entity");
    expect(service.recallSignals('标题是"季度复盘"')).toContain("new_entity");
    expect(service.recallSignals("开始新任务", "coding")).toContain("task_type");
    expect(service.recallSignals("继续")).toEqual([]);
  });

  it("自动召回后 lastRecallReasons 记录条目与理由；门控拦截时清空", async () => {
    const { service } = await makeService();
    const added = await service.add({ content: "用户偏好深色主题界面", category: "preference" });
    const prompt = service.recallPrompt("上次说的深色主题方案");
    expect(prompt).toContain("深色主题");
    const snapshot = service.lastRecallReasons();
    expect(snapshot).not.toBeNull();
    expect(Object.keys(snapshot?.reasons ?? {})).toContain(added.id);
    expect(snapshot?.reasons[added.id]).toEqual(expect.arrayContaining(["activation"]));

    // 门控挡住（无信号）→ 本次没有召回，理由清空，避免面板展示上一次的旧理由
    expect(service.recallPrompt("你好")).toBe("");
    expect(service.lastRecallReasons()?.reasons).toEqual({});
  });

  it("召回结果跨重启（load）仍可用：门控命中后能读到已持久化记忆", async () => {
    const first = await makeService();
    await first.service.add({ content: "部署前必须先跑契约检查", category: "lesson", importance: 9 });
    const second = await makeService({ filePath: first.filePath });
    const prompt = second.service.recallPrompt("之前说的部署流程");
    expect(prompt).toContain("部署前必须先跑契约检查");
  });
});

describe("MemoryService · 显式检索 search（不走门控）", () => {
  it("无门控信号也返回结果（显式搜索不受 recallGate 限制）", async () => {
    const { service } = await makeService();
    await service.add({ content: "用户偏好深色主题界面", category: "preference" });
    const hits = service.search("你好");
    expect(hits.length).toBeGreaterThan(0);
  });

  it("返回 {fact, score} 且按 score 降序；limit 生效", async () => {
    const { service } = await makeService();
    await service.add({ content: "记忆系统写入前需要去重与合并", category: "insight", importance: 10 });
    await service.add({ content: "记忆系统召回要先过门控再检索", category: "insight", importance: 8 });
    await service.add({ content: "用户喜欢简洁的中文回复", category: "preference", importance: 3 });

    const hits = service.search("记忆系统", 6);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    for (const hit of hits) {
      expect(typeof hit.score).toBe("number");
      expect(typeof hit.fact.id).toBe("string");
      expect(typeof hit.fact.content).toBe("string");
    }
    for (let i = 1; i < hits.length; i += 1) {
      expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
    }
    // 与 query 最相关的是「记忆系统…」，用户偏好那条不应排在前面
    expect(hits[0].fact.content).toContain("记忆系统");

    const limited = service.search("记忆系统", 1);
    expect(limited).toHaveLength(1);
    expect(limited[0].fact.id).toBe(hits[0].fact.id);
  });

  it("空库 → 返回空数组；limit 收敛到 [1,20]", async () => {
    const { service } = await makeService();
    expect(service.search("任何内容")).toEqual([]);
    expect(service.search("x", 0)).toEqual([]); // limit<1 收为 1，但空库仍空
    const one = await makeService();
    await one.service.add({ content: "只有一条记忆", category: "fact", importance: 10 });
    expect(one.service.search("记忆", 0).length).toBe(1);
    expect(one.service.search("记忆", 999).length).toBe(1);
  });
});
