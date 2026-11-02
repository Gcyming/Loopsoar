/**
 * Gateway 的 headless Agent 运行时（shell 主进程，禁止 import electron）。
 *
 * 为什么需要：OpenAI 兼容网关（packages/gateway）只负责 HTTP 协议；真正的「Agent 在跑」必须有
 * 平台适配层（fs/process/net）、工具注册表、沙箱、供应商配置/密钥、记忆与 ChatService。
 * 本文件在**无窗口**场景下把这些装配起来，并把 ChatService 的流式事件映射成 OpenAI chunk。
 *
 * 与 GUI 主进程装配的区别（有意精简）：
 *   · 没有 BrowserHost / IPC / Electron：只有文件、终端、todo、记忆工具；
 *   · 工作区根固定为 <dataDir>/gateway-workspace（或注入 workspaceRoot），不会写到用户当前项目；
 *   · 权限策略为 headless 全允许（网关本身就是「让外部客户端驱动 Agent」的入口，且只监听回环+可选 Bearer）；
 *     沙箱的越界/危险命令硬规则仍然生效（fail-closed 不降级）。
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { createNodePlatform } from "loopsoar-core/platform";
import type { LoopsoarPlatform } from "loopsoar-core/platform";
import { ToolRegistry } from "loopsoar-core/tools/registry";
import { registerBuiltinMinimal } from "loopsoar-core/tools/builtin";
import { SandboxManager } from "loopsoar-core/sandbox";
import type { Permissions } from "loopsoar-core/permissions";
import { resolveApiKeyFromEnv } from "loopsoar-core/provider";
import { createAnthropicClient, createOpenAiClient, inferApiFormat, type LlmClient } from "loopsoar-core/llm";
import { renderHeaderTemplates } from "loopsoar-contracts/headerTemplate";
import { ChatService, type ChatInput, type ChatStreamResult } from "loopsoar-services/chat";
import type { ChunkItem } from "loopsoar-services/events";
import type {
  GatewayChatRequest,
  GatewayChatRunner,
  GatewayCompletionOutcome,
  GatewayModelInfo,
  OpenAiStreamChunk,
} from "loopsoar-gateway";

/** 网关模块惰性加载：fastify 是 CJS，静态 import 会被 esbuild 打进 ESM 主包并触发动态 require 失败。 */
let gatewayModulePromise: Promise<typeof import("loopsoar-gateway")> | null = null;
function loadGatewayModule(): Promise<typeof import("loopsoar-gateway")> {
  gatewayModulePromise ??= import("loopsoar-gateway");
  return gatewayModulePromise;
}

/** 与 gateway 包同名语义保持一致（budget=预算收敛 → length，其余 stop）。 */
function finishReasonForStatus(status: string): string {
  return status === "budget" ? "length" : "stop";
}

/** 网关 app 的最小结构（domain 只用到 listen/close；避免把 Fastify 类型带进 shell）。 */
export interface GatewayAppLike {
  listen(options: { port: number; host: string }): Promise<unknown>;
  close(): Promise<void>;
}

import { ProviderStore } from "./providerStore.js";
import { SecretStore } from "./secretStore.js";
import { withProviderDefaults } from "./providerDefaults.js";
import { MemoryService } from "./memoryService.js";
import { registerFileTools } from "./fileTools.js";
import { registerTerminalTools } from "./terminalTools.js";
import { registerPlanTools } from "./planTools.js";
import { registerMemoryTools } from "./memoryTools.js";

/** 网关专用工作区子目录名（与用户项目隔离）。 */
export const GATEWAY_WORKSPACE_DIR = "gateway-workspace";
/** 缺省监听端口（与 slime 的 19000/19110 隔离）。 */
export const GATEWAY_DEFAULT_PORT = 19210;

/** ChatService 的最小接口（测试注入 fake chat 时只依赖这两个方法）。 */
export interface GatewayChatLike {
  stream(input: ChatInput, sink?: (item: ChunkItem) => void): Promise<ChatStreamResult>;
  stop(sessionId: string): boolean;
}

/** 网关会话（内存态；x-loopsoar-session 复用）。 */
export interface GatewaySession {
  id: string;
  createdAt: number;
  updatedAt: number;
  /** 多轮上下文（OpenAI 客户端按会话复用；服务端维护，避免每次全量回传）。 */
  history: { role: "user" | "assistant"; content: string }[];
}

/** OpenAI chunk 的上下文（id/model/created 在一次对话内保持一致）。 */
export interface OpenAiChunkContext {
  id: string;
  model: string;
  created: number;
}

/** SSE 映射状态：tool_calls 聚合（OpenAI 要求按 index 顺序拼装）。 */
export interface SseMappingState {
  toolCalls: Array<{ id: string; name: string; args: unknown }>;
}

export interface GatewayRuntimeOptions {
  dataDir: string;
  configDir: string;
  /** 平台适配层（缺省 createNodePlatform；GUI 内可复用主进程 platform）。 */
  getPlatform?: () => LoopsoarPlatform;
  /** 工作区根（缺省 <dataDir>/gateway-workspace）。 */
  workspaceRoot?: string;
  /** 环境变量（缺省 process.env；用于 LOOPSOAR_API_KEY / LOOPSOAR_GATEWAY_TOKEN）。 */
  env?: Record<string, string | undefined>;
  /** 未配置供应商时的模型名回退。 */
  defaultModel?: string;
  /** 会话上限（LRU 淘汰；默认 100）。 */
  maxSessions?: number;
  /** Agent 循环上限（默认 40 轮 / 100 次工具调用）。 */
  maxRounds?: number;
  maxToolCalls?: number;
  /** 测试/嵌入注入：跳过真实装配，直接用 fake chat 验证 SSE 映射与会话复用。 */
  chat?: GatewayChatLike;
}

/** 网关运行时的对外形状（domain/gateway.ts 启停它）。 */
export interface GatewayRuntime {
  app: GatewayAppLike;
  sessions: Map<string, GatewaySession>;
  chat: GatewayChatLike;
  ensureSession: (sessionId?: string) => GatewaySession;
  models: () => GatewayModelInfo[];
  dispose: () => Promise<void>;
  /** Bearer 是否强制（由 LOOPSOAR_GATEWAY_TOKEN 决定；domain 状态展示用）。 */
  tokenRequired: boolean;
}

/** headless 权限策略：网关模式下工具全部允许（沙箱越界/危险命令硬规则仍会拦截）。 */
function headlessPermissions(workspaceRoot: string): Permissions {
  return {
    read: "allow",
    write: "allow",
    terminal: "allow",
    network: "allow",
    workspaceRoots: [workspaceRoot],
    confirmDangerousAlways: false,
  };
}

/** headless 密钥库：无 Electron safeStorage，只读「降级 AES 双写备份」（index 主进程写入过密文即可解密）。 */
export function createHeadlessSecretStore(configDir: string): SecretStore {
  const unavailable = {
    available: false,
    encrypt: (_plain: string): Buffer => {
      throw new Error("headless 模式无 OS 密钥库，不能写入密钥");
    },
    decrypt: (_cipher: Buffer): string => {
      throw new Error("headless 模式无 OS 密钥库，不能解密主密文");
    },
  };
  const secrets = new SecretStore(configDir, unavailable);
  const fallbackKeyFile = path.join(configDir, ".secret.key");
  // 双写备份始终可读：GUI 主进程保存密钥时会同时写 degraded 密文（见 index 装配）
  secrets.setFallbackBackend(fallbackKeyFile);
  if (secrets.fileMode() === "degraded") secrets.useDegradedBackend(fallbackKeyFile);
  return secrets;
}

/** 读工作区规则（AGENTS.md / CLAUDE.md）；失败按空处理。 */
function readWorkspaceRules(workspaceRoot: string): string {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    try {
      const file = path.join(workspaceRoot, name);
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, "utf8");
      return text.length > 20_000 ? `${text.slice(0, 20_000)}\n…（规则过长已截断）` : text;
    } catch {
      // 继续找下一个
    }
  }
  return "";
}

/** 按活跃供应商构建 LlmClient（密钥：加密库 → 环境变量）。 */
function createLlmBuilder(
  providers: ProviderStore,
  secrets: SecretStore,
  env: Record<string, string | undefined>,
): (sessionId?: string) => LlmClient | undefined {
  return (sessionId?: string): LlmClient | undefined => {
    const active = providers.active();
    if (!active) return undefined;
    const key = (secrets.get(active.id) ?? "") || resolveApiKeyFromEnv(env);
    if (!key) return undefined;
    const effectiveHeaders = withProviderDefaults(active.provider, active.baseUrl, active.headers);
    const resolveHeaders =
      Object.keys(effectiveHeaders).length > 0
        ? (): Record<string, string> =>
            renderHeaderTemplates(effectiveHeaders, {
              provider: active.provider,
              model: active.model,
              sessionId: sessionId ?? "no-session",
              requestId: randomUUID(),
              timestamp: new Date().toISOString(),
            })
        : undefined;
    const format = active.apiFormat && active.apiFormat !== "auto" ? active.apiFormat : inferApiFormat(active.baseUrl);
    if (format === "anthropic") {
      return createAnthropicClient({
        baseUrl: active.baseUrl.replace(/\/v1$/, ""),
        apiKey: key,
        model: active.model,
        resolveHeaders,
      });
    }
    return createOpenAiClient({ baseUrl: active.baseUrl, apiKey: key, model: active.model, resolveHeaders });
  };
}

/** 模型清单：所有供应商的默认模型 + 已探测模型，去重；为空时给回退模型。 */
function collectModels(providers: ProviderStore, fallbackModel: string): GatewayModelInfo[] {
  const out: GatewayModelInfo[] = [];
  const seen = new Set<string>();
  const push = (id: string, ownedBy?: string): void => {
    const modelId = String(id ?? "").trim();
    if (!modelId || seen.has(modelId)) return;
    seen.add(modelId);
    out.push({ id: modelId, owned_by: ownedBy || "loopsoar" });
  };
  for (const item of providers.list()) {
    push(item.model, item.provider);
    for (const model of item.models ?? []) push(model.id, item.provider);
  }
  if (out.length === 0) push(fallbackModel, "loopsoar");
  return out.slice(0, 200);
}

/** 构造一个 OpenAI chunk（delta + finish_reason）。 */
function makeChunk(
  ctx: OpenAiChunkContext,
  delta: OpenAiStreamChunk["choices"][number]["delta"],
  finishReason: string | null = null,
): OpenAiStreamChunk {
  return {
    id: ctx.id,
    object: "chat.completion.chunk",
    created: ctx.created,
    model: ctx.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/** 首个 chunk：OpenAI 客户端通常期待先收到 role=assistant。 */
function makeRoleChunk(ctx: OpenAiChunkContext): OpenAiStreamChunk {
  return makeChunk(ctx, { role: "assistant", content: "" });
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * ChatService 流式事件 → OpenAI chunk 映射（纯函数，便于单测）。
 * 规则：
 *   · chunk/reasoning → delta.content（网关不单列 reasoning 通道，统一进正文，客户端零改造）；
 *   · tool_start → delta.tool_calls（index 递增、arguments 为 JSON 字符串），同时聚合进 state；
 *   · done → 终止 chunk（finish_reason：budget→length，其余 stop；error 状态不映射，交给 gateway 发错误体）；
 *   · tool（工具结果）/progress/heartbeat/error → null（协议无对应位置）。
 */
export function mapChatEventToOpenAiChunk(
  item: ChunkItem,
  ctx: OpenAiChunkContext,
  state: SseMappingState,
): OpenAiStreamChunk | null {
  const type = String(item.meta?.type ?? "");
  if (type === "chunk" || type === "reasoning") {
    if (!item.content) return null;
    return makeChunk(ctx, { content: item.content });
  }
  if (type === "tool_start") {
    const data = parseJsonObject(item.content);
    if (!data) return null;
    const id = typeof data.toolCallId === "string" && data.toolCallId ? data.toolCallId : `call-${state.toolCalls.length + 1}`;
    const name = typeof data.toolName === "string" ? data.toolName : "unknown_tool";
    const args = data.args ?? {};
    const index = state.toolCalls.length;
    state.toolCalls.push({ id, name, args });
    return makeChunk(ctx, {
      tool_calls: [
        {
          index,
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    });
  }
  if (type === "done") {
    const data = parseJsonObject(item.content);
    const status = typeof data?.status === "string" ? data.status : "done";
    if (status === "error") return null;
    return makeChunk(ctx, {}, finishReasonForStatus(status));
  }
  return null;
}

/** 历史裁剪：保留最近 40 条且不超过 60k 字符（防长会话撑爆上下文/内存）。 */
function trimHistory(session: GatewaySession, maxMessages = 40, maxChars = 60_000): void {
  if (session.history.length > maxMessages) session.history = session.history.slice(-maxMessages);
  let total = session.history.reduce((sum, message) => sum + message.content.length, 0);
  while (total > maxChars && session.history.length > 2) {
    const removed = session.history.shift();
    total -= removed?.content.length ?? 0;
  }
}

/**
 * 创建 headless Gateway 运行时：装配工具/记忆/ChatService，构建 OpenAI 兼容 app，并暴露启停所需对象。
 */
export async function createGatewayRuntime(options: GatewayRuntimeOptions): Promise<GatewayRuntime> {
  const dataDir = options.dataDir;
  const configDir = options.configDir;
  const env = options.env ?? process.env;
  const defaultModel = options.defaultModel?.trim() || "loopsoar-default";
  const maxSessions = options.maxSessions ?? 100;
  const sessions = new Map<string, GatewaySession>();

  const ensureSession = (sessionId?: string): GatewaySession => {
    const id = String(sessionId ?? "").trim() || `sess-${randomUUID()}`;
    let session = sessions.get(id);
    if (!session) {
      session = { id, createdAt: Date.now(), updatedAt: Date.now(), history: [] };
      sessions.set(id, session);
      // LRU 淘汰最久未更新的会话
      if (sessions.size > maxSessions) {
        const oldest = [...sessions.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0];
        if (oldest && oldest.id !== id) sessions.delete(oldest.id);
      }
    } else {
      session.updatedAt = Date.now();
    }
    return session;
  };

  const providers = new ProviderStore(configDir);
  const models = (): GatewayModelInfo[] => collectModels(providers, defaultModel);

  // ── 组装 ChatService（注入 chat 时跳过全部真实装配，供 SSE/会话映射单测） ──
  let chat: GatewayChatLike;
  let memory: MemoryService | undefined;
  if (options.chat) {
    chat = options.chat;
  } else {
    const workspaceRoot = options.workspaceRoot?.trim() || path.join(dataDir, GATEWAY_WORKSPACE_DIR);
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const platform = options.getPlatform?.() ?? createNodePlatform();
    const registry = new ToolRegistry();
    // 只读文件工具来自 core 最小集；写/终端/todo/记忆来自 shell 工具层
    registerBuiltinMinimal(registry, platform);
    registerFileTools(registry, () => workspaceRoot);
    registerTerminalTools(registry, () => workspaceRoot);
    registerPlanTools(registry);
    memory = new MemoryService({
      platform,
      filePath: path.join(dataDir, "memory", "memory.json"),
      // headless 不依赖本地 embedding 服务：直接抛错让 MemoryService 降级 hash 检索
      embed: async () => {
        throw new Error("headless 无 embedding 服务");
      },
    });
    await memory.load();
    registerMemoryTools(registry, memory);

    const sandbox = new SandboxManager();
    sandbox.setWorkspaceRoot(workspaceRoot);
    sandbox.syncKnownTools(registry.list().map((tool) => tool.name));

    const secrets = createHeadlessSecretStore(configDir);
    const buildLlm = createLlmBuilder(providers, secrets, env);
    const permissions = headlessPermissions(workspaceRoot);
    const memoryRef = memory;

    chat = new ChatService({
      platform,
      registry,
      sandbox,
      llm: buildLlm(),
      getLlm: (sessionId?: string) => buildLlm(sessionId),
      agent: { name: "Loopsoar", role: "浏览器优先的本地 AI Agent（Gateway headless 模式）" },
      // headless：授权策略全 allow，避免工具确认弹窗在无人值守时挂到超时
      permissionPolicy: () => permissions,
      resolveWorkspaceRoot: () => workspaceRoot,
      getSystemRules: () => readWorkspaceRules(workspaceRoot),
      getMemoryFor: (text: string) => memoryRef.recallPrompt(text),
      getHistory: (sessionId: string) => sessions.get(sessionId)?.history ?? [],
      getAgentLimits: () => ({
        maxRounds: options.maxRounds ?? 40,
        maxToolCalls: options.maxToolCalls ?? 100,
      }),
    });
  }

  // ── 一次对话：请求 → ChatService.stream → OpenAI chunk + 聚合结果 ──
  const complete = async (
    request: GatewayChatRequest,
    sink: (chunk: OpenAiStreamChunk) => void,
  ): Promise<GatewayCompletionOutcome> => {
    const session = ensureSession(request.sessionId);
    const messages = request.messages;
    const lastUserIndex = messages.map((message) => message.role).lastIndexOf("user");
    const isResumed = Boolean(request.sessionId);
    // 有会话头 → 以服务端会话历史为准（多轮由网关维护）；无会话头 → 用请求体里的前序消息（无状态 OpenAI 语义）
    const history = isResumed
      ? session.history
      : messages
          .slice(0, Math.max(0, lastUserIndex))
          .filter((message) => message.role !== "system")
          .map((message) => ({
            role: (message.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
            content: message.content,
          }));
    const inputText = lastUserIndex >= 0 ? messages[lastUserIndex].content : messages[messages.length - 1]?.content ?? "";

    const ctx: OpenAiChunkContext = {
      id: `chatcmpl-${randomUUID()}`,
      model: request.model || models()[0]?.id || defaultModel,
      created: Math.floor(Date.now() / 1000),
    };
    const state: SseMappingState = { toolCalls: [] };

    sink(makeRoleChunk(ctx));

    const abortListener = (): void => {
      chat.stop(session.id);
    };
    request.signal?.addEventListener("abort", abortListener);
    let result: ChatStreamResult;
    try {
      result = await chat.stream(
        {
          message: inputText,
          sessionId: session.id,
          mode: "build",
          getHistory: () => history,
        },
        (item: ChunkItem) => {
          const chunk = mapChatEventToOpenAiChunk(item, ctx, state);
          if (chunk) sink(chunk);
        },
      );
    } finally {
      request.signal?.removeEventListener("abort", abortListener);
    }

    // 会话历史只存「用户输入 + 最终回答」：工具过程不回放，避免重复注入噪音
    session.history.push({ role: "user", content: inputText });
    if (result.finalText) session.history.push({ role: "assistant", content: result.finalText });
    session.updatedAt = Date.now();
    trimHistory(session);

    return {
      id: ctx.id,
      created: ctx.created,
      model: ctx.model,
      status: result.status,
      reason: result.reason,
      finalText: result.finalText,
      toolCalls: state.toolCalls,
      usage: { totalTokens: result.usage?.totalTokens ?? 0 },
    };
  };

  const runner: GatewayChatRunner = {
    complete,
    models,
  };
  const tokenRequired = String(env.LOOPSOAR_GATEWAY_TOKEN ?? "").length > 0;
  const { buildApp } = await loadGatewayModule();
  const app = await buildApp({
    runner,
    defaultModel,
    requireToken: tokenRequired,
    gatewayToken: env.LOOPSOAR_GATEWAY_TOKEN,
  });

  return {
    app,
    sessions,
    chat,
    ensureSession,
    models,
    tokenRequired,
    dispose: async (): Promise<void> => {
      // 关闭前中止所有仍在跑的会话（避免 Gateway 停服后 Agent 继续执行工具）
      for (const session of sessions.values()) {
        try {
          chat.stop(session.id);
        } catch {
          // 忽略单会话停止失败
        }
      }
      sessions.clear();
      try {
        await app.close();
      } catch {
        // app 未监听/已关闭时忽略
      }
    },
  };
}
