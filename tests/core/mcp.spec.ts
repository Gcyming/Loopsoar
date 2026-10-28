/** MCP 纯逻辑：行分帧 / 工具命名 / 绑定映射。 */
import { describe, expect, it } from "vitest";
import { JsonRpcLineDecoder, bindMcpTools, encodeRpc, mcpToolName } from "../../packages/core/src/mcp.ts";

describe("MCP JSON-RPC 与工具映射", () => {
  it("编码为单行 JSON + 换行", () => {
    const line = encodeRpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line.trim()).method).toBe("tools/list");
  });

  it("解码容忍分片与坏行", () => {
    const dec = new JsonRpcLineDecoder();
    expect(dec.push('{"jsonrpc":"2.0","id":1,"resu')).toEqual([]);
    const out = dec.push('lt":{}}\nnot-json\n{"jsonrpc":"2.0","id":2,"result":{"ok":1}}\n');
    expect(out.length).toBe(2);
    expect(out[0].id).toBe(1);
    expect(out[1].id).toBe(2);
  });

  it("工具名加服务器前缀，绑定列表过滤非法项", () => {
    expect(mcpToolName("my server", "read-file")).toBe("mcp__my_server__read_file");
    const bindings = bindMcpTools("fs", {
      tools: [{ name: "read", description: "读", inputSchema: { type: "object" } }, { name: "" }, null],
    });
    expect(bindings.length).toBe(1);
    expect(bindings[0].registryName).toBe("mcp__fs__read");
  });
});
