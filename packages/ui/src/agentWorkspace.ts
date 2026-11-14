/**
 * Agent 工作区（折叠标签组）的纯逻辑：把同一份标签列表拆成「用户标签」与「Agent 绑定标签」。
 *
 * 为什么单独成模块：App 只做渲染与副作用，分组规则要能被单测直接钉住
 * （顺序不能变——标签条的视觉顺序必须和宿主 listTabs 的顺序一致，
 * 否则用户点第 N 个标签看到的却是另一页）。
 */
import type { TabState } from "./types.js";

export interface SplitAgentTabsResult {
  /** 普通标签：用户自己打开/导航的标签，原顺序不变。 */
  user: TabState[];
  /** Agent 工作区标签：Agent 打开或导航过的标签，原顺序不变。 */
  bound: TabState[];
}

/**
 * 按 agentBound 分组，两边都保持原列表顺序。
 * 用 === true 判断：老版本宿主/持久化数据里没有这个字段，缺省必须落在「用户标签」而不是折叠组。
 */
export function splitAgentTabs(tabs: TabState[]): SplitAgentTabsResult {
  const user: TabState[] = [];
  const bound: TabState[] = [];
  for (const tab of tabs) {
    if (tab.agentBound === true) bound.push(tab);
    else user.push(tab);
  }
  return { user, bound };
}
