/**
 * 时间线纯逻辑：节点合并 / 工作阶段分组 / 规划更新与推进播报 / 工具分类。
 */
import { describe, expect, it } from "vitest";
import {
  appendTimelineStep,
  extractToolDetail,
  foldPlanUpdate,
  formatDurationMs,
  groupTimeline,
  isToolFailure,
  parsePlanItems,
  toolCategoryOf,
  type TimelineStep,
} from "../../packages/ui/src/timeline.ts";

describe("时间线 · 节点累积", () => {
  it("连续 think / body 合并为一段，跨类型保持交错顺序", () => {
    let steps: TimelineStep[] = [];
    steps = appendTimelineStep(steps, { kind: "think", text: "分析" });
    steps = appendTimelineStep(steps, { kind: "think", text: "一下" });
    steps = appendTimelineStep(steps, { kind: "tool", name: "browser_snapshot", label: "browser_snapshot" });
    steps = appendTimelineStep(steps, { kind: "body", text: "结论" });
    steps = appendTimelineStep(steps, { kind: "body", text: "片段" });
    expect(steps.map((s) => s.kind)).toEqual(["think", "tool", "body"]);
    expect((steps[0] as { text: string }).text).toBe("分析一下");
    expect((steps[2] as { text: string }).text).toBe("结论片段");
  });

  it("相同规划去重并就地刷新，状态变化生成推进播报", () => {
    const plan = [
      { id: "1", content: "读取页面", status: "in_progress" as const },
      { id: "2", content: "总结", status: "pending" as const },
    ];
    let steps = foldPlanUpdate([], plan, null);
    expect(steps.filter((s) => s.kind === "plan")).toHaveLength(1);
    expect(steps.filter((s) => s.kind === "todo")).toHaveLength(0);

    const nextPlan = [
      { id: "1", content: "读取页面", status: "completed" as const },
      { id: "2", content: "总结", status: "in_progress" as const },
    ];
    steps = foldPlanUpdate(steps, nextPlan, plan);
    expect(steps.filter((s) => s.kind === "plan")).toHaveLength(1);
    const announcements = steps.filter((s) => s.kind === "todo");
    expect(announcements).toHaveLength(2);
    expect(announcements[0]).toMatchObject({ text: "读取页面", state: "done" });
    expect(announcements[1]).toMatchObject({ text: "总结", state: "start" });
  });
});

describe("时间线 · 工作阶段分组", () => {
  it("新的 think 段开启新一轮，末组被标记 isLast", () => {
    let steps: TimelineStep[] = [];
    steps = appendTimelineStep(steps, { kind: "think", text: "第一阶段" });
    steps = appendTimelineStep(steps, { kind: "tool", name: "browser_snapshot" });
    steps = appendTimelineStep(steps, { kind: "think", text: "第二阶段" });
    steps = appendTimelineStep(steps, { kind: "tool", name: "todo_write" });
    const groups = groupTimeline(steps);
    expect(groups).toHaveLength(2);
    expect(groups[0].headline).toContain("第一阶段");
    expect(groups[0].toolCount).toBe(1);
    expect(groups[1].headline).toContain("第二阶段");
    expect(groups[1].isLast).toBe(true);
  });
});

describe("时间线 · 工具分类与详情", () => {
  it("浏览器/终端/写入分类不同", () => {
    expect(toolCategoryOf("browser_snapshot").category).toBe("网页访问");
    expect(toolCategoryOf("terminal_run").category).toBe("执行命令");
    expect(toolCategoryOf("file_write").category).toBe("写入");
    expect(toolCategoryOf("todo_write").category).toBe("规划");
  });

  it("从参数/结果提取详情，失败前缀可识别", () => {
    expect(extractToolDetail("browser_navigate", { url: "https://example.com" })).toBe("https://example.com");
    expect(extractToolDetail("browser_snapshot", {}, "URL: https://example.com/x")).toBe("https://example.com/x");
    expect(isToolFailure("browser_click", "[错误] 未找到元素")).toBe(true);
    expect(isToolFailure("ext__demo__echo", "扩展 echo: ok")).toBe(false);
  });

  it("todo_write 的 Markdown checklist 可解析", () => {
    const items = parsePlanItems("- [x] 读取页面\n- [ ] 总结 ← 进行中\n- [ ] 输出");
    expect(items.map((i) => i.status)).toEqual(["completed", "in_progress", "pending"]);
  });
});

describe("回复耗时格式化（思考过程卡标题行「用时 1.2s」）", () => {
  it("<1s 用毫秒整数，≥1s 保留一位小数", () => {
    expect(formatDurationMs(420)).toBe("420ms");
    expect(formatDurationMs(999)).toBe("999ms");
    expect(formatDurationMs(1000)).toBe("1.0s");
    expect(formatDurationMs(1234)).toBe("1.2s");
    expect(formatDurationMs(59990)).toBe("60.0s");
  });

  it("缺失/异常值显示占位符，不出现 undefined", () => {
    expect(formatDurationMs(undefined)).toBe("—");
    expect(formatDurationMs(0)).toBe("—");
    expect(formatDurationMs(-5)).toBe("—");
  });
});
