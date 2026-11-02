/**
 * web_search 工具（packages/shell/src/main/searchTools.ts）：
 * 引擎 URL 编码、Bing/DuckDuckGo HTML 解析、相对链接与跳转链归一化、maxResults 截断、空结果/错误文案。
 * 全部用假 NetAdapter（不联网、不启子进程）。
 */
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import type { NetAdapter, NetRequestOptions, NetResponse } from "../../packages/core/src/platform/types.ts";
import { registerSearchTools } from "../../packages/shell/src/main/searchTools.ts";

const BING_HTML = `<!doctype html><html><body><ol id="b_results">
<li class="b_algo"><h2><a href="https://example.com/a">示例 A 标题</a></h2><div class="b_caption"><p>这是 A 的<strong>摘要</strong>。</p></div></li>
<li class="b_algo"><h2><a href="/local/path">本地相对结果 &amp; 标题</a></h2><p>相对链接的摘要</p></li>
<li class="b_algo"><h2><a href="https://example.com/a">重复结果</a></h2><p>重复摘要</p></li>
<li class="b_algo"><h2><a href="https://example.com/b">结果 B</a></h2><div class="b_caption"><p>B 的摘要</p></div></li>
</ol></body></html>`;

const DDG_HTML = `<!doctype html><html><body>
<div class="result results_links">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fpage%3Fa%3D1&amp;rut=xyz">DDG 结果一</a>
  <a class="result__snippet" href="#">第一个摘要 <b>加粗</b></a>
</div>
<div class="result results_links">
  <a class="result__a" href="/relative/ddg">DDG 相对结果</a>
  <div class="result__snippet">第二个摘要</div>
</div>
<a class="result__a" href="javascript:void(0)">坏链接</a>
</body></html>`;

const BING_EXPECTED = [
  "1. 示例 A 标题",
  "   https://example.com/a",
  "   这是 A 的摘要。",
  "2. 本地相对结果 & 标题",
  "   https://www.bing.com/local/path",
  "   相对链接的摘要",
  "3. 结果 B",
  "   https://example.com/b",
  "   B 的摘要",
].join("\n");

type NetResponder = Partial<NetResponse> | ((opts: NetRequestOptions) => Partial<NetResponse> | Promise<Partial<NetResponse>>);

/** 假网络：记录请求 + 返回固定响应（默认 finalUrl = 请求 url）。 */
function makeNet(responder: NetResponder): { net: NetAdapter; calls: NetRequestOptions[] } {
  const calls: NetRequestOptions[] = [];
  const net: NetAdapter = {
    async request(opts: NetRequestOptions): Promise<NetResponse> {
      calls.push(opts);
      const raw = typeof responder === "function" ? await responder(opts) : responder;
      return { status: 200, finalUrl: opts.url, text: "", headers: {}, ...raw };
    },
    async fetchText(): Promise<{ status: number; finalUrl: string; text: string }> {
      throw new Error("web_search 不应调用 fetchText");
    },
    async resolveIps(): Promise<string[]> {
      return ["93.184.216.34"];
    },
  };
  return { net, calls };
}

function makeTool(
  engine: string | undefined,
  net: NetAdapter | undefined,
  opts: { getMaxResults?: () => number | undefined } = {},
): { registry: ToolRegistry; tool: ReturnType<ToolRegistry["get"]> } {
  const registry = new ToolRegistry();
  registerSearchTools(registry, {
    getEngine: () => engine,
    getPlatform: () => (net ? { net } : {}),
    getMaxResults: opts.getMaxResults,
  });
  return { registry, tool: registry.get("web_search") };
}

async function run(
  tool: NonNullable<ReturnType<ToolRegistry["get"]>>,
  params: unknown,
  platform: unknown = {},
): Promise<{ ok: boolean; content: string }> {
  return tool.execute({ agentId: "test-agent", platform, params });
}

describe("web_search · 注册与参数", () => {
  it("注册工具、声明 network 权限、schema 边界", () => {
    const { registry, tool } = makeTool("bing", makeNet({}).net);
    expect(registry.list().map((item) => item.name)).toContain("web_search");
    expect(tool).toBeTruthy();
    expect(tool!.permissions.network).toBe(true);

    const schema = tool!.schema;
    expect(schema.safeParse({ query: "loopsoar" }).success).toBe(true);
    expect(schema.safeParse({ query: "" }).success).toBe(false);
    expect(schema.safeParse({ query: "x".repeat(501) }).success).toBe(false);
    expect(schema.safeParse({ query: "x", maxResults: 1 }).success).toBe(true);
    expect(schema.safeParse({ query: "x", maxResults: 0 }).success).toBe(false);
    expect(schema.safeParse({ query: "x", maxResults: 11 }).success).toBe(false);
    // 工具参数的 JSON Schema 能被模型看到（P2-1 转换链路）
    const json = registry.toolSchemas(["web_search"])[0].function.parameters as {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(json.type).toBe("object");
    expect(json.properties?.query).toBeTruthy();
    expect(json.required).toContain("query");
  });

  it("请求参数固定走安全网络层（GET / 12s / 200k / 禁回环）", async () => {
    const { net, calls } = makeNet({ text: BING_HTML });
    const { tool } = makeTool("bing", net);
    await run(tool!, { query: "loopsoar" });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].timeoutMs).toBe(12_000);
    expect(calls[0].maxChars).toBe(200_000);
    expect(calls[0].allowLoopback).toBe(false);
    expect(calls[0].headers?.["user-agent"]).toContain("LoopsoarBot");
  });
});

describe("web_search · 引擎 URL", () => {
  it("bing：查询词做 URL 编码", async () => {
    const { net, calls } = makeNet({ text: BING_HTML });
    const { tool } = makeTool("bing", net);
    const query = "loop soár & 测试";
    const result = await run(tool!, { query });
    expect(result.ok).toBe(true);
    expect(calls[0].url).toBe(`https://www.bing.com/search?q=${encodeURIComponent(query)}`);
  });

  it("duckduckgo：走 html.duckduckgo.com 结果页", async () => {
    const { net, calls } = makeNet({ text: DDG_HTML });
    const { tool } = makeTool("duckduckgo", net);
    await run(tool!, { query: "a b" });
    expect(calls[0].url).toBe(`https://html.duckduckgo.com/html/?q=${encodeURIComponent("a b")}`);
  });

  it("google：按产品约定用 DuckDuckGo 兜底（URL 与解析同 DDG）", async () => {
    const { net, calls } = makeNet({ text: DDG_HTML });
    const { tool } = makeTool("google", net);
    const result = await run(tool!, { query: "loopsoar" });
    expect(calls[0].url.startsWith("https://html.duckduckgo.com/html/?q=")).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("DDG 结果一");
  });

  it("未知引擎名默认 bing", async () => {
    const { net, calls } = makeNet({ text: BING_HTML });
    const { tool } = makeTool("baidu", net);
    await run(tool!, { query: "x" });
    expect(calls[0].url.startsWith("https://www.bing.com/search?q=")).toBe(true);
  });
});

describe("web_search · 结果解析", () => {
  it("bing：标题/绝对 URL/摘要/相对链接/HTML 实体/去重", async () => {
    const { tool } = makeTool("bing", makeNet({ text: BING_HTML }).net);
    const result = await run(tool!, { query: "loopsoar" });
    expect(result.ok).toBe(true);
    expect(result.content).toBe(BING_EXPECTED);
    // 重复 URL 只保留第一条；相对链接已按结果页 URL 解析
    expect(result.content.match(/https:\/\/example\.com\/a/g)).toHaveLength(1);
    expect(result.content).toContain("https://www.bing.com/local/path");
  });

  it("duckduckgo：跳转链取真实目标、相对链接解析、坏 scheme 丢弃", async () => {
    const { tool } = makeTool("duckduckgo", makeNet({ text: DDG_HTML }).net);
    const result = await run(tool!, { query: "loopsoar" });
    expect(result.ok).toBe(true);
    const expected = [
      "1. DDG 结果一",
      "   https://example.org/page?a=1",
      "   第一个摘要 加粗",
      "2. DDG 相对结果",
      "   https://html.duckduckgo.com/relative/ddg",
      "   第二个摘要",
    ].join("\n");
    expect(result.content).toBe(expected);
    expect(result.content).not.toContain("javascript:");
  });

  it("maxResults 截断（参数优先于默认值）", async () => {
    const withDefault = makeTool("bing", makeNet({ text: BING_HTML }).net, { getMaxResults: () => 2 });
    const limited = await run(withDefault.tool!, { query: "loopsoar" });
    expect(limited.content).toContain("1. 示例 A 标题");
    expect(limited.content).toContain("2. 本地相对结果 & 标题");
    expect(limited.content).not.toContain("3. 结果 B");

    const noLimit = makeTool("bing", makeNet({ text: BING_HTML }).net);
    const paramLimited = await run(noLimit.tool!, { query: "loopsoar", maxResults: 1 });
    expect(paramLimited.content).toContain("1. 示例 A 标题");
    expect(paramLimited.content).not.toContain("2. ");
  });

  it("无结果 → [空结果] 可读文案（不是伪造结果）", async () => {
    const { tool } = makeTool("bing", makeNet({ text: "<html><body>nothing here</body></html>" }).net);
    const result = await run(tool!, { query: "有没有这种东西" });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("[空结果]");
    expect(result.content).toContain("有没有这种东西");
  });
});

describe("web_search · 错误路径", () => {
  it("HTTP 非 2xx → [错误] + 状态码", async () => {
    const { tool } = makeTool("bing", makeNet({ status: 503, text: "" }).net);
    const result = await run(tool!, { query: "x" });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("[错误]");
    expect(result.content).toContain("HTTP 503");
  });

  it("反爬/验证页 → [错误] 提示（不返回空结果误导模型）", async () => {
    const { tool } = makeTool("bing", makeNet({ text: "<html><body>Our systems have detected unusual traffic</body></html>" }).net);
    const result = await run(tool!, { query: "x" });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("[错误]");
    expect(result.content).toContain("反爬");
  });

  it("网络层抛错（如 SSRF 拦截）→ [错误] + 原始可读原因", async () => {
    const { net } = makeNet(() => {
      throw new Error("SSRF 拦截：拒绝访问私网/保留地址 10.0.0.1");
    });
    const { tool } = makeTool("bing", net);
    const result = await run(tool!, { query: "x" });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("[错误]");
    expect(result.content).toContain("SSRF 拦截");
  });

  it("缺少网络适配器 → [错误] 网络适配器未就绪", async () => {
    const { tool } = makeTool("bing", undefined);
    const result = await run(tool!, { query: "x" });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("网络适配器未就绪");
  });

  it("缺少 query → [错误] 缺少 query", async () => {
    const { tool } = makeTool("bing", makeNet({ text: BING_HTML }).net);
    const result = await run(tool!, {});
    expect(result.ok).toBe(false);
    expect(result.content).toContain("缺少 query");
  });

  it("ctx.platform 注入优先（deps.getPlatform 未提供时仍可搜索）", async () => {
    const { net } = makeNet({ text: BING_HTML });
    const registry = new ToolRegistry();
    registerSearchTools(registry, { getEngine: () => "bing" });
    const result = await run(registry.get("web_search")!, { query: "loopsoar" }, { net });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("示例 A 标题");
  });
});
