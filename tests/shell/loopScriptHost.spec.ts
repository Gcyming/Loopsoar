/**
 * L3 脚本 loop host（shell/scriptLoopHost.ts）：RPC 帧代理、崩溃/超时回退条件、env 白名单、真实 worker 集成。
 *
 * 两类用例：
 *   · 假子进程（确定性）：验证帧协议、代理、各阶段失败如何 reject（= LoopRegistry 回退条件）；
 *   · 真实 worker（集成）：spawn 真 node + scriptLoopWorker.mjs，验证 ctx.llm/ctx.executeTool/ctx.emit 全链路。
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockLlmClient } from "../../packages/core/src/llm/index.ts";
import type { LoopEvent } from "../../packages/core/src/events.ts";
import {
  buildScriptWorkerEnv,
  resolveScriptWorkerPath,
  runScriptLoop,
  type ScriptChildLike,
  type ScriptRunInput,
  type SpawnScriptWorker,
} from "../../packages/shell/src/main/scriptLoopHost.ts";

const createdDirs: string[] = [];

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** 让 readline / data 事件跑完若干轮宏任务（RPC 帧是异步到达的）。 */
async function flush(ticks = 12): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function tempLoopDir(scriptSource = "export async function run() {}\n"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-scriptloophost-"));
  createdDirs.push(dir);
  fs.writeFileSync(path.join(dir, "loop.mjs"), scriptSource, "utf8");
  return dir;
}

/** 假子进程：stdin/stdout 管道 + kill，让 host 的 spawn 注入点可完全离线测试。 */
class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  /** host 写入的帧（按行解析）。 */
  readonly frames: Array<Record<string, unknown>> = [];
  private buffer = "";

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let newline = this.buffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line) this.frames.push(JSON.parse(line) as Record<string, unknown>);
        newline = this.buffer.indexOf("\n");
      }
    });
  }

  sendToHost(frame: unknown): void {
    this.stdout.write(`${JSON.stringify(frame)}\n`);
  }

  kill(): boolean {
    this.killed = true;
    this.emit("exit", 0, null);
    return true;
  }

  asChild(): ScriptChildLike {
    return this as unknown as ScriptChildLike;
  }
}

function fakeSpawn(fake: FakeChild): SpawnScriptWorker {
  return () => fake.asChild();
}

function baseRun(
  loopDir: string,
  extra: Partial<ScriptRunInput> = {},
): { events: LoopEvent[]; input: ScriptRunInput } {
  const events: LoopEvent[] = [];
  const input: ScriptRunInput = {
    loopId: "demo",
    loopDir,
    script: "loop.mjs",
    llm: new MockLlmClient(),
    executeTool: { invoke: async () => ({ ok: true, content: "TOOL" }) },
    sink: (event: LoopEvent) => events.push(event),
    // 注入 spawn 后不校验 worker 真实路径
    workerPath: "/virtual/scriptLoopWorker.mjs",
    startTimeoutMs: 5_000,
    callTimeoutMs: 5_000,
    totalTimeoutMs: 10_000,
    ...extra,
  };
  return { events, input };
}

describe("scriptLoopHost：帧代理（假子进程）", () => {
  it("ready→start、llm_request→代理流式、tool_call→代理工具、emit→sink、outcome→resolve", async () => {
    const loopDir = tempLoopDir();
    const fake = new FakeChild();
    const llm = new MockLlmClient();
    llm.addScript([{ kind: "text", text: "HI" }, { kind: "done" }]);
    const { events, input } = baseRun(loopDir, {
      llm,
      messages: [{ role: "user", content: "请处理" }],
      tools: () => [{ name: "file_read", description: "读", parameters: {} }],
      spawnWorker: fakeSpawn(fake),
    });

    const promise = runScriptLoop(input);
    await flush();

    fake.sendToHost({ type: "ready" });
    await flush();
    const start = fake.frames.find((frame) => frame.type === "start");
    expect(start).toMatchObject({ type: "start", loopId: "demo" });
    expect((start!.messages as unknown[]).length).toBe(1);
    expect((start!.tools as { name: string }[])[0]!.name).toBe("file_read");

    fake.sendToHost({ type: "llm_request", id: 7, request: { messages: [{ role: "user", content: "hi" }] } });
    await flush();
    expect(
      fake.frames.some((frame) => frame.type === "llm_chunk" && frame.id === 7),
    ).toBe(true);
    expect(
      fake.frames.some((frame) => frame.type === "llm_done" && frame.id === 7),
    ).toBe(true);

    fake.sendToHost({ type: "tool_call", id: 8, call: { id: "c1", name: "file_read", args: { path: "a" } } });
    await flush();
    const toolResult = fake.frames.find((frame) => frame.type === "tool_result" && frame.id === 8);
    expect(toolResult?.result).toMatchObject({ ok: true, content: "TOOL" });

    fake.sendToHost({ type: "emit", eventType: "progress", payload: { note: "中间进度" } });
    await flush();
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("progress");
    expect((events[0]!.data as { note: string }).note).toBe("中间进度");

    fake.sendToHost({
      type: "outcome",
      outcome: {
        status: "done",
        reason: "脚本完成",
        finalText: "F",
        usage: { rounds: 1, toolCalls: 1, totalTokens: 2, wallClockMs: 3 },
      },
    });
    const outcome = await promise;
    expect(outcome).toMatchObject({ status: "done", reason: "脚本完成", finalText: "F" });
    expect(outcome.usage.toolCalls).toBe(1);
    expect(fake.killed).toBe(true);
  });

  it("未知/非 JSON 输出被忽略，不影响正常收束", async () => {
    const loopDir = tempLoopDir();
    const fake = new FakeChild();
    const { input } = baseRun(loopDir, { spawnWorker: fakeSpawn(fake) });

    const promise = runScriptLoop(input);
    await flush();
    fake.sendToHost({ type: "ready" });
    await flush();
    fake.stdout.write("这不是 JSON 的日志输出\n");
    fake.sendToHost({ type: "unknown_future_frame", foo: 1 });
    fake.sendToHost({ type: "outcome", outcome: { status: "done", finalText: "OK" } });

    const outcome = await promise;
    expect(outcome.status).toBe("done");
    expect(outcome.finalText).toBe("OK");
  });
});

describe("scriptLoopHost：失败路径（= 回退 builtin 的条件）", () => {
  it("进程崩溃且无 outcome → reject（原因含退出码）", async () => {
    const loopDir = tempLoopDir();
    const fake = new FakeChild();
    const { input } = baseRun(loopDir, { spawnWorker: fakeSpawn(fake) });

    const promise = runScriptLoop(input);
    const assertion = expect(promise).rejects.toThrow(/进程退出/);
    await flush();
    fake.sendToHost({ type: "ready" });
    await flush();
    fake.emit("exit", 1, null);
    await assertion;
  });

  it("启动超时：worker 迟迟不 ready → reject", async () => {
    const loopDir = tempLoopDir();
    const fake = new FakeChild();
    const { input } = baseRun(loopDir, { spawnWorker: fakeSpawn(fake), startTimeoutMs: 20 });

    await expect(runScriptLoop(input)).rejects.toThrow(/启动超时/);
  });

  it("工具代理超时：executeTool 永不返回 → reject", async () => {
    const loopDir = tempLoopDir();
    const fake = new FakeChild();
    const { input } = baseRun(loopDir, {
      spawnWorker: fakeSpawn(fake),
      startTimeoutMs: 2_000,
      callTimeoutMs: 20,
      executeTool: { invoke: () => new Promise(() => undefined) },
    });

    const promise = runScriptLoop(input);
    const assertion = expect(promise).rejects.toThrow(/工具代理超时/);
    await flush();
    fake.sendToHost({ type: "ready" });
    await flush();
    fake.sendToHost({ type: "tool_call", id: 1, call: { id: "c", name: "x", args: {} } });
    await assertion;
  });

  it("非法 outcome → reject；worker 报 fatal → reject", async () => {
    const loopDir = tempLoopDir();

    const bad = new FakeChild();
    const badRun = baseRun(loopDir, { spawnWorker: fakeSpawn(bad) });
    const badPromise = runScriptLoop(badRun.input);
    const badAssertion = expect(badPromise).rejects.toThrow(/outcome 非法/);
    await flush();
    bad.sendToHost({ type: "ready" });
    await flush();
    bad.sendToHost({ type: "outcome", outcome: { status: "weird-status" } });
    await badAssertion;

    const fatal = new FakeChild();
    const fatalRun = baseRun(loopDir, { spawnWorker: fakeSpawn(fatal) });
    const fatalPromise = runScriptLoop(fatalRun.input);
    const fatalAssertion = expect(fatalPromise).rejects.toThrow(/脚本 loop 报错/);
    await flush();
    fatal.sendToHost({ type: "ready" });
    await flush();
    fatal.sendToHost({ type: "fatal", message: "脚本崩了" });
    await fatalAssertion;
  });

  it("预算护栏：脚本重复 llm 请求超过 maxRounds=1 → reject（不靠脚本自觉）", async () => {
    const loopDir = tempLoopDir();
    const fake = new FakeChild();
    const { input } = baseRun(loopDir, {
      spawnWorker: fakeSpawn(fake),
      limits: { maxRounds: 1, maxToolCalls: 5, maxTotalTokens: 1000, maxWallClockMs: 10_000 },
    });

    const promise = runScriptLoop(input);
    const assertion = expect(promise).rejects.toThrow(/预算收束/);
    await flush();
    fake.sendToHost({ type: "ready" });
    await flush();
    fake.sendToHost({ type: "llm_request", id: 1, request: { messages: [] } });
    await flush();
    fake.sendToHost({ type: "llm_request", id: 2, request: { messages: [] } });
    await flush();
    await assertion;
  });

  it("静态失败：脚本越界 / 脚本不存在 → spawn 前就 reject", async () => {
    const loopDir = tempLoopDir();
    await expect(
      runScriptLoop({ ...baseRun(loopDir).input, script: "../evil.mjs" }),
    ).rejects.toThrow(/相对路径/);
    await expect(
      runScriptLoop({ ...baseRun(loopDir).input, script: "nope.mjs" }),
    ).rejects.toThrow(/脚本不存在/);
  });
});

describe("scriptLoopHost：环境与真实 worker", () => {
  it("worker env 只透白名单，不透 API Key", () => {
    const env = buildScriptWorkerEnv({
      PATH: "/usr/bin",
      LOOPSOAR_API_KEY: "secret",
      OPENAI_API_KEY: "sk-xxx",
      ELECTRON_RUN_AS_NODE: "0",
    } as NodeJS.ProcessEnv);

    expect(env.PATH).toBe("/usr/bin");
    expect(env.LOOPSOAR_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("resolveScriptWorkerPath 指向真实存在的 worker 脚本", () => {
    expect(fs.existsSync(resolveScriptWorkerPath())).toBe(true);
  });

  it(
    "真实 worker 集成：ctx.llm / ctx.executeTool / ctx.emit 全链路 + outcome 回传",
    async () => {
      const loopDir = tempLoopDir(
        `export async function run(ctx) {
  let text = "";
  for await (const chunk of ctx.llm([{ role: "user", content: "hello" }])) {
    if (chunk.kind === "text") text += chunk.text;
  }
  const result = await ctx.executeTool("echo", { n: 1 });
  ctx.emit("progress", { note: "中间进度" });
  return {
    status: "done",
    reason: "script-ok",
    finalText: text + "|" + result.content,
    usage: { rounds: 1, toolCalls: 1 },
  };
}
`,
      );
      const llm = new MockLlmClient();
      llm.addScript([{ kind: "text", text: "HELLO" }, { kind: "done" }]);
      const events: LoopEvent[] = [];

      const outcome = await runScriptLoop({
        loopId: "real",
        loopDir,
        script: "loop.mjs",
        llm,
        executeTool: {
          invoke: async (toolCall) => ({ ok: true, content: `echo:${JSON.stringify(toolCall.args)}` }),
        },
        tools: () => [],
        sink: (event) => events.push(event),
        startTimeoutMs: 15_000,
        callTimeoutMs: 15_000,
        totalTimeoutMs: 15_000,
      });

      expect(outcome.status).toBe("done");
      expect(outcome.reason).toBe("script-ok");
      expect(outcome.finalText).toBe('HELLO|echo:{"n":1}');
      expect(outcome.usage.toolCalls).toBe(1);
      expect(events.some((event) => event.type === "progress")).toBe(true);
    },
    20_000,
  );
});
