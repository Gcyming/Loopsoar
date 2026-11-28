import { describe, expect, it } from "vitest";
import { CLOSED_TAB_LIMIT, ClosedTabStack } from "../../packages/shell/src/main/closedTabStack.js";

const entry = (n: number) => ({ url: `https://example.com/${n}`, title: `T${n}`, sessionId: "__user_tabs__" });

describe("ClosedTabStack：最近关闭", () => {
  it("倒序读取：最新关闭的排第一", () => {
    const stack = new ClosedTabStack();
    stack.pushEntry(entry(1), 1000);
    stack.pushEntry(entry(2), 2000);
    expect(stack.list().map((item) => item.title)).toEqual(["T2", "T1"]);
    expect(stack.list()[0].closedAt).toBe(2000);
  });

  it("上限 40：超出丢弃最旧的，且只影响这份记录", () => {
    const stack = new ClosedTabStack();
    for (let i = 1; i <= CLOSED_TAB_LIMIT + 5; i += 1) stack.pushEntry(entry(i), i);
    expect(CLOSED_TAB_LIMIT).toBe(40);
    expect(stack.size).toBe(40);
    expect(stack.list()[0].title).toBe(`T${CLOSED_TAB_LIMIT + 5}`);
    expect(stack.list()[39].title).toBe("T6");
  });

  it("take(index)：0 = 最新，取出后从列表移除", () => {
    const stack = new ClosedTabStack();
    stack.pushEntry(entry(1), 1);
    stack.pushEntry(entry(2), 2);
    expect(stack.take(1)?.title).toBe("T1");
    expect(stack.list().map((item) => item.title)).toEqual(["T2"]);
    expect(stack.take(5)).toBeUndefined();
  });

  it("restore()：只留合法条目并按上限截断", () => {
    const stack = new ClosedTabStack();
    const raw = [
      { url: "https://a.example", title: "A", sessionId: "s1", closedAt: 1, agentBound: true },
      { url: "", title: "坏数据" },
      { url: "https://b.example", title: "B", closedAt: 2 },
    ];
    stack.restore(raw);
    const list = stack.list();
    expect(list.map((item) => item.title)).toEqual(["B", "A"]);
    expect(list[1].agentBound).toBe(true);
  });

  it("每次压栈/取出都会回调导出状态（供落盘）", () => {
    const saved: number[] = [];
    const stack = new ClosedTabStack((entries) => saved.push(entries.length));
    stack.pushEntry(entry(1), 1);
    stack.take(0);
    expect(saved).toEqual([1, 0]);
  });
});
