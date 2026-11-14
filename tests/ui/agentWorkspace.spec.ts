/**
 * Agent 工作区分组（Slice H）：把标签列表拆成「用户标签 / Agent 绑定标签」。
 * 关键约束是顺序——标签条与折叠列表都必须保持宿主 listTabs 的顺序，
 * 否则用户点第 N 项看到的却是另一个页面。
 */
import { describe, expect, it } from "vitest";
import { splitAgentTabs } from "../../packages/ui/src/agentWorkspace.ts";
import type { TabState } from "../../packages/ui/src/types.js";

function tab(id: string, agentBound?: boolean): TabState {
  return {
    id,
    url: `https://${id}.example/`,
    title: id,
    active: false,
    canBack: false,
    canForward: false,
    ...(agentBound === undefined ? {} : { agentBound }),
  };
}

describe("splitAgentTabs", () => {
  it("空数组：两组都为空", () => {
    expect(splitAgentTabs([])).toEqual({ user: [], bound: [] });
  });

  it("混合顺序：按 agentBound 分组，组内保持原顺序", () => {
    const tabs = [tab("a", true), tab("b"), tab("c", true), tab("d")];
    const { user, bound } = splitAgentTabs(tabs);
    expect(user.map((t) => t.id)).toEqual(["b", "d"]);
    expect(bound.map((t) => t.id)).toEqual(["a", "c"]);
    // 分组不复制/不改写对象：UI 仍拿到同一批标签
    expect(user[0]).toBe(tabs[1]);
    expect(bound[1]).toBe(tabs[2]);
  });

  it("全部 bound：用户标签为空，折叠组保持原顺序", () => {
    const tabs = [tab("a", true), tab("b", true), tab("c", true)];
    const { user, bound } = splitAgentTabs(tabs);
    expect(user).toEqual([]);
    expect(bound.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("缺省 agentBound（老宿主/老持久化数据）：落到用户标签，不进折叠组", () => {
    const { user, bound } = splitAgentTabs([tab("a"), tab("b")]);
    expect(user.map((t) => t.id)).toEqual(["a", "b"]);
    expect(bound).toEqual([]);
  });
});
