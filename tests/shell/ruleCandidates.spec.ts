/**
 * 规则候选：去重/证据累积/采纳写入项目 AGENTS.md/全局 learned-rules.md。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { __resetHandlerRegistryForTests } from "../../packages/shell/src/main/trustedIpc.ts";
import { RuleCandidateStore } from "../../packages/shell/src/main/ruleCandidates.ts";
import { RuleHistoryStore } from "../../packages/shell/src/main/ruleHistory.ts";
import { registerRuleLearningDomain } from "../../packages/shell/src/main/domains/ruleLearning.ts";
import { currentRulesPrompt, registerSettingsDomain, type SettingsDeps } from "../../packages/shell/src/main/domains/settings.ts";

const TRUSTED = { senderFrame: { url: "loopsoar://app/index.html" } };

let root: string;
let handlers: Map<string, (event: unknown, payload: unknown) => Promise<unknown>>;
let store: RuleCandidateStore;
let history: RuleHistoryStore;
let settingsDeps: SettingsDeps;
let dataDir: string;
let wsA: string;
let wsB: string;

async function invoke(channel: string, payload?: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error("未注册 handler：" + channel);
  return handler(TRUSTED, payload);
}

beforeEach(() => {
  __resetHandlerRegistryForTests();
  root = mkdtempSync(path.join(tmpdir(), "loopsoar-rules-"));
  dataDir = path.join(root, "data");
  const configDir = path.join(dataDir, "config");
  mkdirSync(configDir, { recursive: true });
  wsA = path.join(root, "proj-a");
  wsB = path.join(root, "proj-b");
  mkdirSync(wsA, { recursive: true });
  mkdirSync(wsB, { recursive: true });
  const workspaces = {
    list: () => [
      { id: "a", name: "项目 A", root: wsA },
      { id: "b", name: "项目 B", root: wsB },
    ],
    activeId: () => "a",
  };
  handlers = new Map();
  const ipc = {
    handle: (channel: string, fn: unknown) => {
      handlers.set(channel.replace(/^loopsoar:/, ""), fn as never);
    },
  };
  const deps = {
    ipc,
    audit: () => {},
    dataDir,
    store: undefined as unknown as RuleCandidateStore,
    history: undefined as unknown as RuleHistoryStore,
    workspaces,
    sessions: {
      currentId: () => "s1",
      get: () => ({ sessionId: "s1", workspaceId: "a", messages: [] }),
      loadMessages: () => [
        { role: "user", text: "必须用 pnpm 安装依赖。", ts: 1 },
        { role: "assistant", text: "好", ts: 2 },
      ],
    } as never,
    push: () => {},
  };
  store = new RuleCandidateStore(path.join(dataDir, "rules", "candidates.json"));
  history = new RuleHistoryStore(path.join(dataDir, "rules", "history.json"));
  deps.store = store;
  deps.history = history;
  settingsDeps = {
    ipc,
    audit: () => {},
    platform: {} as never,
    dataDir,
    configDir,
    workspaceRoot: wsA,
    env: {},
    appVersion: "9.9.9-test",
    workspaces,
  } as SettingsDeps;
  registerSettingsDomain(settingsDeps);
  registerRuleLearningDomain(deps);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("规则候选：从对话里学习但不自动改写", () => {
  it("同一工作区同一条约束只累加证据，不重复建条目", () => {
    expect(store.observe({ sessionId: "s1", workspaceId: "a", message: "以后只能使用 pnpm，不要再用 npm。" }).added).toBe(2);
    const again = store.observe({ sessionId: "s1", workspaceId: "a", message: "记住：只能使用 pnpm。" });
    expect(again.added).toBe(0);
    expect(again.repeated).toBe(1);
    const pnpm = store.list("a").find((c) => c.text.includes("pnpm"));
    expect(pnpm?.seenCount).toBe(2);
    expect(pnpm?.status).toBe("pending");
    // 还没采纳 → 不进入规则文件
    expect(existsSync(path.join(wsA, "AGENTS.md"))).toBe(false);
  });

  it("工具失败后的纠正句 → 候选并带证据", () => {
    const result = store.observe({
      sessionId: "s1",
      workspaceId: "a",
      message: "不对，应该用 pnpm 安装依赖。",
      evidence: [{ toolName: "shell", error: "npm ERR! missing script", at: 1 }],
    });
    expect(result.added).toBe(1);
    const candidate = store.list("a").find((c) => c.text.includes("pnpm"))!;
    expect(candidate.strength).toBe("should");
    expect(candidate.text).toContain("pnpm 安装依赖");
    expect(candidate.evidence?.[0]).toMatchObject({ toolName: "shell", error: "npm ERR! missing script" });
  });

  it("不同工作区各自独立", () => {
    store.observe({ sessionId: "s1", workspaceId: "a", message: "这个项目必须用 pnpm。" });
    store.observe({ sessionId: "s2", workspaceId: "b", message: "这个项目必须用 npm。" });
    expect(store.list("a").filter((c) => c.status === "pending")).toHaveLength(1);
    expect(store.list("b").filter((c) => c.status === "pending")).toHaveLength(1);
  });

  it("采纳 → 追加到项目 AGENTS.md，下一轮 prompt 立即包含", async () => {
    store.observe({ sessionId: "s1", workspaceId: "a", message: "以后只能使用 pnpm 管理依赖。" });
    const candidate = store.list("a").find((c) => c.status === "pending")!;
    const result = (await invoke("rules:acceptCandidate", { id: candidate.id })) as { written: boolean; path: string };
    expect(result.written).toBe(true);
    expect(result.path).toBe(path.join(wsA, "AGENTS.md"));
    expect(readFileSync(result.path, "utf8")).toContain("- 只能使用 pnpm 管理依赖");
    expect(currentRulesPrompt(settingsDeps, "a")).toContain("只能使用 pnpm 管理依赖");
    expect(store.get(candidate.id)?.status).toBe("accepted");
    await expect(invoke("rules:acceptCandidate", { id: candidate.id })).rejects.toThrow(/已处理/);
  });

  it("采纳前可改写文本，并可选择全局目标", async () => {
    store.observe({ sessionId: "s1", workspaceId: "a", message: "必须用 pnpm 安装依赖。" });
    const candidate = store.list("a").find((c) => c.status === "pending")!;
    const originalKey = candidate.key;
    const result = (await invoke("rules:acceptCandidate", {
      id: candidate.id,
      target: "global",
      text: "只能使用 pnpm 安装依赖",
    })) as { path: string; candidate: { text: string; key: string } };
    expect(result.path).toContain(path.join("rules", "learned-rules.md"));
    expect(readFileSync(result.path, "utf8")).toContain("- 只能使用 pnpm 安装依赖");
    expect(result.candidate.text).toBe("只能使用 pnpm 安装依赖");
    expect(result.candidate.key).not.toBe(originalKey);
    expect(existsSync(path.join(wsA, "AGENTS.md"))).toBe(false);
  });

  it("从本会话回顾可以补出候选", async () => {
    const result = (await invoke("rules:learnFromSession")) as { scanned: number; added: number; repeated: number };
    expect(result.scanned).toBe(1);
    expect(result.added).toBe(1);
    expect(store.list("a").some((c) => c.text.includes("pnpm"))).toBe(true);
  });

  it("过短的改写文本被拒绝", async () => {
    store.observe({ sessionId: "s1", workspaceId: "a", message: "必须用 pnpm。" });
    const candidate = store.list("a").find((c) => c.status === "pending")!;
    await expect(invoke("rules:acceptCandidate", { id: candidate.id, text: "x" })).rejects.toThrow(/参数校验失败/);
  });

  it("所有项目的约束采纳到全局 learned-rules.md", async () => {
    store.observe({ sessionId: "s1", workspaceId: "a", message: "所有项目都必须加中文注释。" });
    const candidate = store.list("a").find((c) => c.text.includes("中文注释"))!;
    const result = (await invoke("rules:acceptCandidate", { id: candidate.id })) as { path: string };
    expect(result.path).toContain(path.join("rules", "learned-rules.md"));
    expect(currentRulesPrompt(settingsDeps, "a")).toContain("所有项目都必须加中文注释");
    expect(currentRulesPrompt(settingsDeps, "b")).toContain("所有项目都必须加中文注释");
  });

  it("忽略后不再出现在待确认列表（状态保留可追溯）", async () => {
    store.observe({ sessionId: "s1", workspaceId: "a", message: "必须用 pnpm。" });
    const candidate = store.list("a")[0];
    await invoke("rules:dismissCandidate", { id: candidate.id });
    expect(store.get(candidate.id)?.status).toBe("dismissed");
    expect(store.list("a").filter((c) => c.status === "pending")).toHaveLength(0);
  });

  it("采纳记录历史，回滚恢复文件", async () => {
    store.observe({ sessionId: "s1", workspaceId: "a", message: "必须用 pnpm 安装依赖。" });
    const candidate = store.list("a").find((c) => c.status === "pending")!;
    await invoke("rules:acceptCandidate", { id: candidate.id });
    const file = path.join(wsA, "AGENTS.md");
    expect(readFileSync(file, "utf8")).toContain("必须用 pnpm 安装依赖");
    const listed = (await invoke("rules:history")) as { revisions: { id: string; action: string }[] };
    const accepted = listed.revisions.find((revision) => revision.action === "accept")!;
    expect(accepted).toBeTruthy();
    const rolled = (await invoke("rules:rollback", { id: accepted.id })) as { restored: number };
    expect(rolled.restored).toBe(1);
    expect(readFileSync(file, "utf8")).not.toContain("必须用 pnpm 安装依赖");
    const after = (await invoke("rules:history")) as { revisions: { action: string }[] };
    expect(after.revisions[0].action).toBe("rollback");
  });

  it("历史里出现非规则路径 → 拒绝回滚", async () => {
    const revision = history.add({
      action: "save",
      summary: "tampered",
      files: [{ path: "C:/Windows/System32/drivers/etc/hosts", before: "x", after: "y" }],
    });
    await expect(invoke("rules:rollback", { id: revision.id })).rejects.toThrow(/非规则路径/);
  });

  it("未知 id → 拒绝", async () => {
    await expect(invoke("rules:acceptCandidate", { id: "rc-missing" })).rejects.toThrow(/不存在/);
    await expect(invoke("rules:dismissCandidate", { id: "rc-missing" })).rejects.toThrow(/不存在/);
  });
});
