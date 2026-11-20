/**
 * 浏览器 Agent 任务级评测驱动（真实 Electron + 真实 WebContentsView + 真实工具）。
 *
 * 设计取舍：
 *   · 不用真实模型做门禁：模型输出不稳定，无法在每次提交上给出确定结论；
 *     评测把「任务计划」写成确定性工具序列（scripts/browser-agent-tasks.json），
 *     由 mock OpenAI 服务逐步回放。走的是真实 chat loop → 权限闸 → 工具执行 → 页面，
 *     所以测的是工具链与页面行为，而不是模型猜测。
 *   · 一个 Electron 进程跑完全部任务：每个任务独立会话、独立标签组，失败互不污染。
 *   · 断言在渲染层执行（页面正文/标题/会话历史），结果回传后由 Node 汇总成报告。
 *
 * 用法：
 *   node scripts/browser-agent-eval.mjs --core        # 10 个核心任务（CI 门禁）
 *   node scripts/browser-agent-eval.mjs --all         # 30 个任务（发布前）
 *   node scripts/browser-agent-eval.mjs --all --isolated  # 每个任务单独起 Electron（排障/需要完全干净进程时）
 *   node scripts/browser-agent-eval.mjs --tasks=1,4,9 # 指定任务
 *   node scripts/browser-agent-eval.mjs --all --report-only
 *
 * 产物：e2e-evidence/browser-agent-eval/report.json + report.md
 */
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const PAGE_PORT = 19445;
const MOCK_PORT = 19502;
const DATA_DIR = path.join(ROOT, ".loopsoar-data-browser-eval");
const OUT_DIR = path.join(ROOT, "e2e-evidence", "browser-agent-eval");
const TMP_DIR = path.join(ROOT, ".tmp");
const CORE_IDS = [1, 3, 4, 5, 6, 9, 10, 13, 19, 29];
/** 单任务默认上限：90s；集成测试可用 BROWSER_EVAL_TASK_TIMEOUT_MS 临时缩短。 */
const DEFAULT_TASK_TIMEOUT_MS = (() => {
  const raw = Number(process.env.BROWSER_EVAL_TASK_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 100 ? Math.min(raw, 300_000) : 90_000;
})();
/** 只对 stream_not_done（超时）重试一次；stream_error 是真实错误，不重试。 */
const MAX_TASK_ATTEMPTS = 2;
/** 重试只给快速预算：首轮 90s 已证明该任务卡住，第二枪用于排除一次性抖动。 */
const RETRY_TASK_TIMEOUT_MS = 30_000;

/** 递归替换对象/数组里的字符串占位符（值原样保留，不做 JSON 文本拼接）。 */
function replaceDeep(value, map) {
  if (typeof value === "string") {
    let out = value;
    for (const [from, to] of Object.entries(map)) out = out.split(from).join(to);
    return out;
  }
  if (Array.isArray(value)) return value.map((item) => replaceDeep(item, map));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceDeep(item, map)]));
  }
  return value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = new Set(process.argv.slice(2));
const reportOnly = args.has("--report-only");
const tasksArg = process.argv.find((a) => a.startsWith("--tasks="));
const selected = tasksArg
  ? tasksArg.slice("--tasks=".length).split(",").map((x) => Number(x.trim())).filter(Number.isFinite)
  : args.has("--all")
    ? null
    : CORE_IDS;

const taskSet = JSON.parse(readFileSync(path.join(ROOT, "scripts", "browser-agent-tasks.json"), "utf8"));
const allTasks = taskSet.tasks ?? taskSet;
const tasks = (selected ? allTasks.filter((t) => selected.includes(t.id)) : allTasks).map((task) => ({
  ...task,
  startUrl: task.start.startsWith("http") ? task.start : `${taskSet.baseUrl}${task.start}`,
  plan: task.plan.map((step) => ({
    ...step,
    // 占位符替换必须在对象层做：先 JSON.stringify 再替换会把 Windows 反斜杠写进 JSON 字符串，
    // 变成非法转义（C:\Users → \U）。这里递归只替换字符串值。
    args: replaceDeep(step.args ?? {}, {
      __BASE__: taskSet.baseUrl,
      __FIXTURE_FILE__: "e2e-fixtures/browser-agent/upload.txt",
    }),
  })),
}));

if (tasks.length === 0) {
  console.error("没有匹配的任务");
  process.exit(2);
}

/*
 * 隔离模式：每个任务单独启动一个 Electron 进程，仅用于排障或需要完全干净进程的环境。
 * 背景：早前同一进程连续跑任务时，程序化 ask:respond/perm:respond 绕过 UI 点击，
 * 确认弹窗和 baseOverlay 残留 → 原生网页视图被隐藏 → 下一条点击/选择在隐藏文档里
 * 等待 requestAnimationFrame，直到任务超时。现在 AskBus/PermRequestBus 的结算事件
 * （ask:resolved / perm:resolved）统一清理遮罩，target-point 脚本也有隐藏文档兜底；
 * 同一进程全量已稳定通过，CI 不再需要 --isolated。
 */
const isolatedParent = args.has("--isolated") && process.env.BROWSER_EVAL_ISOLATED_CHILD !== "1";
if (isolatedParent) {
  const reportPath = path.join(OUT_DIR, "report.json");
  const results = [];
  let payRequests = 0;
  for (const task of tasks) {
    process.stdout.write(`[isolated ${task.id}/${tasks.length}] ${task.name} ... `);
    rmSync(reportPath, { force: true });
    const child = spawnSync(
      process.execPath,
      [path.resolve(process.argv[1]), `--tasks=${task.id}`, "--report-only"],
      {
        cwd: ROOT,
        env: { ...process.env, BROWSER_EVAL_ISOLATED_CHILD: "1" },
        stdio: "ignore",
      },
    );
    let childReport = null;
    try {
      childReport = JSON.parse(readFileSync(reportPath, "utf8"));
    } catch {
      // 子进程没产出报告：保留失败记录，不伪装通过
    }
    const childResult = childReport?.results?.[0];
    if (childResult) {
      results.push(childResult);
      payRequests += childReport.payRequests ?? 0;
      console.log(childResult.ok ? "OK" : childResult.skipped ? "SKIP" : "FAIL");
    } else {
      results.push({
        id: task.id,
        name: task.name,
        ok: false,
        failures: [`isolated_child_failed:exit=${child.status ?? "signal"}`],
        durationMs: 0,
        attempts: 1,
        retried: false,
      });
      console.log("FAIL");
    }
  }
  const passed = results.filter((r) => r.ok).length;
  const skipped = results.filter((r) => r.skipped).length;
  const failed = results.filter((r) => !r.ok && !r.skipped).length;
  const report = {
    startedAt: new Date().toISOString(),
    mode: "isolated",
    ok: failed === 0,
    passed,
    skipped,
    failed,
    total: results.length,
    payRequests,
    results,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  const icon = (r) => (r.ok ? "✅" : r.skipped ? "⏭️" : "❌");
  const lines = [
    "# 浏览器 Agent 任务评测（isolated）",
    "",
    `- 时间：${report.startedAt}`,
    `- 通过：${passed}/${results.length}${skipped ? `（环境跳过 ${skipped}）` : ""}`,
    `- 支付请求数（应为 0）：${report.payRequests}`,
    "",
    "| # | 任务 | 结果 | 尝试 | 耗时 | 失败项 |",
    "|---|---|---|---|---|---|",
    ...results.map(
      (r) =>
        `| ${r.id} | ${r.name} | ${icon(r)} | ${r.attempts ?? 1} | ${Math.round((r.durationMs ?? 0) / 100) / 10}s | ${
          r.skipped ? `环境跳过：${r.skipReason}` : (r.failures ?? []).join("；") || "-"
        } |`,
    ),
    "",
  ];
  writeFileSync(path.join(OUT_DIR, "report.md"), lines.join("\n"), "utf8");
  console.log(lines.join("\n"));
  process.exit(report.ok || reportOnly ? 0 : 1);
}

// 上传夹具：必须位于会话工作区（项目根）内；越界文件放在系统临时目录。
mkdirSync(path.join(ROOT, "e2e-fixtures", "browser-agent"), { recursive: true });
writeFileSync(path.join(ROOT, "e2e-fixtures", "browser-agent", "upload.txt"), "loopsoar browser eval upload fixture\n", "utf8");
const outsideDir = process.env.TMPDIR || process.env.TEMP || path.join(ROOT, ".tmp");
mkdirSync(outsideDir, { recursive: true });
const outsideFile = path.join(outsideDir, "loopsoar-eval-outside.txt");
writeFileSync(outsideFile, "outside workspace\n", "utf8");
for (const task of tasks) {
  task.plan = task.plan.map((step) => ({
    ...step,
    args: replaceDeep(step.args, { __OUTSIDE_FILE__: outsideFile }),
  }));
}

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(TMP_DIR, { recursive: true });
rmSync(DATA_DIR, { recursive: true, force: true });
// 评测下载目录固定到项目 .tmp：不污染用户「下载」目录，也避开 Windows 受控文件夹访问
// 对未签名进程写 Downloads 的拦截（会表现为 0 B / interrupted）。
const evalDownloadDir = path.join(TMP_DIR, "downloads");
mkdirSync(evalDownloadDir, { recursive: true });
mkdirSync(path.join(DATA_DIR, "config"), { recursive: true });
writeFileSync(
  path.join(DATA_DIR, "config", "preferences.json"),
  JSON.stringify({ downloadDir: evalDownloadDir }, null, 2),
  "utf8",
);

const resolvedTasksFile = path.join(TMP_DIR, "browser-agent-tasks.resolved.json");
writeFileSync(resolvedTasksFile, JSON.stringify({ baseUrl: taskSet.baseUrl, tasks }, null, 2), "utf8");

const evalSource = `(async () => {
  const api = window.loopsoarAPI;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const TASKS = ${JSON.stringify(tasks)};
  const DEFAULT_TASK_TIMEOUT_MS = ${DEFAULT_TASK_TIMEOUT_MS};
  const MAX_TASK_ATTEMPTS = ${MAX_TASK_ATTEMPTS};
  const RETRY_TASK_TIMEOUT_MS = ${RETRY_TASK_TIMEOUT_MS};
  const results = [];
  if (!api) return { ok: false, error: "window.loopsoarAPI 不存在" };
  const skip = Array.from(document.querySelectorAll("button")).find((b) => (b.textContent || "").trim() === "跳过");
  if (skip) { skip.click(); await sleep(400); }
  try {
    const provider = await api.settings.upsertProvider({
      provider: "mock-browser-eval",
      baseUrl: "http://127.0.0.1:${MOCK_PORT}/v1",
      model: "mock-model",
      apiFormat: "openai",
    });
    await api.settings.setApiKey({ apiKey: "sk-mock-eval", providerId: provider?.item?.id });
  } catch (err) {
    return { ok: false, error: "provider_setup:" + (err && err.message ? err.message : String(err)) };
  }

  let active = null;
  const offAsk = api.on("ask:user", (payload) => {
    if (!active || !payload) return;
    active.askSeen = { kind: payload.kind || "ask", question: String(payload.question || "").slice(0, 160) };
    if (payload.kind === "sensitive") {
      if (active.task.stopAfterAsk) {
        active.stopped = true;
        try { void api.chat.stop({ sessionId: active.sid }); } catch (err) { active.stopError = String(err); }
      }
      const answer = active.task.confirm === "allow" ? "confirm" : "取消";
      setTimeout(() => { void api.ask.respond({ requestId: payload.requestId, answer }); }, 300);
    } else {
      setTimeout(() => { void api.ask.respond({ requestId: payload.requestId, answer: (payload.options || [])[0] || "继续" }); }, 120);
    }
  });
  const offPerm = api.on("perm:request", (payload) => {
    if (!payload) return;
    const sensitiveCategory = ["payment", "login", "irreversible"].includes(payload.category);
    const isSensitive = payload.kind === "sensitive" || sensitiveCategory;
    if (isSensitive) {
      if (!active) { void api.perm.respond({ requestId: payload.requestId, choice: "deny" }); return; }
      active.askSeen = {
        kind: "sensitive",
        question: String(payload.reason || payload.target || "").slice(0, 160),
      };
      if (active.task.stopAfterAsk) {
        active.stopped = true;
        try { void api.chat.stop({ sessionId: active.sid }); } catch (err) { active.stopError = String(err); }
      }
      const choice = active.task.confirm === "allow" ? "allow-once" : "deny";
      setTimeout(() => { void api.perm.respond({ requestId: payload.requestId, choice }); }, 250);
      return;
    }
    setTimeout(() => { void api.perm.respond({ requestId: payload.requestId, choice: "allow-once" }); }, 120);
  });

  const closeTabs = async (sessionId) => {
    if (!sessionId) return;
    try { await api.browser.closeSessionTabs({ sessionId }); } catch (err) { void err; }
  };

  const runTask = async (task, attempt) => {
    const started = Date.now();
    const rec = {
      id: task.id,
      name: task.name,
      ok: false,
      failures: [],
      durationMs: 0,
      askSeen: null,
      attempts: attempt,
      retried: attempt > 1,
    };
    let sid = null;
    let taskSid = null;
    try {
      const created = await api.chat.newSession({});
      sid = created?.session?.sessionId || null;
      if (!sid) throw new Error("newSession 失败");
      await api.chat.switchSession({ sessionId: sid });
      const control = await api.chat.setBrowserControl({ sessionId: sid, enabled: true });
      rec.browserControl = control?.ok ?? null;
      const nav = await api.browser.navigate({ url: task.startUrl, sessionId: sid, origin: "agent" });
      rec.startOk = nav?.ok ?? null;
      // 切到该任务工作区：只建 agent 标签但不 showTask 时，visibleSession 可能仍停在上一条任务，
      // 后续点击/选择会卡在旧可见会话上。这里显式让任务标签成为当前可见标签。
      try { await api.browser.showTask({ sessionId: sid }); } catch (err) { void err; }
      await sleep(200);
      active = { task, sid, askSeen: null };
      const streamPromise = new Promise((resolve) => {
        let settled = false;
        let timer = null;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          off();
          offErr();
          resolve(value);
        };
        const off = api.on("chat:stream:done", (p) => { if (p && p.sessionId === sid) finish({ done: true }); });
        const offErr = api.on("chat:stream:error", (p) => {
          if (p && p.sessionId === sid) finish({ done: false, error: true });
        });
        timer = setTimeout(
          () => finish({ done: false, timeout: true }),
          attempt === 1
            ? task.timeoutMs || DEFAULT_TASK_TIMEOUT_MS
            : Math.min(task.timeoutMs || RETRY_TASK_TIMEOUT_MS, RETRY_TASK_TIMEOUT_MS),
        );
      });
      await api.chat.stream({ message: "[[" + "TASK:" + task.id + "]] " + task.goal, sessionId: sid, mode: "build" });
      const stream = await streamPromise;
      rec.done = stream.done;
      if (stream.timeout) rec.failures.push("stream_not_done");
      else if (stream.error) rec.failures.push("stream_error");
      // 首个浏览器动作会在回合结束把「用户消息+回复」搬到任务分支（fork）；
      // 历史必须从分支读，否则拿到的是被搬空的原会话。分支是异步落库的，等事件或短轮询。
      const fork = await new Promise((resolve) => {
        let settled = false;
        const finish = (value) => { if (settled) return; settled = true; off(); resolve(value); };
        const off = api.on("chat:taskForked", (p) => {
          if (p && p.from === sid && typeof p.to === "string") finish(p.to);
        });
        setTimeout(() => finish(null), 1500);
      });
      taskSid = fork || sid;
      if (fork) {
        rec.forked = true;
        await api.chat.switchSession({ sessionId: fork });
        await sleep(150);
      }
      let snap = null;
      try { snap = await api.browser.snapshot(); } catch (err) { rec.snapshotError = String(err && err.message ? err.message : err); }
      const history = await api.chat.history();
      const text = (history?.session?.messages || []).map((m) => String(m.text || "")).join("\\n");
      try { snap = snap || await api.browser.snapshot(); } catch (err) { rec.snapshotError = String(err && err.message ? err.message : err); }
      const pageText = String(snap?.text || "");
      const pageTitle = String(snap?.title || "");
      rec.historyTail = text.slice(-500);
      rec.pageTextTail = pageText.slice(0, 400);
      const a = task.assert || {};
      const check = (label, cond) => { if (!cond) rec.failures.push(label); };
      for (const s of a.pageTextIncludes || []) check("pageText_has:" + s, pageText.includes(s));
      for (const s of a.pageTextExcludes || []) check("pageText_lacks:" + s, !pageText.includes(s));
      for (const s of a.historyIncludes || []) check("history_has:" + s, text.includes(s));
      for (const s of a.historyExcludes || []) check("history_lacks:" + s, !text.includes(s));
      if ((a.historyIncludesAny || []).length) check("history_has_any", a.historyIncludesAny.some((s) => text.includes(s)));
      if ((a.pageTitleIncludes || []).length) check("pageTitle_has_any", a.pageTitleIncludes.some((s) => pageTitle.includes(s)));
      if (task.expectSensitiveAsk) check("sensitive_ask_seen", Boolean(active.askSeen));
      rec.askSeen = active.askSeen;
      rec.stopped = Boolean(active.stopped);
      rec.ok = rec.failures.length === 0;
    } catch (err) {
      rec.failures.push("error:" + (err && err.message ? err.message : String(err)));
    } finally {
      rec.durationMs = Date.now() - started;
      // 超时后先停掉旧回合，避免后台模型继续写；再关掉两个会话的标签页。
      if (!rec.done && sid) {
        try { await api.chat.stop({ sessionId: sid }); } catch (err) { void err; }
      }
      await closeTabs(sid);
      if (taskSid && taskSid !== sid) await closeTabs(taskSid);
      // 清掉任务工作区标记，避免下一条任务复用上一条任务的浏览器所有权/确认状态。
      try { await api.browser.endTask({ sessionId: sid }); } catch (err) { void err; }
      active = null;
    }
    return rec;
  };

  for (const task of TASKS) {
    let first = null;
    let rec = null;
    for (let attempt = 1; attempt <= MAX_TASK_ATTEMPTS; attempt += 1) {
      const current = await runTask(task, attempt);
      if (attempt === 1) first = current;
      rec = current;
      if (rec.ok || !rec.failures.includes("stream_not_done") || task.envSkip) break;
      await sleep(1500);
    }
    if (rec && rec.retried && first) rec.firstFailures = first.failures.slice();
    results.push(rec);
    // 给上一轮 ChatService 的收尾/落库留出时间；否则下一任务可能抢在旧 request 完全释放前启动。
    await sleep(1000);
  }
  offAsk();
  offPerm();
  return { ok: results.every((r) => r.ok), passed: results.filter((r) => r.ok).length, total: results.length, results };
})()`;

const evalFile = path.join(TMP_DIR, "browser-agent-eval.js");
writeFileSync(evalFile, evalSource, "utf8");

const children = [];
const logStream = createWriteStream(path.join(OUT_DIR, "run.log"), { flags: "w" });
function start(name, argsList, env = {}) {
  const child = spawn(process.execPath, argsList, { cwd: ROOT, env: { ...process.env, ...env } });
  children.push(child);
  const onData = (buf) => {
    const text = buf.toString();
    logStream.write(`[${name}] ${text}`);
    if (process.env.BROWSER_EVAL_VERBOSE === "1") process.stdout.write(`[${name}] ${text}`);
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  return child;
}

async function waitForPort(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/`);
      return true;
    } catch {
      // 未就绪
    }
    await sleep(250);
  }
  return false;
}

let exitCode = 1;
let evalOut = null;
let payState = null;
try {
  start("pages", [path.join(ROOT, "scripts/browser-agent-pages.mjs"), String(PAGE_PORT)]);
  start("mock", [path.join(ROOT, "scripts/mock-openai-server.mjs"), String(MOCK_PORT)], {
    MOCK_TASK_FILE: resolvedTasksFile,
  });
  const [pageOk, mockOk] = await Promise.all([waitForPort(PAGE_PORT), waitForPort(MOCK_PORT)]);
  if (!pageOk || !mockOk) throw new Error(`本地服务未就绪 page=${pageOk} mock=${mockOk}`);

  const app = start("app", [path.join(ROOT, "scripts/dev-gui.mjs")], {
    LOOPSOAR_DATA_DIR: DATA_DIR,
    LOOPSOAR_ALLOW_LOOPBACK: "1",
    LOOPSOAR_E2E_HOLD_MS: "1200",
    LOOPSOAR_E2E_SHOT: path.join(OUT_DIR, "window.png"),
    LOOPSOAR_E2E_EVAL_FILE: evalFile,
  });

  exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.error("超时：强制结束 Electron");
      app.kill("SIGKILL");
      resolve(2);
    }, Math.max(180000, tasks.length * 60000));
    app.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? 0);
    });
  });

  const logText = readFileSync(path.join(OUT_DIR, "run.log"), "utf8");
  const line = logText
    .split(/\r?\n/)
    .filter((item) => item.includes("E2E_EVAL "))
    .pop();
  if (line) {
    try {
      evalOut = JSON.parse(line.slice(line.indexOf("E2E_EVAL ") + "E2E_EVAL ".length));
    } catch (err) {
      console.error(`E2E_EVAL 解析失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // 页面服务仍活着时读支付计数：确认被拒绝的支付没有真的发出请求。
  payState = await fetch(`http://127.0.0.1:${PAGE_PORT}/api/pay-count`).then((r) => r.json()).catch(() => null);
} catch (err) {
  console.error(`评测失败：${err instanceof Error ? err.message : String(err)}`);
} finally {
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      // 已退出
    }
  }
  logStream.end();
}

const results = evalOut?.results ?? [];
// 环境性跳过：个别能力被宿主系统拦截（例如本机 Electron 下载在 0 B 处被中断），
// 隔离探针已证明与产品代码无关时，记「跳过」而不是「通过」——不伪装成功。
for (const result of results) {
  const rule = tasks.find((task) => task.id === result.id)?.envSkip;
  if (!rule || result.ok) continue;
  const text = [...(result.failures ?? []), result.historyTail ?? "", result.pageTextTail ?? ""].join("\n");
  if (rule.errorIncludes.every((needle) => text.includes(needle))) {
    result.skipped = true;
    result.skipReason = rule.reason;
  }
}
const passed = results.filter((r) => r.ok).length;
const skipped = results.filter((r) => r.skipped).length;
const failed = results.filter((r) => !r.ok && !r.skipped).length;
const report = {
  startedAt: new Date().toISOString(),
  mode: args.has("--all") ? "all" : tasksArg ? "subset" : "core",
  electronExit: exitCode,
  ok: evalOut !== null && results.length === tasks.length && failed === 0,
  passed,
  skipped,
  failed,
  total: results.length,
  payRequests: payState?.count ?? null,
  results,
};
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(path.join(OUT_DIR, "report.json"), JSON.stringify(report, null, 2), "utf8");

const icon = (r) => (r.ok ? "✅" : r.skipped ? "⏭️" : "❌");
const lines = [
  `# 浏览器 Agent 任务评测（${report.mode}）`,
  "",
  `- 时间：${report.startedAt}`,
  `- 通过：${passed}/${results.length}${skipped ? `（环境跳过 ${skipped}）` : ""}`,
  `- 支付请求数（应为 0）：${report.payRequests}`,
  "",
  "| # | 任务 | 结果 | 尝试 | 耗时 | 失败项 |",
  "|---|---|---|---|---|---|",
  ...results.map(
    (r) =>
      `| ${r.id} | ${r.name} | ${icon(r)} | ${r.attempts ?? 1} | ${Math.round(r.durationMs / 100) / 10}s | ${
        r.skipped ? `环境跳过：${r.skipReason}` : r.failures.join("；") || "-"
      } |`,
  ),
  "",
];
writeFileSync(path.join(OUT_DIR, "report.md"), lines.join("\n"), "utf8");

console.log(lines.join("\n"));
if (failed > 0) {
  const failedList = results.filter((r) => !r.ok && !r.skipped);
  for (const item of failedList) {
    console.log(`\n--- 任务 ${item.id} ${item.name} ---`);
    console.log("失败：" + item.failures.join("；"));
    if (item.historyTail) console.log("历史尾部：" + item.historyTail.replace(/\s+/g, " ").slice(-400));
    if (item.pageTextTail) console.log("页面尾部：" + item.pageTextTail.replace(/\s+/g, " ").slice(0, 300));
  }
}
console.log(`\n报告：${path.join(OUT_DIR, "report.md")}`);
process.exitCode = report.ok || reportOnly ? 0 : 1;
