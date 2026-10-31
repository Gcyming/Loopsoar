/**
 * 请求头模板（供应商限制适配）：变量替换、未知变量保留、保存前校验。
 */
import { describe, expect, it } from "vitest";
import {
  HEADER_TEMPLATE_VARIABLES,
  renderHeaderTemplates,
  renderHeaderValue,
  unknownHeaderTemplateVariables,
} from "../../packages/contracts/src/headerTemplate.ts";

describe("请求头模板", () => {
  it("替换已知变量（支持空格写法）", () => {
    expect(renderHeaderValue("{{sessionId}}", { sessionId: "sess-1" })).toBe("sess-1");
    expect(renderHeaderValue("Bearer {{ sessionId }}", { sessionId: "sess-2" })).toBe("Bearer sess-2");
    expect(renderHeaderValue("{{provider}}/{{model}}", { provider: "opencode-go", model: "glm-5.3" })).toBe("opencode-go/glm-5.3");
  });

  it("未知变量原样保留，不改坏用户配置", () => {
    expect(renderHeaderValue("x-{{unknown}}", { sessionId: "s" })).toBe("x-{{unknown}}");
    expect(unknownHeaderTemplateVariables({ foo: "{{nope}}", bar: "{{sessionId}}" })).toEqual(["nope"]);
  });

  it("整组渲染保持键与顺序，空值变量替换为空字符串", () => {
    const headers = renderHeaderTemplates(
      { "x-opencode-session": "{{sessionId}}", "x-agent": "Loopsoar/1.0", "x-request": "{{requestId}}" },
      { sessionId: "sess-9", requestId: "req-1" },
    );
    expect(headers).toEqual({ "x-opencode-session": "sess-9", "x-agent": "Loopsoar/1.0", "x-request": "req-1" });
    expect(renderHeaderTemplates({ a: "{{model}}" }, {})).toEqual({ a: "" });
  });

  it("变量清单是单一产地（UI 帮助与校验共用）", () => {
    expect(HEADER_TEMPLATE_VARIABLES).toEqual(["sessionId", "provider", "model", "requestId", "timestamp"]);
  });
});
