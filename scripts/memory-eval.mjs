/**
 * 记忆质量评测台（D4）：60 题 / 5 类能力，对当前 store 直接跑，不依赖模型或网络。
 *
 * 为什么要它：现有 memory-bench 只测性能（10 万条延迟），无法回答「这次改动让记忆变好还是变坏」。
 * 这里覆盖：单跳召回 / 时序（新近优先）/ 更新（取代后旧值不再命中）/ 拒答（无关查询应为空）/ 工作区隔离。
 *
 * 用法：
 *   pnpm build            # 脚本消费 core/dist
 *   node scripts/memory-eval.mjs
 */
import { MemoryStore, createFact } from "../packages/core/dist/memory/index.js";

const NOW = Date.now();
const DAY = 86_400_000;
const WS_A = "ws-a";
const WS_B = "ws-b";

function fact(id, content, opts = {}) {
  return createFact({
    id,
    content,
    category: opts.category ?? "fact",
    importance: opts.importance ?? 5,
    timestamp: opts.at ?? NOW,
    lastAccessed: opts.at ?? NOW,
    links: opts.links ?? [],
    workspaceId: opts.workspaceId ?? WS_A,
    provenance: { workspaceId: opts.workspaceId ?? WS_A, trust: "user", capturedBy: "auto" },
  });
}

function makeStore(facts) {
  const store = new MemoryStore({ now: () => NOW });
  // 深拷贝：各分组共用同一份语料对象，写操作（取代/失效）不能互相污染。
  store.restore({ facts: structuredClone(facts), archived: [] });
  return store;
}

const CORPUS = [
  fact("a1", "项目使用 pnpm 管理依赖"),
  fact("a2", "单元测试统一使用 vitest 运行"),
  fact("a3", "本地调试页面端口是 19444"),
  fact("a4", "主进程与渲染层通过 preload 白名单通信"),
  fact("a5", "构建走 esbuild 单文件 bundle"),
  fact("a6", "记忆条目上限是 2000 条，超出按最低有效值软归档"),
  fact("a7", "工作区记忆按 workspaceId 隔离，跨区默认不召回"),
  fact("a8", "浏览器敏感点击需要按元素文案二次确认"),
  fact("a9", "Agent 标签默认禁止回环访问本地服务"),
  fact("a10", "死代码应直接删除而不是标注弃用"),
  fact("a11", "删除会话时会把上下文压成一条 episode"),
  fact("a12", "失真层只保留关键词与指针，不保留全文"),
];

const QUESTIONS = [];

function q(group, query, check) {
  QUESTIONS.push({ group, query, check });
}

// ① 单跳召回（12）
for (const [id, query, expect] of [
  ["a1", "包管理器是什么", "pnpm"],
  ["a2", "测试框架用的哪个", "vitest"],
  ["a3", "调试端口是多少", "19444"],
  ["a4", "渲染层怎么和主进程通信", "preload"],
  ["a5", "构建工具是什么", "esbuild"],
  ["a6", "记忆条目上限", "2000"],
  ["a7", "工作区记忆怎么隔离", "workspaceId"],
  ["a8", "敏感点击怎么确认", "二次确认"],
  ["a9", "Agent 标签能访问本地服务吗", "回环"],
  ["a10", "死代码怎么处理", "删除"],
  ["a11", "删除会话会怎样", "episode"],
  ["a12", "失真层保留什么", "关键词"],
]) {
  q("单跳", query, (hits) => hits.some((h) => h.fact.id === id) && hits[0].fact.content.includes(expect));
}

// ② 时序：两条同主题、新近优先（12 组 = 3 组 × 4 个查询）
const temporalPairs = [
  ["t1", "旧的测试库说明：数据库端口是 5432", NOW - 60 * DAY],
  ["t2", "最新的测试库说明：数据库端口是 5433", NOW - 1 * DAY],
  ["t3", "旧的缓存方案：使用 memcached", NOW - 90 * DAY],
  ["t4", "最新的缓存方案：使用 redis", NOW - 2 * DAY],
  ["t5", "旧的消息队列：使用 rabbitmq", NOW - 120 * DAY],
  ["t6", "最新的消息队列：使用 kafka", NOW - 3 * DAY],
];
const temporalStore = makeStore([...CORPUS, ...temporalPairs.map(([id, content, at]) => fact(id, content, { at }))]);
for (const [query, expectId] of [
  ["测试库数据库端口是多少", "t2"],
  ["缓存方案用的是什么", "t4"],
  ["消息队列用的是哪个", "t6"],
]) {
  for (let i = 0; i < 4; i += 1) q("时序", query, (hits) => hits[0]?.fact.id === expectId);
}

// ③ 更新：被取代的旧值不再命中（12）
const updateStore = (() => {
  const store = new MemoryStore({ now: () => NOW });
  store.restore({ facts: structuredClone(CORPUS), archived: [] });
  store.write([{ content: "项目改为使用 npm 管理依赖", category: "fact", workspaceId: WS_A }]);
  store.write([{ content: "本地调试页面端口改为 8080", category: "fact", workspaceId: WS_A }]);
  store.write([{ content: "单元测试改用 jest 运行", category: "fact", workspaceId: WS_A }]);
  return store;
})();
for (const [query, expected] of [
  ["包管理器现在用什么", "npm"],
  ["调试端口现在是多少", "8080"],
  ["测试框架现在是什么", "jest"],
]) {
  for (let i = 0; i < 4; i += 1) {
    q("更新", query, (hits) => hits.some((h) => h.fact.content.includes(expected)) && hits.every((h) => !h.fact.content.includes("pnpm 管理") && !h.fact.content.includes("19444") && !h.fact.content.includes("vitest")));
  }
}

// ④ 拒答：无关查询应为空（12）
for (const query of [
  "Kubernetes 集群的节点数",
  "量子计算的纠错码",
  "巴黎的天气预报",
  "红烧肉的做法",
  "股票市场的市盈率",
  "宇宙膨胀的速度",
  "鲸鱼的迁徙路线",
  "莎士比亚的十四行诗",
  "火山喷发的预警",
  "大提琴的定弦",
  "沙漠玫瑰的浇水频率",
  "围棋的贴目规则",
]) {
  q("拒答", query, (hits) => hits.length === 0);
}

// ⑤ 工作区隔离（12）
const isolationStore = (() => {
  const store = new MemoryStore({ now: () => NOW });
  store.restore({
    facts: [
      fact("wa1", "工作区 A 的部署目标是内网测试机", { workspaceId: WS_A }),
      fact("wb1", "工作区 B 的部署目标是公共云主机", { workspaceId: WS_B }),
    ],
    archived: [],
  });
  return store;
})();
for (let i = 0; i < 12; i += 1) {
  q("隔离", "部署目标是什么", (hits, ws) => hits.length > 0 && hits.every((h) => (h.fact.workspaceId ?? "default") === ws));
}

const groups = {};
let pass = 0;
const latencies = [];
let promptChars = 0;
for (const question of QUESTIONS) {
  const ws = question.group === "隔离" ? WS_B : WS_A;
  const store =
    question.group === "时序" ? temporalStore : question.group === "更新" ? updateStore : question.group === "隔离" ? isolationStore : makeStore(CORPUS);
  const started = performance.now();
  const hits = store.recall(question.query, 6, { workspaceId: ws });
  latencies.push(performance.now() - started);
  promptChars += store.recallPrompt(question.query, 6, { workspaceId: ws }).length;
  const ok = question.group === "隔离" ? question.check(hits, ws) : question.check(hits);
  const bucket = (groups[question.group] ??= { total: 0, pass: 0 });
  bucket.total += 1;
  if (ok) {
    bucket.pass += 1;
    pass += 1;
  } else if (process.env.MEMORY_EVAL_VERBOSE === "1") {
    console.log("MISS", question.group, question.query, hits.map((h) => h.fact.id));
  }
}

latencies.sort((a, b) => a - b);
const p95 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))];
console.log("记忆质量评测（D4）");
for (const [name, bucket] of Object.entries(groups)) {
  console.log(`  ${name}: ${bucket.pass}/${bucket.total}`);
}
console.log(`  总计: ${pass}/${QUESTIONS.length}（${((pass / QUESTIONS.length) * 100).toFixed(1)}%）`);
console.log(`  P95 延迟: ${p95.toFixed(2)}ms · 平均注入长度: ${Math.round(promptChars / QUESTIONS.length)} 字符`);
if (pass < QUESTIONS.length) process.exitCode = 1;
