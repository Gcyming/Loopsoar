/**
 * 本地 Mock OpenAI 兼容服务（仅用于 E2E 验收：验证「真 HTTP 流式对话」闭环）。
 * 用法：node scripts/mock-openai-server.mjs [port]
 * 不依赖任何外部网络；任何 model 名都接受。
 *
 * 环境变量：
 *   MOCK_FIRST_DELAY_MS  首字延迟（模拟慢上游）
 *   MOCK_TOOL_NAME       工具名（逗号分隔可连续调用）；第一轮返回该工具的 tool_call，收到结果后继续下一轮
 *   MOCK_TOOL_ARGS       工具调用参数 JSON（默认 "{}"）
 *   MOCK_PLAN=1          在工具序列后追加一次 todo_write（用于演示时间线的任务规划卡）
 *   MOCK_REASONING=1     每轮先吐 reasoning（用于演示思考时间线）
 *   MOCK_TASK_FILE      任务级评测：JSON 任务表；请求里的用户消息带 [[TASK:n]] 时按该任务的 plan 逐步回放
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const port = Number(process.argv[2] ?? 19500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 任务表在启动时加载一次：评测是「同一进程跑多任务」，不能每个请求都读盘。 */
let taskSet = null;
if (process.env.MOCK_TASK_FILE) {
  try {
    taskSet = JSON.parse(readFileSync(process.env.MOCK_TASK_FILE, "utf8"));
    console.log(`MOCK_TASKS_LOADED ${(taskSet.tasks ?? taskSet).length}`);
  } catch (err) {
    console.log(`MOCK_TASKS_ERROR ${err instanceof Error ? err.message : String(err)}`);
  }
}

const REPLY_CHUNKS = [
  "你好！我是 Loopsoar（本地模拟模型）。",
  "\n\n这条回复来自**真实 HTTP SSE 流式通道**：\n\n",
  "- 支持 Markdown 渲染（标题/列表/引用/链接）\n",
  "- 代码块带复制按钮\n",
  "- 行内代码 `loopsoar`\n\n",
  "### 示例代码\n\n```ts\nconst loopsoar = createAgent({\n  mode: \"build\",\n});\nconsole.log(loopsoar.id);\n```\n\n",
  "> 引用：这是 slime 风格渲染的样例。\n\n",
  "| 特性 | 支持 |\n|---|---|\n| 流式输出 | ✓ |\n| 工具调用 | ✓ |\n| Markdown 表格 | ✓ |\n\n",
  "更多见 [Loopsoar](https://example.com)。",
];

/**
 * 逐个工具调用的参数：MOCK_TOOL_ARGS_SEQ='["{...}","{}"]'（按第 N 次工具调用取第 N 项），
 * 缺省回退到单一 MOCK_TOOL_ARGS。浏览器 Agent 的 E2E 需要「导航→快照→点击→快照」不同参数，
 * 单一 MOCK_TOOL_ARGS 表达不了这种序列，故补这一项（不影响既有用法）。
 */
function argsFor(index) {
  const raw = process.env.MOCK_TOOL_ARGS_SEQ;
  if (raw) {
    try {
      const list = JSON.parse(raw);
      if (Array.isArray(list) && typeof list[index] === "string") return list[index];
    } catch {
      // 配置写坏时按缺省处理，不阻断 mock 服务
    }
  }
  return process.env.MOCK_TOOL_ARGS || "{}";
}

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeDone(res) {
  res.write("data: [DONE]\n\n");
  res.end();
}

const server = createServer(async (req, res) => {
  if (!req.url || !req.url.endsWith("/chat/completions")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body = {};
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    body = {};
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  // E2E 探针：只要任一请求消息里出现 MOCK_PROBE 文本，就记一行命中日志（用于断言「记忆已被注入模型请求」）。
  // 只读日志、不影响响应；生产不使用该脚本。
  if (process.env.MOCK_PROBE) {
    const probe = process.env.MOCK_PROBE;
    const hit = messages.some((message) => {
      const content = message?.content;
      if (typeof content === "string") return content.includes(probe);
      if (Array.isArray(content)) return content.some((part) => typeof part?.text === "string" && part.text.includes(probe));
      return false;
    });
    console.log(`MOCK_PROBE_HIT=${hit ? 1 : 0} probe=${JSON.stringify(probe)}`);
  }
  // 任务级评测：用户消息里的 [[TASK:n]] 决定回放哪条 plan；用已返回的 tool 消息数推进步骤。
  // 这样 30 个任务可以共用一次 Electron 启动和一个 mock 服务，不必为每个任务重启应用。
  if (taskSet) {
    const lastUser = [...messages].reverse().find((msg) => msg.role === "user");
    const userText =
      typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
    const match = /\[\[TASK:(\d+)\]\]/.exec(userText);
    const list = taskSet.tasks ?? taskSet;
    const task = match ? list.find((item) => item.id === Number(match[1])) : null;
    if (task) {
      const used = messages.filter((msg) => msg.role === "tool").length;
      const step = Array.isArray(task.plan) ? task.plan[used] : null;
      if (step) {
        sse(res, {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: `call_task${task.id}_${used + 1}`,
                    type: "function",
                    function: { name: step.tool, arguments: JSON.stringify(step.args ?? {}) },
                  },
                ],
              },
            },
          ],
        });
        sse(res, { usage: { total_tokens: 32 } });
        writeDone(res);
        return;
      }
      // 回显最近工具结果：评测断言读的是会话历史，而工具结果本身不落盘；
      // 真实模型会把关键结果写进答复，这里等价地回显，避免断言依赖内部实现。
      const recentTools = messages
        .filter((msg) => msg.role === "tool")
        .slice(-4)
        .map((msg) => (typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)))
        .join("\n---\n")
        .slice(-4000);
      const reply = `[[任务完成]] ${task.name ?? ""}（${used} 步）\n\n${recentTools}`;
      sse(res, { choices: [{ delta: { content: reply } }] });
      sse(res, { usage: { total_tokens: 16 } });
      writeDone(res);
      return;
    }
  }

  const toolName = process.env.MOCK_TOOL_NAME;
  console.log(`MOCK_REQ roles=${messages.map((m) => m.role).join(",")} tool=${toolName ?? "-"}`);
  if (process.env.MOCK_LOG_HEADERS === "1") {
    const keep = ["user-agent", "x-opencode-session", "x-request-id", "x-test-request", "authorization"];
    const picked = Object.fromEntries(keep.map((name) => [name, req.headers[name] ?? null]));
    console.log(`MOCK_HEADERS ${JSON.stringify(picked)}`);
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(": loopsoar mock stream\n\n");

  // 工具轮模拟：按 MOCK_TOOL_NAME 的顺序逐个调用；MOCK_PLAN=1 追加 todo_write；MOCK_REASONING=1 先吐思考
  // MOCK_TOOL_FIRST_USER_ONLY=1：只有第一轮用户消息造工具调用，之后的用户轮直接走文本回复
  // （六步 E2E 要用「同一会话的下一轮」验证记忆注入，不能被 mock 再造一次工具调用打断）。
  const skipToolsForLaterTurns =
    process.env.MOCK_TOOL_FIRST_USER_ONLY === "1" && messages.filter((msg) => msg.role === "user").length > 1;
  if (toolName && !skipToolsForLaterTurns) {
    const calls = toolName.split(",").map((x) => x.trim()).filter(Boolean);
    if (process.env.MOCK_PLAN === "1") calls.push("todo_write");
    const toolResultCount = messages.filter((msg) => msg.role === "tool").length;
    if (process.env.MOCK_REASONING === "1") {
      const thoughts = process.env.MOCK_REASONING_MARKDOWN === "1"
        ? (toolResultCount === 0
          ? [
              `用户想了解当前页面的内容。
我先看一遍页面结构，再决定是否需要读取正文。
这两句属于同一段落，应该自然换行而不是每行单独成段。`,
              `

---

### 检查要点
- 页面标题与正文是否一致
- 工具结果是否完整返回
- 需要时用 todo_write 记录规划

1. 先读页面
2. 再核对信息
3. 最后输出结论`,
            ]
          : [`工具结果已经回来了。
先核对页面标题与正文，再整理成简洁结论。`, `

---

整理完成，准备输出。`])
        : (toolResultCount === 0
          ? ["用户想了解当前页面的内容。", "我应该先读取页面快照，再根据结果总结。", "如果页面没有打开，就先导航到目标地址。"]
          : ["工具结果已经回来了。", "先核对页面标题与正文，再整理成简洁结论。", "如果需要分步骤推进，可以用 todo_write 记录规划。"]);
      for (const thought of thoughts) {
        sse(res, { choices: [{ delta: { reasoning_content: thought } }] });
        await sleep(70);
      }
    }
    if (toolResultCount < calls.length) {
      const name = calls[toolResultCount];
      const args = name === "todo_write"
        ? JSON.stringify({
            items: [
              { content: "读取当前页面快照", status: "completed" },
              { content: "核对页面标题与正文", status: "in_progress" },
              { content: "输出结构化结论", status: "pending" },
            ],
          })
        : argsFor(toolResultCount);
      sse(res, {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: `call_mock_${toolResultCount + 1}`, type: "function", function: { name, arguments: args } },
              ],
            },
          },
        ],
      });
      sse(res, { usage: { total_tokens: 64 } });
      writeDone(res);
      return;
    }
    const lastTool = [...messages].reverse().find((msg) => msg.role === "tool");
    const toolText = typeof lastTool?.content === "string" ? lastTool.content : "";
    console.log(`MOCK_TOOL_RESULT ${toolText.slice(0, 300).replace(/\s+/g, " ")}`);
    const reply = [
      `工具执行完成，我已拿到结果（回灌 ${toolText.length} 字符）：\n\n`,
      `${toolText.slice(0, 240)}\n\n`,
      "### 结论\n\n- 页面信息已读取并核对\n- 规划已更新（可在上方任务规划卡查看）\n\n基于以上内容，我完成了查询。",
    ].join("");
    for (const part of reply.match(/[\s\S]{1,16}/g) ?? [reply]) {
      sse(res, { choices: [{ delta: { content: part } }] });
      await sleep(45);
    }
    sse(res, { usage: { total_tokens: 128 } });
    writeDone(res);
    return;
  }

  const firstDelay = Number(process.env.MOCK_FIRST_DELAY_MS ?? "0");
  if (firstDelay > 0) await sleep(firstDelay);
  for (const chunk of REPLY_CHUNKS) {
    sse(res, { choices: [{ delta: { content: chunk } }] });
    await sleep(Number(process.env.MOCK_CHUNK_DELAY_MS ?? 140));
  }
  sse(res, { usage: { total_tokens: 420 } });
  writeDone(res);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`MOCK_OPENAI_READY http://127.0.0.1:${port}/v1`);
});
