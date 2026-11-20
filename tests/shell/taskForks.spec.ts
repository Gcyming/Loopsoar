/**
 * 任务分支状态机（taskForks.ts）。
 *
 * 为什么单独测：这套逻辑原先藏在 index.ts 的启动闭包里（没有任何直接单测），
 * 只能靠 E2E 兜着。它决定「任务身份归谁」「崩溃后能否续做」，错一次就是
 * 用户看到两个任务会话、或任务页被写回普通会话。抽出来后用假件把四条不变量钉死。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskForkCoordinator, type ForkSessionStore } from "../../packages/shell/src/main/taskForks.ts";

const dirs: string[] = [];
function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-fork-"));
  dirs.push(dir);
  return path.join(dir, "pending-task-forks.json");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface FakeSession {
  sessionId: string;
  messages: number[];
  isTask: boolean;
  browserState?: { tabs: { url: string; agentBound?: boolean }[]; activeIndex: number };
}

function fakeSessions(seed: FakeSession[]) {
  const store = new Map(seed.map((item) => [item.sessionId, { ...item }]));
  let seq = 0;
  const api: ForkSessionStore & { store: Map<string, FakeSession> } = {
    store,
    get: (id) => store.get(id) ?? null,
    isTask: (id) => store.get(id)?.isTask === true,
    setTask: (id, task) => {
      const item = store.get(id);
      if (item) item.isTask = task;
    },
    fork: (sourceId, keep) => {
      const source = store.get(sourceId);
      if (!source) return null;
      seq += 1;
      const sessionId = `${sourceId}-fork-${seq}`;
      store.set(sessionId, {
        sessionId,
        messages: source.messages.slice(0, keep),
        isTask: false,
      });
      return { sessionId };
    },
    moveTail: (sourceId, targetId, keep) => {
      const source = store.get(sourceId);
      const target = store.get(targetId);
      if (!source || !target) return false;
      const tail = source.messages.slice(keep);
      if (tail.length === 0) return false;
      target.messages.push(...tail);
      source.messages = source.messages.slice(0, keep);
      return true;
    },
    remove: (id) => {
      store.delete(id);
    },
  };
  return api;
}

function fakeStates() {
  const map = new Map<string, { tabs: { url: string; agentBound?: boolean }[]; activeIndex: number }>();
  return {
    map,
    get: (id: string) => map.get(id) ?? null,
    set: (id: string, state: { tabs: { url: string; agentBound?: boolean }[]; activeIndex: number }) => {
      map.set(id, state);
    },
    delete: (id: string) => {
      map.delete(id);
    },
  };
}

describe("任务分支：回合结束才过户", () => {
  it("首次动作只标任务身份，回合结束才 fork 并搬走本轮消息", () => {
    const sessions = fakeSessions([
      { sessionId: "s1", messages: [1, 2, 3], isTask: false },
    ]);
    const states = fakeStates();
    const events: string[] = [];
    const forks = new TaskForkCoordinator({
      sessions,
      browserStates: states,
      file: tempFile(),
      browserHost: () => null,
      push: (event) => events.push(event),
    });

    forks.onTurnStarted("s1");
    forks.markBrowserAction("s1");
    expect(sessions.isTask("s1")).toBe(true); // 动作期间先当任务（折叠页立即出现）

    // 回合结束后本轮用户消息+回复才落库
    sessions.store.get("s1")!.messages.push(4, 5);
    forks.settle("s1");

    const forkId = [...sessions.store.keys()].find((id) => id.startsWith("s1-fork-"));
    expect(forkId).toBeDefined();
    expect(sessions.isTask("s1")).toBe(false);
    expect(sessions.isTask(forkId!)).toBe(true);
    expect(events).toContain("chat:taskForked");
    expect(forks.pendingCount()).toBe(0);
  });

  it("分支点取「本轮开始前」，不会把操作过程复制两份", () => {
    const sessions = fakeSessions([{ sessionId: "s1", messages: [1, 2], isTask: false }]);
    const forks = new TaskForkCoordinator({
      sessions,
      browserStates: fakeStates(),
      file: tempFile(),
      browserHost: () => null,
      push: () => {},
    });

    forks.onTurnStarted("s1"); // keep = 2
    sessions.store.get("s1")!.messages.push(3, 4); // 本轮追加
    forks.markBrowserAction("s1");
    forks.settle("s1");

    const forkId = [...sessions.store.keys()].find((id) => id.startsWith("s1-fork-"))!;
    expect(sessions.store.get("s1")!.messages).toEqual([1, 2]);
    expect(sessions.store.get(forkId)!.messages).toEqual([1, 2, 3, 4]);
  });

  it("回合没有落库（异常）→ 不留「任务但没有分支」的孤儿状态", () => {
    const sessions = fakeSessions([{ sessionId: "s1", messages: [1], isTask: false }]);
    const forks = new TaskForkCoordinator({
      sessions,
      browserStates: fakeStates(),
      file: tempFile(),
      browserHost: () => null,
      push: () => {},
    });

    forks.onTurnStarted("s1");
    forks.markBrowserAction("s1");
    forks.settle("s1"); // 消息数没变 → 没有可搬内容

    expect(sessions.isTask("s1")).toBe(false);
    expect([...sessions.store.keys()]).toEqual(["s1"]);
  });

  it("没有待分支标记时 settle 是 no-op（不会误 fork 普通回合）", () => {
    const sessions = fakeSessions([{ sessionId: "s1", messages: [1, 2, 3], isTask: false }]);
    const forks = new TaskForkCoordinator({
      sessions,
      browserStates: fakeStates(),
      file: tempFile(),
      browserHost: () => null,
      push: () => {},
    });
    forks.settle("s1");
    expect([...sessions.store.keys()]).toEqual(["s1"]);
  });
});

describe("任务分支：崩溃恢复", () => {
  it("上次没来得及 fork 的记录在启动时补完（幂等）", () => {
    const file = tempFile();
    // 模拟崩溃前落盘：动作已发生、回合未结束
    fs.writeFileSync(file, JSON.stringify([{ sourceId: "s1", keep: 1 }]), "utf8");
    const sessions = fakeSessions([{ sessionId: "s1", messages: [1, 2, 3], isTask: true }]);
    const states = fakeStates();
    states.set("s1", { tabs: [{ url: "https://example.com/a", agentBound: true }], activeIndex: 0 });

    const forks = new TaskForkCoordinator({
      sessions,
      browserStates: states,
      file,
      browserHost: () => null,
      push: () => {},
    });

    forks.recover();

    const forkId = [...sessions.store.keys()].find((id) => id.startsWith("s1-fork-"))!;
    expect(forkId).toBeDefined();
    expect(sessions.isTask(forkId)).toBe(true);
    expect(sessions.isTask("s1")).toBe(false);
    // 任务页快照跟着过户，原会话不再留孤儿存档
    expect(states.get(forkId)).not.toBeNull();
    expect(states.get("s1")).toBeNull();

    // 幂等：再跑一遍没有新增
    const before = [...sessions.store.keys()].sort();
    forks.recover();
    expect([...sessions.store.keys()].sort()).toEqual(before);
  });

  it("源会话已不存在 → 记录被清掉，不反复重试", () => {
    const file = tempFile();
    fs.writeFileSync(file, JSON.stringify([{ sourceId: "gone", keep: 0 }]), "utf8");
    const sessions = fakeSessions([]);
    const forks = new TaskForkCoordinator({
      sessions,
      browserStates: fakeStates(),
      file,
      browserHost: () => null,
      push: () => {},
    });

    forks.recover();

    expect(forks.pendingCount()).toBe(0);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual([]);
  });

  it("记录文件损坏 → 当作没有待办，不抛错", () => {
    const file = tempFile();
    fs.writeFileSync(file, "not json", "utf8");
    const sessions = fakeSessions([{ sessionId: "s1", messages: [], isTask: false }]);
    expect(() =>
      new TaskForkCoordinator({
        sessions,
        browserStates: fakeStates(),
        file,
        browserHost: () => null,
        push: () => {},
      }).recover(),
    ).not.toThrow();
  });
});
