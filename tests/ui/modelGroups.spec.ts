/**
 * 模型菜单分组：跨供应商展示、活动置顶、展示开关打开的全部模型（没有「默认模型」概念；拨片开关控制是否显示）。
 */
import { describe, expect, it } from "vitest";
import { buildModelGroups, openCodePlanLabel } from "../../packages/ui/src/modelGroups.ts";
import type { ProviderItem } from "../../packages/ui/src/types.js";

const items: ProviderItem[] = [
  {
    id: "deepseek",
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    models: [
      { id: "deepseek-chat", thinking: true },
      { id: "deepseek-reasoner", selected: false },
    ],
  },
  {
    id: "opencode-go",
    provider: "opencode-go",
    baseUrl: "https://opencode.ai/inference/go/openai/v1",
    model: "glm-5.3",
    models: [
      { id: "glm-5.3", selected: true },
      { id: "kimi-k3", selected: true, vision: true },
      { id: "beam-free", selected: false },
    ],
  },
];

describe("模型菜单分组", () => {
  it("展示全部供应商，活动供应商置顶", () => {
    const groups = buildModelGroups(items, "opencode-go");
    expect(groups.map((group) => group.providerId)).toEqual(["opencode-go", "deepseek"]);
    expect(groups[0].active).toBe(true);
  });

  it("只展示开关打开的模型（selected:false 隐藏），按配置顺序、不重复", () => {
    const groups = buildModelGroups(items, "deepseek");
    const deepseek = groups.find((group) => group.providerId === "deepseek")!;
    expect(deepseek.models.map((model) => model.id)).toEqual(["deepseek-chat"]);
    const opencode = groups.find((group) => group.providerId === "opencode-go")!;
    expect(opencode.models.map((model) => model.id)).toEqual(["glm-5.3", "kimi-k3"]);
    expect(opencode.models.find((model) => model.id === "kimi-k3")?.vision).toBe(true);
  });

  it("供应商还没有模型清单时至少展示当前模型", () => {
    const groups = buildModelGroups([{ id: "x", provider: "x", baseUrl: "https://x.test/v1", model: "m1" }], null);
    expect(groups[0].models.map((model) => model.id)).toEqual(["m1"]);
  });

  it("空模型 id 被过滤，模型 id 去重", () => {
    const groups = buildModelGroups(
      [
        {
          id: "p",
          provider: "p",
          baseUrl: "https://p.test/v1",
          model: "a",
          models: [{ id: "a" }, { id: " " }, { id: "a", vision: true }, { id: "b" }],
        },
      ],
      "p",
    );
    expect(groups[0].models.map((model) => model.id)).toEqual(["a", "b"]);
  });
});

describe("OpenCode 计划标记（Go 订阅额度 / 按量付费余额）", () => {
  it("按端点识别计划，其他供应商为 null", () => {
    expect(openCodePlanLabel("https://opencode.ai/inference/go/openai/v1")).toBe("go");
    expect(openCodePlanLabel("https://opencode.ai/inference/openai/v1")).toBe("payg");
    expect(openCodePlanLabel("https://api.deepseek.com/v1")).toBeNull();
  });

  it("模型菜单分组带 plan 标记（同名模型也不会混计划）", () => {
    const groups = buildModelGroups(items, "opencode-go");
    expect(groups.find((group) => group.providerId === "opencode-go")?.plan).toBe("go");
    expect(groups.find((group) => group.providerId === "deepseek")?.plan).toBeNull();
  });
});
