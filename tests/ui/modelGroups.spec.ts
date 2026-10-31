/**
 * 模型菜单分组：跨供应商展示、活动置顶、默认模型必显示、停用模型隐藏。
 */
import { describe, expect, it } from "vitest";
import { buildModelGroups } from "../../packages/ui/src/modelGroups.ts";
import type { ProviderItem } from "../../packages/ui/src/types.js";

const items: ProviderItem[] = [
  {
    id: "deepseek",
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    models: [
      { id: "deepseek-chat", selected: true, thinking: true },
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
    ],
  },
];

describe("模型菜单分组", () => {
  it("展示全部供应商，活动供应商置顶", () => {
    const groups = buildModelGroups(items, "opencode-go");
    expect(groups.map((group) => group.providerId)).toEqual(["opencode-go", "deepseek"]);
    expect(groups[0].active).toBe(true);
  });

  it("默认模型必显示（即使未勾选），停用模型隐藏，模型不重复", () => {
    const groups = buildModelGroups(items, "deepseek");
    const deepseek = groups.find((group) => group.providerId === "deepseek")!;
    expect(deepseek.models.map((model) => model.id)).toEqual(["deepseek-chat"]);
    const opencode = groups.find((group) => group.providerId === "opencode-go")!;
    expect(opencode.models.map((model) => model.id)).toEqual(["glm-5.3", "kimi-k3"]);
    expect(opencode.models.find((model) => model.id === "kimi-k3")?.vision).toBe(true);
  });

  it("无模型清单时也至少返回默认模型", () => {
    const groups = buildModelGroups([{ id: "x", provider: "x", baseUrl: "https://x.test/v1", model: "m1" }], null);
    expect(groups[0].models.map((model) => model.id)).toEqual(["m1"]);
  });
});
