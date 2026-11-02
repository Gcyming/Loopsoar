/**
 * LoopRuntime L2 声明式（shell/loopRuntime.ts）：
 * 扫描可见性、提示注入、limits 收紧、工具白名单（清单过滤 + 执行拦截）、reload、L3 委派与回退。
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockLlmClient } from "../../packages/core/src/llm/index.ts";
import { SteerBus } from "../../packages/core/src/steerBus.ts";
import type { LlmChunk, LlmClient, LlmRequest } from "../../packages/core/src/llm/index.ts";
import type { ToolLoopOutcome } from "../../packages/core/src/tool_loop.ts";
import {
  CORE_LOOP_ID,
  applyDeclarativeLoop,
  createLoopRuntime,
  type LoopRunInput,
  type LoopRuntimeOptions,
} from "../../packages/shell/src/main/loopRuntime.ts";
import type { ScriptRunInput } from "../../packages/shell/src/main/scriptLoopHost.ts";

const createdDirs: string[] = [];

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** 预建 loops 目录（避免首次扫描生成 example.json 干扰断言）。 */
function makeDataDir(): { dataDir: string; loopsDir: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-loopruntime-"));
  createdDirs.push(dataDir);
  const loopsDir = path.join(dataDir, "loops");
  fs.mkdirSync(loopsDir, { recursive: true });
  return { dataDir, loopsDir };
}

function writeLoop(loopsDir: string, id: string, body: Record<string, unknown> = {}): void {
  fs.writeFileSync(path.join(loopsDir, `${id}.json`), JSON.stringify({ name: id, ...body }, null, 2), "utf8");
}

function writeScriptLoop(loopsDir: string, id: string, manifest: Record<string, unknown>): string {
  const dir = path.join(loopsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "loop.json"), JSON.stringify(manifest, null, 2), "utf8");
  fs.writeFileSync(path.join(dir, "loop.mjs"), "export async function run() {}\n", "utf8");
  return dir;
}

function createRuntime(dataDir: string | undefined, extra: Partial<LoopRuntimeOptions> = {}) {
  const pushes: { event: string; payload: unknown }[] = [];
  const runtime = createLoopRuntime({
    push: (event, payload) => {
      pushes.push({ event, payload });
    },
    ...(dataDir ? { dataDir } : {}),
    ...extra,
  });
  return { runtime, pushes };
}

/** 记录请求的 LLM：让断言能看见「注入后的消息」与「过滤后的工具清单」。 */
class CapturingLlm implements LlmClient {
  readonly requests: LlmRequest[] = [];

  constructor(private readonly scripts: LlmChunk[][]) {}

  async *invoke(request: LlmRequest): AsyncIterable<LlmChunk> {
    this.requests.push(request);
    const script = this.scripts.shift() ?? [{ kind: "done" }];
    for (const chunk of script) yield chunk;
  }
}

function doneOutcome(finalText: string): ToolLoopOutcome {
  return {
    status: "done",
    reason: "custom",
    finalText,
    usage: { rounds: 1, toolCalls: 0, totalTokens: 0, wallClockMs: 0 },
  };
}

/** 一次 loop 运行的最小输入（内置 runToolLoop 消费它）。 */
function baseInput(llm: LlmClient, extra: Partial<LoopRunInput> = {}): LoopRunInput {
  return {
    sessionId: "s1",
    llm,
    tools: () => [],
    executeTool: { invoke: async () => ({ ok: true, content: "" }) },
    limits: { maxRounds: 5, maxToolCalls: 5 },
    budget: { rounds: 0, toolCalls: 0, totalTokens: 0, wallClockMs: 0 },
    sink: () => undefined,
    steers: new SteerBus(),
    ...extra,
  };
}

const FILE_READ = { name: "file_read", description: "读文件", parameters: {} };
const FILE_WRITE = { name: "file_write", description: "写文件", parameters: {} };

describe("LoopRuntime L2：扫描与列表", () => {
  it("L2 出现在 list（kind/valid/description），内置永远排第一", () => {
    const { dataDir, loopsDir } = makeDataDir();
    writeLoop(loopsDir, "helper", { description: "辅助 loop", systemPromptAppend: "MARKER", maxRounds: 2 });

    const { runtime } = createRuntime(dataDir);
    const payload = runtime.list();

    expect(payload.activeId).toBe(CORE_LOOP_ID);
    expect(payload.loops[0]).toMatchObject({
      id: CORE_LOOP_ID,
      kind: "builtin",
      builtin: true,
      active: true,
      valid: true,
    });
    const helper = payload.loops.find((loop) => loop.id === "helper");
    expect(helper).toMatchObject({
      kind: "declarative",
      builtin: false,
      active: false,
      valid: true,
      description: "辅助 loop",
    });
    expect(payload.errors).toEqual([]);
  });

  it("手工 register 的自定义 loop 仍可用（kind 兜底 declarative）", () => {
    const { dataDir } = makeDataDir();
    const { runtime } = createRuntime(dataDir);
    runtime.registry.register({ id: "manual", name: "手工 loop", runner: async () => doneOutcome("手工输出") });

    const entry = runtime.list().loops.find((loop) => loop.id === "manual");
    expect(entry).toMatchObject({ kind: "declarative", builtin: false, valid: true, active: false });
  });

  it("坏文件：list 中 valid:false + error，setActive 抛错，好 loop 不受影响", () => {
    const { dataDir, loopsDir } = makeDataDir();
    writeLoop(loopsDir, "ok");
    fs.writeFileSync(path.join(loopsDir, "broken.json"), "{ not json", "utf8");

    const { runtime } = createRuntime(dataDir);
    const payload = runtime.list();

    const broken = payload.loops.find((loop) => loop.id === "broken");
    expect(broken).toMatchObject({ valid: false, builtin: false });
    expect(String(broken?.error)).toMatch(/JSON 解析失败/);
    expect(payload.errors).toHaveLength(1);
    expect(payload.loops.some((loop) => loop.id === "ok" && loop.valid)).toBe(true);
    expect(() => runtime.setActive("broken")).toThrow(/不存在/);
  });
});

describe("LoopRuntime L2：运行注入与限制", () => {
  it("systemPromptAppend 作为额外 user 消息注入；白名单过滤给模型的工具清单", async () => {
    const { dataDir, loopsDir } = makeDataDir();
    writeLoop(loopsDir, "helper", {
      name: "辅助 Loop",
      systemPromptAppend: "EXTRA_MARKER 先计划再动手",
      allowedTools: ["file_read"],
    });

    const { runtime } = createRuntime(dataDir);
    const llm = new CapturingLlm([[{ kind: "text", text: "OK" }, { kind: "done" }]]);
    const outcome = await runtime.run({
      ...baseInput(llm),
      loopId: "helper",
      tools: () => [FILE_READ, FILE_WRITE],
    });

    expect(outcome.status).toBe("done");
    const request = llm.requests[0]!;
    expect(request.tools?.map((tool) => tool.name)).toEqual(["file_read"]);
    const lastMessage = request.messages[request.messages.length - 1]!;
    expect(lastMessage.role).toBe("user");
    expect(lastMessage.content).toContain("【Loop 指令：辅助 Loop】");
    expect(lastMessage.content).toContain("EXTRA_MARKER");
  });

  it("limits 收紧真实生效：声明 maxRounds=2 而调用方给 10 → 两轮即收束", async () => {
    const { dataDir, loopsDir } = makeDataDir();
    writeLoop(loopsDir, "two-rounds", { maxRounds: 2 });

    const { runtime } = createRuntime(dataDir);
    const scripts: LlmChunk[][] = Array.from({ length: 5 }, (_, index) => [
      { kind: "tool_call", toolCall: { id: `c${index}`, name: "file_read", args: { path: "a.txt" } } },
    ]);
    const llm = new CapturingLlm(scripts);
    const outcome = await runtime.run({
      ...baseInput(llm),
      loopId: "two-rounds",
      tools: () => [FILE_READ],
      limits: { maxRounds: 10, maxToolCalls: 50 },
    });

    expect(outcome.status).toBe("budget");
    expect(outcome.reason).toContain("轮次");
    expect(llm.requests).toHaveLength(2);
  });
});

describe("applyDeclarativeLoop（纯函数）", () => {
  const config = {
    id: "l2",
    name: "L2 循环",
    systemPromptAppend: "APPEND",
    maxRounds: 2,
    maxToolCalls: 50,
    allowedTools: ["a"],
  };

  it("注入消息、limits 只能收紧、原 opts 不被修改", () => {
    const opts = baseInput(new MockLlmClient(), { tools: () => [FILE_READ, FILE_WRITE] });
    const applied = applyDeclarativeLoop(config, opts);

    expect(applied.messages).toHaveLength(1);
    expect(applied.messages![0]).toMatchObject({ role: "user" });
    expect(applied.messages![0]!.content).toContain("APPEND");

    // 调用方 5 → 声明 2 取 2；调用方 5 → 声明 50 仍取 5（不能放宽）
    expect(applied.limits.maxRounds).toBe(2);
    expect(applied.limits.maxToolCalls).toBe(5);

    // 原 opts 不被就地修改
    expect(opts.messages).toBeUndefined();
    expect(opts.limits.maxRounds).toBe(5);
  });

  it("工具白名单：过滤清单 + 执行器二次拦截（纵深防御）", async () => {
    const called: string[] = [];
    const opts = baseInput(new MockLlmClient(), {
      tools: () => [FILE_READ, FILE_WRITE],
      executeTool: {
        invoke: async (toolCall) => {
          called.push(toolCall.name);
          return { ok: true, content: `${toolCall.name} ok` };
        },
      },
    });
    // 白名单用真实存在的工具名（describe 级 config 的 ["a"] 只用于检验"过滤为空"的边界）
    const applied = applyDeclarativeLoop({ ...config, allowedTools: ["file_read"] }, opts);

    expect(applied.tools().map((tool) => tool.name)).toEqual(["file_read"]);

    const denied = await applied.executeTool.invoke({ id: "1", name: "file_write", args: {} });
    expect(denied).toMatchObject({ ok: false, error: "loop-tool-denied" });
    expect(denied.content).toContain("allowedTools");
    expect(called).toEqual([]); // 白名单外的工具根本没到执行器

    const allowed = await applied.executeTool.invoke({ id: "2", name: "file_read", args: {} });
    expect(allowed.ok).toBe(true);
    expect(called).toEqual(["file_read"]);
  });

  it("省略白名单/提示：不限制工具、不注入消息", () => {
    const opts = baseInput(new MockLlmClient(), { tools: () => [FILE_READ, FILE_WRITE] });
    const applied = applyDeclarativeLoop({ id: "plain", name: "无附加" }, opts);

    expect(applied.messages).toBeUndefined();
    expect(applied.tools().map((tool) => tool.name)).toEqual(["file_read", "file_write"]);
    expect(applied.limits.maxRounds).toBe(5);
  });
});

describe("LoopRuntime：reload 与 L3", () => {
  it("reload：新增/删除文件即时生效 + push loop:changed；活动 loop 被删则回落 builtin", () => {
    const { dataDir, loopsDir } = makeDataDir();
    writeLoop(loopsDir, "alpha");

    const { runtime, pushes } = createRuntime(dataDir);
    runtime.setActive("alpha");
    expect(runtime.list().activeId).toBe("alpha");

    fs.rmSync(path.join(loopsDir, "alpha.json"));
    writeLoop(loopsDir, "beta", { description: "新加的" });

    const payload = runtime.reload();

    expect(payload.loops.map((loop) => loop.id).sort()).toEqual([CORE_LOOP_ID, "beta"].sort());
    expect(payload.loops.find((loop) => loop.id === "beta")?.description).toBe("新加的");
    expect(payload.activeId).toBe(CORE_LOOP_ID);
    expect(payload.errors).toEqual([]);
    const changedEvents = pushes.filter((item) => item.event === "loop:changed");
    expect(changedEvents).toHaveLength(2); // setActive + reload
    expect((changedEvents[1]!.payload as { activeId: string }).activeId).toBe(CORE_LOOP_ID);
  });

  it("L3 脚本：list kind=script；运行委托 scriptHost 输入；崩溃 → 回退 builtin 且原因可见", async () => {
    const { dataDir, loopsDir } = makeDataDir();
    const scriptDir = writeScriptLoop(loopsDir, "scripty", {
      kind: "script",
      name: "脚本循环",
      description: "RPC 编排",
    });

    let failMode = false;
    /** 用容器承接闭包内赋值（避免 TS 把 let 变量在外部收窄成 null）。 */
    const capturedRef: { value?: ScriptRunInput } = {};
    const { runtime, pushes } = createRuntime(dataDir, {
      scriptHost: {
        run: async (input) => {
          capturedRef.value = input;
          if (failMode) throw new Error("worker 崩了");
          return doneOutcome("脚本完成");
        },
      },
    });

    expect(runtime.list().loops.find((loop) => loop.id === "scripty")).toMatchObject({
      kind: "script",
      valid: true,
      description: "RPC 编排",
    });

    const okOutcome = await runtime.run({ ...baseInput(new MockLlmClient()), loopId: "scripty" });
    expect(okOutcome.finalText).toBe("脚本完成");
    expect(capturedRef.value).toBeDefined();
    const input = capturedRef.value!;
    expect(input.loopId).toBe("scripty");
    expect(input.loopDir).toBe(scriptDir);
    expect(input.script).toBe("loop.mjs");

    // 崩溃 → LoopRegistry 同一 ctx 回退 builtin（用新 LLM 脚本验证内置循环真的跑了）
    failMode = true;
    const fallbackLlm = new MockLlmClient();
    fallbackLlm.addScript([{ kind: "text", text: "回退后完成" }, { kind: "done" }]);
    const fallback = await runtime.run({ ...baseInput(fallbackLlm), loopId: "scripty" });

    expect(fallback.status).toBe("done");
    expect(fallback.finalText).toContain("回退后完成");
    expect(pushes.some((item) => item.event === "loop:fallback")).toBe(true);
    expect(runtime.list().fallbacks[0]!.reason).toContain("worker 崩了");
  });
});
