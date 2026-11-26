/**
 * 供应商能力信息（模型模态 / 函数调用 / 结构化输出 / 上下文）UI 守卫。
 *
 * 背景：用户要求「全面完善供应商那端的信息（上下文/输出/是否支持图片/等等）」；
 * Lead 已在 core/contracts/类型层补全 ProviderModel 字段并自动推断，这里守卫 UI 侧：
 *   1. 设置面板模型表格读取并展示/编辑 inputModalities / functionCalling / structuredOutput；
 *   2. 模态输入的归一化、可读徽标、三态映射、上下文窗口紧凑格式化等纯函数行为；
 *   3. 模型选择弹层会把上下文窗口与图片输入能力作为紧凑提示（modelGroups 数据也透传模态）；
 *   4. i18n zh/en 两套文案齐全；表格列/控件带稳定的 data-testid，便于 E2E 断言。
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildModelGroups,
  formatContextWindow,
  formatModalities,
  mergeFetchedProviderModels,
  modalitiesToInput,
  parseModalitiesInput,
  supportsImageInput,
  triStateToValue,
  valueToTriState,
  type InputModality,
  type ProviderCapabilityMeta,
} from "../../packages/ui/src/modelGroups.ts";
import { SETTINGS_I18N } from "../../packages/ui/src/i18nSettings.ts";
import { t } from "../../packages/ui/src/i18n.ts";
import type { ProviderItem, ProviderModel } from "../../packages/ui/src/types.js";

const ROOT = process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** 设置面板的翻译函数（直接从合并后的主词典取，验证 key 确实可用）。 */
const trZh = (key: string): string => t("zh-CN", key);

describe("设置面板：模型能力列（输入模态 / 函数调用 / 结构化输出）", () => {
  const settings = read("packages/ui/src/Settings.tsx");

  it("读取并渲染三个新字段", () => {
    expect(settings).toContain("inputModalities");
    expect(settings).toContain("functionCalling");
    expect(settings).toContain("structuredOutput");
    // 表头 i18n key
    expect(settings).toContain('tr("settings.providers.col.modalities")');
    expect(settings).toContain('tr("settings.providers.col.functionCalling")');
    expect(settings).toContain('tr("settings.providers.col.structuredOutput")');
    // 可编辑：模态走归一化输入，三态走 select 映射
    expect(settings).toContain("parseModalitiesInput(");
    expect(settings).toContain("modalitiesToInput(");
    expect(settings).toContain("triStateToValue(");
    expect(settings).toContain("valueToTriState(");
  });

  it("提供稳定 data-testid 选择器（E2E 断言用）", () => {
    for (const id of [
      "col-input-modalities",
      "col-function-calling",
      "col-structured-output",
      "model-cap-modalities",
      "model-cap-function-calling",
      "model-cap-structured-output",
    ]) {
      expect(settings, `缺少 data-testid="${id}"`).toContain(`data-testid="${id}"`);
    }
  });

  it("ProviderModel 类型层包含三个能力字段（Lead 契约同步）", () => {
    const types = read("packages/ui/src/types.d.ts");
    expect(types).toContain("inputModalities?:");
    expect(types).toContain("functionCalling?:");
    expect(types).toContain("structuredOutput?:");
  });
});

describe("纯函数：模态归一化与徽标格式化", () => {
  it("parseModalitiesInput：逗号（中英文）/空格分隔、大小写、去重、过滤非法值", () => {
    expect(parseModalitiesInput("text, image, TEXT, bogus, audio")).toEqual(["text", "image", "audio"]);
    expect(parseModalitiesInput("，图片，video")).toEqual(["video"]);
    expect(parseModalitiesInput("")).toEqual([]);
    expect(parseModalitiesInput("text text text")).toEqual(["text"]);
  });

  it("modalitiesToInput：数组回到逗号输入框文本（固定顺序）", () => {
    expect(modalitiesToInput(["image", "text"])).toBe("text,image");
    expect(modalitiesToInput(undefined)).toBe("");
    expect(modalitiesToInput(["audio", "image", "video", "text"])).toBe("text,image,audio,video");
  });

  it("formatModalities：可读徽标文本，空值显示占位", () => {
    const label = (modality: string): string => `[${modality}]`;
    expect(formatModalities(["image", "text"], label)).toBe("[settings.providers.modality.text]/[settings.providers.modality.image]");
    expect(formatModalities(["video"], trZh)).toBe("视频");
    expect(formatModalities([], trZh)).toBe("—");
    expect(formatModalities(undefined, trZh)).toBe("—");
  });

  it("三态布尔与 select value 互转", () => {
    expect(triStateToValue(undefined)).toBe("");
    expect(triStateToValue(true)).toBe("true");
    expect(triStateToValue(false)).toBe("false");
    expect(valueToTriState("")).toBeUndefined();
    expect(valueToTriState("true")).toBe(true);
    expect(valueToTriState("false")).toBe(false);
    expect(valueToTriState("garbage")).toBeUndefined();
  });
});

describe("纯函数：上下文窗口格式化与图片输入判定", () => {
  it("formatContextWindow：1M / K / 原值", () => {
    expect(formatContextWindow(1_000_000)).toBe("1M");
    expect(formatContextWindow(2_000_000)).toBe("2M");
    expect(formatContextWindow(131_072)).toBe("131K");
    expect(formatContextWindow(8192)).toBe("8K");
    expect(formatContextWindow(512)).toBe("512");
    expect(formatContextWindow(undefined)).toBeUndefined();
    expect(formatContextWindow(0)).toBeUndefined();
  });

  it("supportsImageInput：vision 或 inputModalities 含 image", () => {
    expect(supportsImageInput(true, undefined)).toBe(true);
    expect(supportsImageInput(undefined, ["text", "image"])).toBe(true);
    expect(supportsImageInput(false, ["text"])).toBe(false);
    expect(supportsImageInput(undefined, undefined)).toBe(false);
  });
});

describe("模型菜单：模态透传与紧凑能力提示", () => {
  it("buildModelGroups 透传 inputModalities（模型能力随清单原样带出）", () => {
    const items: ProviderItem[] = [
      {
        id: "nvidia",
        provider: "nvidia",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        model: "meta/llama-3.2-90b-vision-instruct",
        models: [
          {
            id: "meta/llama-3.2-90b-vision-instruct",
            selected: true,
            contextWindow: 131072,
            inputModalities: ["text", "image"] satisfies InputModality[],
          },
        ],
      },
    ];
    const groups = buildModelGroups(items, "nvidia");
    const choice = groups[0]?.models.find((model) => model.id === items[0].model);
    expect(choice?.contextWindow).toBe(131072);
    expect(choice?.inputModalities).toEqual(["text", "image"]);
    expect(formatContextWindow(choice?.contextWindow)).toBe("131K");
    expect(supportsImageInput(choice?.vision, choice?.inputModalities)).toBe(true);
  });

  it("Composer 模型菜单渲染上下文提示与图片徽标（只在有值时）", () => {
    const composer = read("packages/ui/src/Composer.tsx");
    expect(composer).toContain("formatContextWindow(model.contextWindow)");
    expect(composer).toContain("supportsImageInput(model.vision, model.inputModalities)");
    expect(composer).toContain('tr("composer.modelBadge.image")');
    expect(composer).toContain("modelHint");
  });
});

describe("i18n：能力相关文案 zh/en 齐全", () => {
  const required = [
    "settings.providers.col.modalities",
    "settings.providers.col.functionCalling",
    "settings.providers.col.structuredOutput",
    "settings.providers.modality.text",
    "settings.providers.modality.image",
    "settings.providers.modality.audio",
    "settings.providers.modality.video",
    "settings.providers.modalitiesPlaceholder",
    "settings.providers.capAuto",
    "settings.providers.capSupported",
    "settings.providers.capUnsupported",
  ];

  it("SETTINGS_I18N 中每个 key 的中英文都非空", () => {
    for (const key of required) {
      const entry = SETTINGS_I18N[key];
      expect(entry, `i18nSettings.ts 缺少 ${key}`).toBeTruthy();
      expect(entry.zh.trim().length, `${key} 缺中文`).toBeGreaterThan(0);
      expect(entry.en.trim().length, `${key} 缺英文`).toBeGreaterThan(0);
    }
  });

  it("合并进主词典后可实际翻译（含模型菜单图片徽标）", () => {
    expect(trZh("settings.providers.col.modalities")).toBe("输入模态");
    expect(trZh("settings.providers.capSupported")).toBe("支持");
    expect(trZh("settings.providers.capUnsupported")).toBe("不支持");
    expect(t("en-US", "settings.providers.col.modalities")).toBe("Input modalities");
    expect(trZh("composer.modelBadge.image")).toBe("图");
    expect(t("en-US", "composer.modelBadge.image")).toBe("IMG");
  });
});

describe("mergeFetchedProviderModels（拉列表时的三态合并：显式手填 > 上游实时 > 内置推断）", () => {
  const model = (patch: Partial<ProviderModel> & { id: string }): ProviderModel => patch as ProviderModel;
  const meta = (patch: ProviderCapabilityMeta): Record<string, ProviderCapabilityMeta> => ({ m1: patch });

  it("旧值来自内置推断时，上游新值会刷新掉它", () => {
    const existing = [model({ id: "m1", contextWindow: 512000, maxOutput: 65536, selected: true })];
    const fetched = [model({ id: "m1", contextWindow: 1048576, maxOutput: 8192 })];
    const result = mergeFetchedProviderModels(
      fetched,
      existing,
      meta({ upstreamFields: ["contextWindow", "maxOutput"], inferredCaps: { contextWindow: 512000, maxOutput: 65536 } }),
    );
    expect(result.models[0].contextWindow).toBe(1048576);
    expect(result.models[0].maxOutput).toBe(8192);
    expect(result.upstreamModels).toBe(1);
    expect(result.models[0].selected).toBe(true);
  });

  it("用户显式手填的值不会被上游刷新覆盖", () => {
    const existing = [model({ id: "m1", contextWindow: 200000, selected: true })];
    const fetched = [model({ id: "m1", contextWindow: 1048576 })];
    const result = mergeFetchedProviderModels(
      fetched,
      existing,
      meta({ upstreamFields: ["contextWindow"], inferredCaps: { contextWindow: 512000 } }),
    );
    expect(result.models[0].contextWindow).toBe(200000);
  });

  it("上游没有能力数据时保留内置推断值，并给出补全计数", () => {
    const existing = [model({ id: "m1", contextWindow: 512000 })];
    const fetched = [model({ id: "m1", contextWindow: 512000 })];
    const result = mergeFetchedProviderModels(fetched, existing, meta({ upstreamFields: [], inferredCaps: { contextWindow: 512000 } }));
    expect(result.models[0].contextWindow).toBe(512000);
    expect(result.upstreamModels).toBe(0);
    expect(result.enrichedModels).toBe(1);
  });

  it("拉列表时本地开关保留，新模型默认打开（拨片开关语义）", () => {
    const existing = [model({ id: "a", selected: false })];
    const fetched = [model({ id: "a" }), model({ id: "b" })];
    const result = mergeFetchedProviderModels(fetched, existing, {});
    expect(result.models.find((m) => m.id === "a")?.selected).toBe(false);
    expect(result.models.find((m) => m.id === "b")?.selected).toBe(true);
  });

  it("上游列表没有的本地手工模型必须保留（不能因刷新而丢失配置）", () => {
    const existing = [model({ id: "m1", contextWindow: 200000, selected: true }), model({ id: "local-only", maxOutput: 8192, selected: false })];
    const fetched = [model({ id: "m1", contextWindow: 1048576 })];
    const result = mergeFetchedProviderModels(fetched, existing, {});
    expect(result.models.map((m) => m.id)).toEqual(["m1", "local-only"]);
    expect(result.models.find((m) => m.id === "local-only")?.maxOutput).toBe(8192);
    expect(result.models.find((m) => m.id === "local-only")?.selected).toBe(false);
  });

  it("按模型 id 去重，并只统计真正带上游字段的模型", () => {
    const fetched = [model({ id: "m1", vision: false }), model({ id: "m1" }), model({ id: "m2", contextWindow: 128000 })];
    const result = mergeFetchedProviderModels(
      fetched,
      [],
      { m1: { upstreamFields: ["vision"], inferredCaps: {} }, m2: { upstreamFields: [], inferredCaps: {} } },
    );
    expect(result.models.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(result.upstreamModels).toBe(1);
  });
});
