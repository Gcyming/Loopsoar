import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { BackgroundTaskManager, registerBackgroundTerminalTools } from "../../packages/shell/src/main/backgroundTasks.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nodeSpec(code: string) {
  return { command: process.execPath, args: ["-e", code] };
}

describe("BackgroundTaskManager", () => {
  it("收集输出、记录退出码；offset 增量读取", async () => {
    const manager = new BackgroundTaskManager();
    try {
      const started = manager.start({
        sessionId: "s1",
        command: "node -e <bg>",
        profile: "node",
        cwd: process.cwd(),
        spec: nodeSpec('console.log("first"); setTimeout(() => console.log("second"), 150);'),
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      await wait(600);
      const all = manager.read(started.info.id, "s1", 0, 10_000);
      expect(all.ok).toBe(true);
      if (!all.ok) return;
      expect(all.chunk).toContain("first");
      expect(all.chunk).toContain("second");
      expect(all.info.running).toBe(false);
      expect(all.info.exitCode).toBe(0);

      const again = manager.read(started.info.id, "s1", all.nextOffset, 10_000);
      expect(again.ok).toBe(true);
      if (again.ok) expect(again.chunk).toBe("");
    } finally {
      manager.killAll();
    }
  });

  it("按会话隔离：别的会话读不到也杀不掉", async () => {
    const manager = new BackgroundTaskManager();
    try {
      const started = manager.start({
        sessionId: "a",
        command: "node -e <bg>",
        profile: "node",
        cwd: process.cwd(),
        spec: nodeSpec("setTimeout(() => {}, 5000)"),
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      expect(manager.read(started.info.id, "b", 0, 1000).ok).toBe(false);
      expect(manager.kill(started.info.id, "b").ok).toBe(false);
      expect(manager.list("b")).toEqual([]);
      expect(manager.list("a").length).toBe(1);
    } finally {
      manager.killAll();
    }
  });

  it("kill 终止长任务，状态立即变为已结束", async () => {
    const manager = new BackgroundTaskManager();
    try {
      const started = manager.start({
        sessionId: "s2",
        command: "node -e <bg>",
        profile: "node",
        cwd: process.cwd(),
        spec: nodeSpec("setTimeout(() => {}, 60000)"),
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      await wait(150);
      expect(started.info.running).toBe(true);
      const killed = manager.kill(started.info.id, "s2");
      expect(killed.ok).toBe(true);
      expect(manager.list("s2")[0].running).toBe(false);
    } finally {
      manager.killAll();
    }
  });
});

describe("后台终端工具", () => {
  it("terminal_background → terminal_output → terminal_tasks 闭环", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-bg-tool-"));
    const manager = new BackgroundTaskManager();
    const registry = new ToolRegistry();
    registerBackgroundTerminalTools(registry, manager, () => root);
    try {
      const start = await registry.get("terminal_background")!.execute({
        agentId: "t",
        sessionId: "s",
        params: { command: 'console.log("bg-ok")', profile: "node" },
        platform: {},
      });
      expect(start.ok).toBe(true);
      expect(start.content).toContain("后台任务");
      const id = /\[后台任务 ([^\]]+)\]/.exec(start.content)?.[1] ?? "";
      expect(id).toMatch(/^bg-/);

      await wait(500);
      const output = await registry.get("terminal_output")!.execute({
        agentId: "t",
        sessionId: "s",
        params: { id },
        platform: {},
      });
      expect(output.ok).toBe(true);
      expect(output.content).toContain("bg-ok");

      const tasks = await registry.get("terminal_tasks")!.execute({ agentId: "t", sessionId: "s", params: {}, platform: {} });
      expect(tasks.ok).toBe(true);
      expect(tasks.content).toContain(id);
    } finally {
      manager.killAll();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 20_000);

  it("拒绝越界 cwd 与危险命令", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-bg-deny-"));
    const manager = new BackgroundTaskManager();
    const registry = new ToolRegistry();
    registerBackgroundTerminalTools(registry, manager, () => root);
    try {
      const escape = await registry.get("terminal_background")!.execute({
        agentId: "t",
        sessionId: "s",
        params: { command: "echo x", cwd: "../..", profile: "node" },
        platform: {},
      });
      expect(escape.ok).toBe(false);

      const dangerous = await registry.get("terminal_background")!.execute({
        agentId: "t",
        sessionId: "s",
        params: { command: "rm -rf /", profile: "node" },
        platform: {},
      });
      expect(dangerous.ok).toBe(false);
      expect(dangerous.content).toContain("拦截");
    } finally {
      manager.killAll();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 20_000);
});
