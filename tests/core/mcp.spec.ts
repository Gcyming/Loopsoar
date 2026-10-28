/** MCP 纯逻辑：双帧解码 / 工具命名与冲突 / 能力门控 / 环境白名单 / 错误分类。 */
import { describe, expect, it } from "vitest";
import {
  McpFrameDecoder,
  bindMcpTools,
  describeMcpError,
  encodeHeaderFrame,
  encodeRpc,
  hasCapability,
  mcpToolName,
  sanitizeMcpEnv,
  uniqueToolName,
} from "../../packages/core/src/mcp.ts";

describe("MCP 帧编解码", () => {
  it("换行帧：编码/分片/坏行容错", () => {
    const line = encodeRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(line.endsWith("\n")).toBe(true);
    const dec = new McpFrameDecoder();
    expect(dec.push('{"jsonrpc":"2.0","id":1,"resu')).toEqual([]);
    const out = dec.push('lt":{}}\nnot-json\n{"jsonrpc":"2.0","id":2,"result":{"ok":1}}\n');
    expect(out.map((m) => m.id)).toEqual([1, 2]);
    expect(dec.mode).toBe("newline");
  });

  it("Content-Length 帧：自动探测 + 半包等待", () => {
    const frame = encodeHeaderFrame({ jsonrpc: "2.0", id: 7, result: { tools: [] } });
    const dec = new McpFrameDecoder();
    const half = Math.floor(frame.length / 2);
    expect(dec.push(frame.slice(0, half))).toEqual([]);
    const out = dec.push(frame.slice(half));
    expect(out.length).toBe(1);
    expect(out[0].id).toBe(7);
    expect(dec.mode).toBe("header");
  });

  it("Content-Length 帧含中文（按字节切分不破坏 JSON）", () => {
    const payload = { jsonrpc: "2.0", id: 9, result: { text: "中文内容测试" } };
    const frame = encodeHeaderFrame(payload);
    const dec = new McpFrameDecoder();
    const out = dec.push(frame);
    expect(out.length).toBe(1);
    expect((out[0].result as { text: string }).text).toBe("中文内容测试");
  });

  it("通知与响应混排：只按 id 分发响应", () => {
    const dec = new McpFrameDecoder();
    const out = dec.push(
      '{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n{"jsonrpc":"2.0","id":3,"result":{}}\n',
    );
    expect(out[0].method).toBe("notifications/tools/list_changed");
    expect(out[1].id).toBe(3);
  });
});

describe("MCP 工具命名 / 能力 / 环境", () => {
  it("工具名加前缀；冲突确定性加后缀", () => {
    expect(mcpToolName("my server", "read-file")).toBe("mcp__my_server__read_file");
    const existing = new Set(["mcp__srv__a", "mcp__srv__a_2"]);
    expect(uniqueToolName("mcp__srv__a", (n) => existing.has(n))).toBe("mcp__srv__a_3");
    expect(uniqueToolName("mcp__srv__b", (n) => existing.has(n))).toBe("mcp__srv__b");
  });

  it("绑定列表：过滤非法项并读取 readOnlyHint", () => {
    const bindings = bindMcpTools("fs", {
      tools: [
        { name: "read", description: "读", annotations: { readOnlyHint: true } },
        { name: "write", annotations: {} },
        { name: "" },
        null,
      ],
    });
    expect(bindings.map((b) => b.registryName)).toEqual(["mcp__fs__read", "mcp__fs__write"]);
    expect(bindings[0].readOnly).toBe(true);
    expect(bindings[1].readOnly).toBe(false);
  });

  it("能力门控", () => {
    expect(hasCapability({ tools: {} }, "tools")).toBe(true);
    expect(hasCapability({ resources: {} }, "tools")).toBe(false);
    expect(hasCapability(null, "tools")).toBe(false);
  });

  it("环境白名单：只透传系统变量 + 显式配置", () => {
    const env = sanitizeMcpEnv(
      { PATH: "C:/bin", APPDATA: "C:/app", LOOPSOAR_API_KEY: "sk-secret", OPENAI_API_KEY: "sk-2" },
      { FOO: "bar" },
    );
    expect(env.PATH).toBe("C:/bin");
    expect(env.FOO).toBe("bar");
    expect(env.LOOPSOAR_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("错误分类文案", () => {
    expect(describeMcpError("timeout", "tools/call")).toContain("超时");
    expect(describeMcpError("rpc", "-32601")).toContain("RPC");
    expect(describeMcpError("transport", "EPIPE")).toContain("传输");
  });
});
