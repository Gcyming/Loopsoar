/**
 * MemoryStore.add 的返回值必须指向本次写入真实落点的条目。
 * 旧实现去重/合并命中时回退到「最后一条」，设置页随后用错 id 做更新/删除，
 * 会把一条完全无关的记忆改掉（自动记忆候选标题覆盖首条的事故形态）。
 */
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../packages/core/src/memory/store.ts";

describe("MemoryStore.add", () => {
  it("合并命中 → 返回被保留（mergeInto）的条目，而不是最后一条", () => {
    const store = new MemoryStore();
    const first = store.add({ content: "记忆系统写入前必须先去重检查", category: "insight" });
    const unrelated = store.add({ content: "部署流程需要先运行契约检查", category: "lesson" });
    const merged = store.add({ content: "记忆系统写入前必须先去重", category: "insight" });

    expect(merged.id).toBe(first.id);
    expect(merged.id).not.toBe(unrelated.id);
    expect(store.list()).toHaveLength(2);
    // 合并写入确实落到了 first 上（不是只返回了 id）
    expect(store.get(first.id)?.content).toContain("去重");
  });

  it("完全重复 → 返回命中的原条目", () => {
    const store = new MemoryStore();
    const first = store.add({ content: "用户偏好深色主题", category: "preference" });
    const duplicate = store.add({ content: "用户偏好深色主题", category: "preference" });
    expect(duplicate.id).toBe(first.id);
    expect(store.list()).toHaveLength(1);
  });
});
