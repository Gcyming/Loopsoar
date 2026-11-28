/**
 * 主进程核心服务装配（无 Electron 运行时依赖）。
 *
 * 从 index.ts 抽出：平台/工具注册表/沙箱、供应商与密钥、记忆库、会话/工作区、
 * 终端/扩展/MCP/Agent 注册表。Electron 的 safeStorage 由 index 注入，
 * 保持“仅 index.ts 与 electronBrowser.ts import electron”的约束。
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createNodePlatform, nodePathPort } from "loopsoar-core/platform";
import { ToolRegistry } from "loopsoar-core/tools/registry";
import { registerBuiltinMinimal } from "loopsoar-core/tools/builtin";
import { SandboxManager } from "loopsoar-core/sandbox";
import { createAnthropicClient, createOpenAiClient, inferApiFormat, type LlmClient } from "loopsoar-core/llm";
import { AgentRegistry, BUILTIN_AGENT } from "loopsoar-core/agent";
import { resolveApiKeyFromEnv } from "loopsoar-core/provider";
import { renderHeaderTemplates } from "loopsoar-contracts/headerTemplate";
import { loadPermissions, loadPreferences, loadProviderConfig, savePreferencesPatch } from "./domains/settings.js";
import { withProviderDefaults } from "./providerDefaults.js";
import { MemoryService } from "./memoryService.js";
import { SessionStore } from "./sessionStore.js";
import { WorkspaceStore } from "./workspaceStore.js";
import { resolveSessionRoot as resolveRoot } from "./workspaceRoot.js";
import { ProviderStore } from "./providerStore.js";
import { SecretStore } from "./secretStore.js";
import { ExtensionHost } from "./extensions.js";
import { SkillHost } from "./skills.js";
import { McpHost } from "./mcpHost.js";
import { BookmarksStore } from "./bookmarksStore.js";
import { ShortcutsStore } from "./shortcutsStore.js";
import { TerminalSessionManager } from "./terminalSession.js";
import { SubagentTaskStore } from "./subagentTaskStore.js";
import { AskBus } from "./askBus.js";
import { createLoopRuntime } from "./loopRuntime.js";
import { ExtensionContributions } from "./extensionContributions.js";
import { createMemoryReranker } from "./memoryRerank.js";
import { wireMcpBridge } from "./mcpSampling.js";

export interface CoreServiceInput {
  dirs: { dataDir: string; configDir: string };
  /** 宿主应用版本（扩展 engines.loopsoar 的比对对象）。 */
  appVersion?: string;
  bootTrace: { mark(label: string): void };
  pushToRenderer: (event: string, payload: unknown) => void;
  /** ask_user 询问推送到渲染层前的旁路（主进程用于系统通知，不改变事件语义）。 */
  onAskUser?: (payload: { sessionId?: string; question?: string; header?: string }) => void;
  /**
   * 默认工作区根（用户未在设置里选过工作区时生效）。
   * 打包态必须传入 userData 下的目录：安装目录快捷方式的 cwd 是程序目录，
   * 直接拿 process.cwd() 会让文件工具/终端/截图往安装目录写。
   */
  defaultWorkspaceRoot?: string;
  /** 打包态：默认工作区落到 <dataDir>/workspace，绝不用安装目录/启动 cwd。 */
  isPackaged?: boolean;
  safeStorage: {
    isEncryptionAvailable(): boolean;
    encryptString(plain: string): Buffer;
    decryptString(encrypted: Buffer): string;
  };
}

export async function createCoreServices(input: CoreServiceInput) {
  const { dirs, bootTrace, pushToRenderer, safeStorage } = input;
  // 打包态默认工作区 = <dataDir>/workspace；开发态保持 cwd（monorepo 根）。
  const packagedRoot = input.isPackaged && input.dirs?.dataDir ? path.join(input.dirs.dataDir, "workspace") : undefined;
  const fallbackWorkspaceRoot = input.defaultWorkspaceRoot?.trim() || packagedRoot || process.cwd();
  if (input.defaultWorkspaceRoot?.trim() || packagedRoot) fs.mkdirSync(fallbackWorkspaceRoot, { recursive: true });
  // 装配：platform / 工具注册表 / 沙箱 / Provider 配置 → ChatService（真 LLM 闭环）
  const platform = createNodePlatform();
  const registry = new ToolRegistry();
  registerBuiltinMinimal(registry, platform);
  const sandbox = new SandboxManager({ workspaceRoot: fallbackWorkspaceRoot, paths: nodePathPort });
  sandbox.syncKnownTools(registry.list().map((t) => t.name));
  // 权限设置里的「额外授权工作目录」必须真正进沙箱白名单，否则只是设置页上的空开关。
  sandbox.setAllowedDirs(loadPermissions(dirs.configDir).workspaceRoots.map((dir) => path.resolve(dir)));

  // 偏好（工作区根 / 记忆库位置 / 自动记忆开关）→ 决定后续装配
  const initialPrefs = loadPreferences(dirs.configDir);
  let workspaceRoot = initialPrefs.workspaceRoot?.trim() || fallbackWorkspaceRoot;
  sandbox.setWorkspaceRoot(workspaceRoot);

  // 加密密钥库：OS 密钥库优先；不可用时降级 AES（.secret.key 0600）。
  // 注意：必须在 ProviderStore 之前创建 —— 供应商去重合并时要靠它迁移密钥（见下方 callback）。
  const secrets = new SecretStore(dirs.configDir, {
    available: safeStorage.isEncryptionAvailable(),
    encrypt: (plain: string) => safeStorage.encryptString(plain),
    decrypt: (buf: Buffer) => safeStorage.decryptString(buf),
  });
  // 密钥存储策略（发布阶段 §4.4）：OS 密钥库可用时**只存 OS 密文**；
  // 只有安全存储不可用、或历史文件本身就是 degraded 模式时，才使用 AES 降级后端
  //（否则旧密钥读不出来），并在设置页/诊断里明确标注。
  const secretsKeyFile = path.join(dirs.configDir, ".secret.key");
  const secretFileMode = secrets.fileMode();
  if (!safeStorage.isEncryptionAvailable() || secretFileMode === "degraded") {
    secrets.useDegradedBackend(secretsKeyFile);
  } else {
    // 清理旧版本双写留下的 AES 备份（含 .secret.key），避免「OS 保管」名不副实。
    const purged = secrets.purgeFallback(secretsKeyFile);
    if (purged.purged > 0) {
      console.log(`[Loopsoar] 已清理 ${purged.purged} 条历史降级密钥备份（只保留系统密钥库）`);
    }
  }
  /**
   * 供应商去重合并时迁移密钥（2026-11-10 用户报障「切换 Key 不生效/上游说无订阅」根因）：
   * dedupe 只保留首条 id，副本 id 上的新 Key 若不迁移就会成孤儿，聊天继续用旧 Key。
   * 规则：副本 Key 比保留 id 的更新（updatedAt 更晚）才覆盖，避免把用户刚选的 Key 换回旧值。
   */
  const migrateAliasedSecrets = (aliases: Map<string, string>): void => {
    for (const [from, to] of aliases) {
      if (from === to) continue;
      const incoming = secrets.meta(from);
      if (!incoming) continue;
      const current = secrets.meta(to);
      if (current && current.updatedAt >= incoming.updatedAt) continue;
      const key = secrets.get(from);
      if (!key) continue;
      secrets.set(to, key);
      console.log(`[Loopsoar] secret migrated ${from} → ${to} (${incoming.hint})`);
    }
  };
  // 多供应商：providers.json（兼容旧 provider.json 自动迁移）
  const providers = new ProviderStore(dirs.configDir, { onAliases: migrateAliasedSecrets });
  const legacyProvider = await loadProviderConfig(platform, dirs.configDir);
  if (providers.list().length === 0 && legacyProvider) {
    const item = providers.upsert(legacyProvider);
    providers.setActive(item.id);
  }
  /**
   * 兜底修复「历史已被合并掉的副本密钥」（如 opencode-go-2，文件里已无 alias 可依）：
   * 按「保留 id-数字」后缀归并；同样只在副本 Key 更新时迁移。
   */
  const reconcileOrphanSecrets = (): void => {
    const items = providers.list();
    const known = new Set(items.map((i) => i.id));
    for (const orphanId of secrets.ids()) {
      if (known.has(orphanId)) continue;
      const match = items.find(
        (item) => orphanId.startsWith(`${item.id}-`) && /^\d+$/.test(orphanId.slice(item.id.length + 1)),
      );
      if (!match) continue;
      const incoming = secrets.meta(orphanId);
      if (!incoming) continue;
      const current = secrets.meta(match.id);
      if (current && current.updatedAt >= incoming.updatedAt) continue;
      const key = secrets.get(orphanId);
      if (!key) continue;
      secrets.set(match.id, key);
      console.log(`[Loopsoar] secret reconciled ${orphanId} → ${match.id} (${incoming.hint})`);
    }
  };
  reconcileOrphanSecrets();
  console.log(
    `[Loopsoar] dataDir=${dirs.dataDir} secrets=${secrets.storageMode()} fileMode=${secretFileMode ?? "none"} osAvailable=${safeStorage.isEncryptionAvailable()}`,
  );
  bootTrace.mark("core-assembly");
  // 开发/E2E 密钥持久化验证钩子（仅显式环境变量启用；不打印明文）
  if (process.env.LOOPSOAR_E2E_SECRET_SET) {
    const [pidRaw, key] = process.env.LOOPSOAR_E2E_SECRET_SET.split("|");
    const pid = pidRaw && pidRaw !== "active" ? pidRaw : (providers.active()?.id ?? "e2e");
    try {
      secrets.set(pid, key ?? "");
      console.log(`[E2E] SECRET_SET ok provider=${pid} mode=${secrets.storageMode()}`);
    } catch (err) {
      console.log(`[E2E] SECRET_SET failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (process.env.LOOPSOAR_E2E_SECRET_DUMP) {
    const active = providers.active();
    console.log(
      `[E2E] SECRET_DUMP ${JSON.stringify({
        dataDir: dirs.dataDir,
        storageMode: secrets.storageMode(),
        fileMode: secrets.fileMode(),
        active: active?.id ?? null,
        has: active ? secrets.has(active.id) : false,
        decrypt: active ? (secrets.get(active.id) ? "ok" : "fail") : null,
      })}`,
    );
  }
  const resolveProviderKey = (providerId?: string): string => {
    const stored = providerId ? (secrets.get(providerId) ?? "") : "";
    return stored || resolveApiKeyFromEnv(process.env);
  };
  type ProviderEntry = ReturnType<ProviderStore["list"]>[number];
  /** 供应商 RPM：同一供应商跨会话共享最小请求间隔（留空 = 不主动限制）。 */
  const rpmLastAt = new Map<string, number>();
  const throttleByRpm = (client: LlmClient, item: ProviderEntry): LlmClient => {
    if (!item.rpm || item.rpm <= 0) return client;
    const intervalMs = 60_000 / item.rpm;
    return {
      invoke: async function* (request) {
        const wait = (rpmLastAt.get(item.id) ?? 0) + intervalMs - Date.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        rpmLastAt.set(item.id, Date.now());
        yield* client.invoke(request);
      },
    };
  };
  /** 单个供应商 → LLM 客户端（请求头模板按 sessionId 渲染；缺 key 返回 undefined）。 */
  const buildLlmForProvider = (item: ProviderEntry, sessionId?: string): LlmClient | undefined => {
    const key = resolveProviderKey(item.id);
    if (!key) return undefined;
    // 请求头模板（{{sessionId}} / {{model}} / {{requestId}} …）：按请求渲染，
    // 让 x-opencode-session 这类"每会话/每请求"限制无需为每个供应商写死。
    const effectiveHeaders = withProviderDefaults(item.provider, item.baseUrl, item.headers);
    const resolveHeaders =
      Object.keys(effectiveHeaders).length > 0
        ? (): Record<string, string> =>
            renderHeaderTemplates(effectiveHeaders, {
              provider: item.provider,
              model: item.model,
              sessionId: sessionId ?? "no-session",
              requestId: randomUUID(),
              timestamp: new Date().toISOString(),
            })
        : undefined;
    // 端点协议：显式指定优先，auto 按 baseUrl 推断（OpenAI 兼容 / Anthropic Messages）
    const format = item.apiFormat && item.apiFormat !== "auto" ? item.apiFormat : inferApiFormat(item.baseUrl);
    const client =
      format === "anthropic"
        ? createAnthropicClient({
            baseUrl: item.baseUrl.replace(/\/v1$/, ""),
            apiKey: key,
            model: item.model,
            resolveHeaders,
          })
        : createOpenAiClient({ baseUrl: item.baseUrl, apiKey: key, model: item.model, resolveHeaders });
    return throttleByRpm(client, item);
  };

  /**
   * 当前活动供应商 → LLM 客户端（**不做跨供应商静默降级**）。
   *
   * 2026-11-08 用户明确要求：「配的是 opencode-zen，回复却自称 Agnes-3.0-flash」——这是旧实现里
   * 的「多供应商降级链」：活动供应商 429/超时后自动切到下一个供应商继续回答（且有 30s 冷却），
   * 但 UI/模型 chip 仍显示活动供应商，于是「模型对应不上」。
   * 现在的语义：选哪个供应商就用哪个；用不了就把上游错误原样报出来（额度/鉴权等错误已在
   * core/llm/upstreamError.ts 里快速失败并给中文可行动提示）。要换供应商由用户显式切换。
   */
  const buildLlmFromActive = (sessionId?: string): LlmClient | undefined => {
    const active = providers.active();
    if (!active) return undefined;
    return buildLlmForProvider(active, sessionId);
  };
  // 惰性引用：供应商增删改/切换活跃后立即生效（无需重启）
  // 活跃 LLM 由 index 惰性持有，确保设置切换即时生效。

  // 记忆库（路径可在设置里改）+ 会话持久化
  const memoryFile = initialPrefs.memoryStorePath?.trim() || path.join(dirs.dataDir, "memory", "memory.json");
  const memory = new MemoryService({
    platform,
    filePath: memoryFile,
    // 用户显式选择 sqlite-vec 时才加载原生模块；加载/建表失败会自动降级 flat 并记录 note。
    vectorBackend: initialPrefs.memoryVectorBackend ?? "flat",
  });
  // 可选 LLM 重排：只在显式搜索且模型可用时触发；失败/超时自动回退 ranker（fail-open）。
  memory.setReranker(createMemoryReranker(() => buildLlmFromActive()));
  // 记忆加载不阻塞首次出窗：load() 在重建向量索引时会探测本地 embedding（最坏 embedTimeout=3000ms，
  // 见 memoryService.ts:84 + buildExternalIndex），等待它会把窗口创建一起拖住。
  // 读取路径在「尚未 loaded」时按空库返回空结果（MemoryService 的读方法直接读 store），
  // 因此窗口/IPC 装配无需已加载状态；加载完成只影响「第一条消息」的记忆召回，代价可接受。
  const memoryReady = memory
    .load()
    .then(() => bootTrace.mark("memory-load-done"))
    .catch(() => undefined);
  // 加载在后台继续；只有「记忆写入」等极少数路径需要等它，首屏不等（见上方注释）。
  void memoryReady;
  bootTrace.mark("memory-load-started");

  // 询问用户总线（ask_user 工具）：ask:user 推渲染层弹窗，回答经 ask:respond 结算（超时按取消）
  const askBus = new AskBus({
    push: (event, payload) => {
      if (event === "ask:user") input.onAskUser?.(payload as { sessionId?: string; question?: string; header?: string });
      pushToRenderer(event, payload);
    },
  });

  // Agent-Loop 运行时（ADR-0010）：内置 loop + 安全模式回退；选择持久化到偏好（运行时切换即生效）
  const loopRuntime = createLoopRuntime({
    push: (event, payload) => pushToRenderer(event, payload),
    getActiveId: () => loadPreferences(dirs.configDir).loopId,
    onActiveChanged: (id) => {
      savePreferencesPatch(dirs.configDir, { loopId: id });
    },
    // L2 声明式 / L3 脚本 loop 从 <dataDir>/loops 扫描（坏文件跳过并记录 error）
    dataDir: dirs.dataDir,
  });
  const sessions = new SessionStore(path.join(dirs.dataDir, "sessions"));
  // 记忆召回 L1 判定：会话存储就绪后注入存活会话（未注入时按 provenance 判 L1）。
  memory.setLiveSessionProvider(() => sessions.list().map((session) => session.id));
  // 工作区：挂载项目文件夹。旧偏好里的 workspaceRoot 作为默认工作区，兼容升级用户。
  const workspaces = new WorkspaceStore(
    path.join(dirs.dataDir, "workspaces.json"),
    initialPrefs.workspaceRoot?.trim() || fallbackWorkspaceRoot,
  );
  const worktreesRoot = path.join(dirs.dataDir, "worktrees");
  // 书签（浏览器功能面 MVP）：独立 JSON 存储，单实例（多实例会互相覆盖）
  const bookmarks = new BookmarksStore(dirs.dataDir);
  // 新标签页快捷方式（用户主动添加，可编辑）：与书签同层，独立 JSON。
  const shortcuts = new ShortcutsStore(dirs.dataDir);
  /** 会话工作根：会话 worktree > 会话工作区 > 活动工作区。 */
  const resolveSessionRoot = (sessionId?: string): string => {
    const worktree = sessionId ? sessions.getWorktree(sessionId) : null;
    const workspaceId = sessionId ? sessions.get(sessionId)?.workspaceId : null;
    const bound = workspaceId ? workspaces.get(workspaceId) : null;
    return resolveRoot({
      worktreePath: worktree?.path ?? null,
      sessionWorkspaceRoot: bound?.root ?? null,
      activeWorkspaceRoot: workspaces.active()?.root ?? null,
      fallback: workspaceRoot,
      isDirectory: (dir) => {
        try {
          return fs.statSync(dir).isDirectory();
        } catch {
          return false;
        }
      },
    });
  };
  // 沙箱根跟随活动工作区（逐个工具执行前还会按会话根覆盖，见 ChatService.resolveWorkspaceRoot）
  sandbox.setWorkspaceRoot(workspaces.active()?.root ?? workspaceRoot);

  // 终端会话管理器（持久多环境终端）：每终端独立子进程，进程与工作根按会话隔离
  const terminals = new TerminalSessionManager({
    resolveWorkspaceRoot: (sessionId?: string) => resolveSessionRoot(sessionId),
    push: (event, payload) => pushToRenderer(event, payload),
  });
  const extensions = new ExtensionHost(path.join(dirs.dataDir, "extensions"), {
    hostVersion: input.appVersion ?? "0.1.0",
  });
  // 扩展贡献点（第三阶段 C）：loops → LoopRegistry；themes → UI（启停/卸载自动精确撤下）。
  const extensionContributions = new ExtensionContributions(loopRuntime, extensions, () => {
    pushToRenderer("loop:changed", loopRuntime.list());
  });
  extensionContributions.sync();
  const skills = new SkillHost(path.join(dirs.dataDir, "skills"));
  skills.watch((installed) => pushToRenderer("skills:updated", { action: "watch", installed }));
  const subagentTasks = new SubagentTaskStore(path.join(dirs.dataDir, "subagents"));
  const mcp = new McpHost(
    path.join(dirs.dataDir, "mcp.json"),
    registry,
    () => pushToRenderer("mcp:updated", { servers: mcp.list() }),
    () => sandbox.syncKnownTools(registry.list().map((t) => t.name)),
  );
  // 反向能力：roots 优先用当前工具调用所属会话；无调用上下文时回退活动会话。
  // sampling 借用当前供应商的模型（无模型时明确报错）。在 connect 之前注入，initialize 才会声明 sampling 能力。
  wireMcpBridge(mcp, { roots: (sessionId) => [resolveSessionRoot(sessionId)], getLlm: () => buildLlmFromActive() });

  // Agent 注册表（真实实现）：内置默认 Agent → 决定身份段与工具白名单
  const agents = new AgentRegistry();
  agents.registerBuiltin(BUILTIN_AGENT);
  const defaultAgent = agents.defaultAgent();
  bootTrace.mark("stores");
  return {
    platform,
    registry,
    sandbox,
    secrets,
    providers,
    buildLlmFromActive,
    memory,
    askBus,
    loopRuntime,
    extensionContributions,
    sessions,
    workspaces,
    worktreesRoot,
    bookmarks,
    shortcuts,
    resolveSessionRoot,
    terminals,
    extensions,
    skills,
    subagentTasks,
    mcp,
    agents,
    defaultAgent,
    getWorkspaceRoot: () => workspaceRoot,
    setWorkspaceRoot: (next: string): void => {
      workspaceRoot = next;
      sandbox.setWorkspaceRoot(next);
    },
  };
}
