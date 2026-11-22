/**
 * OpenCode 修复的 UI 守卫（源码扫描，无需 jsdom）：
 *   1. 流式错误/中断原因已经在会话消息里展示，不允许再用底部 notice 重复弹一次（会挡内容，用户明确要求删）；
 *   2. 供应商快速预设必须同时提供 Go 订阅端点与按量付费端点（两套 Key/端点不通用，2026-11 官方文档）。
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();
const streamEvents = fs.readFileSync(path.join(ROOT, "packages/ui/src/useChatStreamEvents.ts"), "utf8");
const settings = fs.readFileSync(path.join(ROOT, "packages/ui/src/Settings.tsx"), "utf8");

describe("流式错误不再弹底部提示", () => {
  it("正常完成不再弹「完成」，中断/错误也不重复弹底部提示", () => {
    expect(streamEvents).not.toContain("setNotice(info.statusText)");
    expect(streamEvents).not.toContain('setNotice(wasStopping ? "已停止" : info.statusText)');
    expect(streamEvents).toContain('if (wasStopping) setNotice("已停止")');
  });

  it("chat:stream:error 不再弹「回复失败」", () => {
    expect(streamEvents).not.toContain('setNotice("回复失败")');
  });
});

describe("供应商设置不再有默认模型/启用概念", () => {
  it("设置页不渲染「默认模型」行/默认单选列，但保留拨片开关列", () => {
    expect(settings).not.toContain("settings.providers.defaultModel");
    expect(settings).not.toContain('name="default-model"');
    expect(settings).not.toContain("settings.providers.col.default");
    expect(settings).toContain("settings.providers.col.enable");
  });

  it("模型表头有「全选 / 取消全选」拨片（一键切换全部显示开关）", () => {
    expect(settings).toContain('testId="model-toggle-all"');
    expect(settings).toContain("settings.providers.toggleAll");
    expect(settings).toContain("setAllShown");
  });

  it("工具条重构：全选拨片在表格上方（不在 thead 里），并带计数摘要 + 模型 ID 搜索栏", () => {
    // 拨片仍在（testId 不变），但位置挪到 modelToolbar
    expect(settings).toContain("S.modelToolbar");
    expect(settings).toContain("settings.providers.modelSummary");
    const thead = settings.slice(settings.indexOf("<thead>"), settings.indexOf("</thead>"));
    expect(thead).not.toContain("model-toggle-all");
    expect(thead).not.toContain("setAllShown");
    // 搜索栏：过滤只影响展示，用原始下标回写
    expect(settings).toContain('data-testid="model-search"');
    expect(settings).toContain("settings.providers.searchModels");
    expect(settings).toContain("settings.providers.noMatchingModels");
    const visible = settings.slice(settings.indexOf("const visibleModels"), settings.indexOf("const visibleModels") + 320);
    expect(settings).toContain("setPModelQuery");
    expect(visible).toContain("filter");
    expect(visible).toContain("idx");
  });

  it("模型菜单按拨片开关过滤，但没有默认模型特例", () => {
    const modelGroups = fs.readFileSync(path.join(ROOT, "packages/ui/src/modelGroups.ts"), "utf8");
    expect(modelGroups).toContain("selected !== false");
    expect(modelGroups).not.toContain("默认模型始终显示");
  });
});

describe("OpenCode 供应商预设", () => {
  it("同时提供 Go 订阅与按量付费两套端点", () => {
    expect(settings).toContain("OpenCode Go（订阅）");
    expect(settings).toContain("https://opencode.ai/inference/go/openai/v1");
    expect(settings).toContain("OpenCode Zen（按量付费）");
    expect(settings).toContain("https://opencode.ai/inference/openai/v1");
    expect(settings).not.toContain('name: "OpenCode Go / Zen"');
  });
});
