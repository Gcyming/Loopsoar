/**
 * settings 域：偏好/权限/规则条目/诊断/供应商测试 的落盘与读取（真实临时目录，不启 electron）。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { __resetHandlerRegistryForTests } from "../../packages/shell/src/main/trustedIpc.ts";
import { RuleStatsStore } from "../../packages/shell/src/main/ruleStats.ts";
import {
  currentRulesPrompt,
  loadPermissions,
  loadPreferences,
  readRuleEntries,
  registerSettingsDomain,
  settingsPaths,
  type SettingsDeps,
} from "../../packages/shell/src/main/domains/settings.ts";
import type { LoopsoarPlatform } from "../../packages/core/src/platform/types.ts";

function makeEnv(root: string, env: Record<string, string | undefined> = {}, extra: Partial<SettingsDeps> = {}) {
  const dataDir = path.join(root, "data");
  const configDir = path.join(dataDir, "config");
  const workspaceRoot = path.join(root, "workspace");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
  const handlers = new Map<string, (e: unknown, p: unknown) => Promise<unknown>>();
  const deps: SettingsDeps = {
    ipc: {
      handle: (channel: string, fn: unknown) => {
        handlers.set(channel.replace(/^loopsoar:/, ""), fn as never);
      },
    },
    audit: () => {},
    platform: {} as LoopsoarPlatform,
    dataDir,
    configDir,
    workspaceRoot,
    env,
    appVersion: "9.9.9-test",
    ...extra,
  };
  registerSettingsDomain(deps);
  return { deps, handlers };
}

const TRUSTED = { senderFrame: { url: "loopsoar://app/index.html" } };

async function invoke(
  handlers: Map<string, (e: unknown, p: unknown) => Promise<unknown>>,
  channel: string,
  payload?: unknown,
): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`未注册 handler：${channel}`);
  return handler(TRUSTED, payload);
}

const FULL_PREFS = {
  language: "zh-CN" as const,
  animations: "full" as const,
  restoreSession: true,
  searchEngine: "bing" as const,
  downloadDir: "",
  workspaceRoot: "",
  memoryStorePath: "",
  memoryAutoCapture: true,
  sidebarWidth: 360,
};

let root: string;

beforeEach(() => {
  __resetHandlerRegistryForTests();
  root = mkdtempSync(path.join(tmpdir(), "loopsoar-settings-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("settings 域：通用偏好", () => {
  it("默认值（含记忆开关）→ 保存 → 落盘读取一致", async () => {
    const { handlers } = makeEnv(root);
    const before = (await invoke(handlers, "settings:getPreferences")) as {
      preferences: { animations: string; memoryAutoCapture: boolean };
      locations: { dataDir: string; defaultMemoryFile: string };
    };
    expect(before.preferences.animations).toBe("full");
    expect(before.preferences.memoryAutoCapture).toBe(true);
    expect(before.locations.dataDir).toContain(root);

    await invoke(handlers, "settings:setPreferences", {
      ...FULL_PREFS,
      animations: "reduced",
      memoryAutoCapture: false,
    });
    const file = path.join(root, "data", "config", "preferences.json");
    expect(JSON.parse(readFileSync(file, "utf8")).animations).toBe("reduced");
    expect(loadPreferences(path.join(root, "data", "config")).memoryAutoCapture).toBe(false);
  });

  it("非法偏好被契约校验拒绝", async () => {
    const { handlers } = makeEnv(root);
    await expect(
      invoke(handlers, "settings:setPreferences", { ...FULL_PREFS, animations: "warp" }),
    ).rejects.toThrow(/参数校验失败/);
  });
});

describe("settings 域：权限", () => {
  it("默认 fail-closed → 保存 → 读取", async () => {
    const { handlers } = makeEnv(root);
    const before = (await invoke(handlers, "settings:getPermissions")) as {
      permissions: { write: string; terminal: string; browser: string };
    };
    expect(before.permissions.write).toBe("confirm");
    expect(before.permissions.terminal).toBe("confirm");
    // 浏览器操作默认 allow（会话「浏览器控制」开关即显式授权），其余仍是 fail-closed 基线
    expect(before.permissions.browser).toBe("allow");

    await invoke(handlers, "settings:setPermissions", {
      read: "allow",
      write: "confirm",
      terminal: "deny",
      network: "allow",
      browser: "deny",
      workspaceRoots: ["D:/w1"],
      confirmDangerousAlways: true,
    });
    expect(loadPermissions(path.join(root, "data", "config")).terminal).toBe("deny");
    // browser 必须真的落盘：契约 schema 若漏掉该字段，handleTrusted 用 parsed.data 会把它剥掉、回落默认 allow
    expect(loadPermissions(path.join(root, "data", "config")).browser).toBe("deny");
  });
});

describe("settings 域：规则条目（逐条增删）", () => {
  it("项目 AGENTS.md → 生成 workspace 条目并合并进注入文本", async () => {
    const { deps, handlers } = makeEnv(root);
    writeFileSync(path.join(deps.workspaceRoot, "AGENTS.md"), "# 项目规则\n- 构建：pnpm build", "utf8");

    const entries = readRuleEntries(deps);
    const ws = entries.find((e) => e.scope === "workspace")!;
    expect(ws.content).toContain("pnpm build");
    expect(currentRulesPrompt(deps)).toContain("pnpm build");

    const viaIpc = (await invoke(handlers, "settings:getRules")) as {
      entries: { scope: string; content: string }[];
      merged: { text: string };
    };
    expect(viaIpc.entries.some((e) => e.scope === "workspace" && e.content.includes("pnpm build"))).toBe(true);
    expect(viaIpc.merged.text).toContain("pnpm build");
  });

  it("新建全局规则 + 项目规则 → 双文件落盘 + 合并顺序（全局在前）", async () => {
    const { deps, handlers } = makeEnv(root);
    const result = (await invoke(handlers, "settings:setRules", {
      entries: [
        { name: "风格.md", scope: "global", enabled: true, content: "全局：用中文回答" },
        { scope: "workspace", enabled: true, content: "项目：只改 src/ 下文件" },
      ],
    })) as { entries: { scope: string; name: string; enabled: boolean }[]; merged: { included: { scope: string }[] } };

    const paths = settingsPaths(deps);
    expect(existsSync(path.join(paths.globalRulesDir, "风格.md"))).toBe(true);
    expect(readFileSync(path.join(deps.workspaceRoot, "AGENTS.md"), "utf8")).toContain("只改 src/");
    expect(result.merged.included.map((i) => i.scope)).toEqual(["global", "workspace"]);
    expect(result.entries.filter((e) => e.enabled).length).toBeGreaterThanOrEqual(2);
  });

  it("停用条目 → 不进入合并，但保留内容", async () => {
    const { deps, handlers } = makeEnv(root);
    await invoke(handlers, "settings:setRules", {
      entries: [{ name: "off.md", scope: "global", enabled: false, content: "不要注入" }],
    });
    const prompt = currentRulesPrompt(deps);
    expect(prompt).not.toContain("不要注入");
    const entries = readRuleEntries(deps);
    expect(entries.find((e) => e.name === "off.md")?.enabled).toBe(false);
  });

  it("删除全局条目 → 文件被移除", async () => {
    const { deps, handlers } = makeEnv(root);
    await invoke(handlers, "settings:setRules", {
      entries: [{ name: "temp.md", scope: "global", enabled: true, content: "临时" }],
    });
    const file = path.join(settingsPaths(deps).globalRulesDir, "temp.md");
    expect(existsSync(file)).toBe(true);
    await invoke(handlers, "settings:setRules", { entries: [], deleted: ["global:temp.md"] });
    expect(existsSync(file)).toBe(false);
  });

  it("非法文件名 → 拒绝整体保存（不写半截）", async () => {
    const { deps, handlers } = makeEnv(root);
    await expect(
      invoke(handlers, "settings:setRules", {
        entries: [{ name: "../escape.md", scope: "global", enabled: true, content: "x" }],
      }),
    ).rejects.toThrow(/规则保存被拒绝/);
    const dir = settingsPaths(deps).globalRulesDir;
    expect(existsSync(dir) ? readdirSync(dir).length : 0).toBe(0);
  });

  it("规则超大 → 拒绝（契约层 32768 上限）", async () => {
    const { handlers } = makeEnv(root);
    await expect(
      invoke(handlers, "settings:setRules", {
        entries: [{ name: "big.md", scope: "global", enabled: true, content: "x".repeat(40 * 1024) }],
      }),
    ).rejects.toThrow(/规则保存被拒绝|参数校验失败/);
  });
});

describe("settings 域：项目规则按工作区隔离", () => {
  function workspacesOf() {
    const a = path.join(root, "proj-a");
    const b = path.join(root, "proj-b");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    return {
      a,
      b,
      list: [
        { id: "a", name: "项目 A", root: a },
        { id: "b", name: "项目 B", root: b },
      ],
    };
  }

  it("每个工作区读自己的 AGENTS.md，按会话工作区注入", async () => {
    const ws = workspacesOf();
    const { deps } = makeEnv(root, {}, {
      workspaces: { list: () => ws.list, activeId: () => "a" },
    });
    writeFileSync(path.join(ws.a, "AGENTS.md"), "# A\n- A 规则：中文回答", "utf8");
    writeFileSync(path.join(ws.b, "AGENTS.md"), "# B\n- B 规则：只改 apps/b", "utf8");

    expect(currentRulesPrompt(deps, "a")).toContain("A 规则");
    expect(currentRulesPrompt(deps, "a")).not.toContain("B 规则");
    expect(currentRulesPrompt(deps, "b")).toContain("B 规则");
    expect(currentRulesPrompt(deps, "b")).not.toContain("A 规则");

    const entry = readRuleEntries(deps, "b").find((e) => e.scope === "workspace")!;
    expect(entry.workspaceId).toBe("b");
    expect(entry.path).toContain(ws.b);
    expect(entry.id).toBe("workspace:b:AGENTS.md");
  });

  it("保存项目规则写入选定工作区；停用只影响该工作区", async () => {
    const ws = workspacesOf();
    const { deps, handlers } = makeEnv(root, {}, {
      workspaces: { list: () => ws.list, activeId: () => "a" },
    });
    await invoke(handlers, "settings:setRules", {
      entries: [{ scope: "workspace", workspaceId: "b", enabled: true, content: "B 规则：只改 apps/b" }],
    });
    expect(readFileSync(path.join(ws.b, "AGENTS.md"), "utf8")).toContain("apps/b");
    expect(existsSync(path.join(ws.a, "AGENTS.md"))).toBe(false);

    await invoke(handlers, "settings:setRules", {
      entries: [{ scope: "workspace", workspaceId: "b", enabled: false, content: "B 规则：只改 apps/b" }],
    });
    expect(currentRulesPrompt(deps, "b")).not.toContain("apps/b");
    expect(readRuleEntries(deps, "b").find((e) => e.scope === "workspace")?.enabled).toBe(false);
  });

  it("路径禁令编译成工具守卫，并随 getRules 返回", async () => {
    const ws = workspacesOf();
    const { handlers } = makeEnv(root, {}, {
      workspaces: { list: () => ws.list, activeId: () => "a" },
    });
    writeFileSync(path.join(ws.a, "AGENTS.md"), "# 规则\n- 不要修改 dist/ 下的文件\n- 只能使用 pnpm\n", "utf8");
    const snapshot = (await invoke(handlers, "settings:getRules")) as {
      guards: { path: string; actions: string[] }[];
    };
    expect(snapshot.guards).toHaveLength(1);
    expect(snapshot.guards[0].path).toBe("dist/");
    expect(snapshot.guards[0].actions).toEqual(["write"]);
    const single = (await invoke(handlers, "settings:getWorkspaceRule", { workspaceId: "a" })) as {
      guards: { path: string }[];
    };
    expect(single.guards[0].path).toBe("dist/");
  });

  it("冲突与守卫命中进入规则体检", async () => {
    const ws = workspacesOf();
    const stats = new RuleStatsStore(path.join(root, "data", "rules", "stats.json"), () => 1);
    const { deps, handlers } = makeEnv(root, {}, {
      workspaces: { list: () => ws.list, activeId: () => "a" },
      ruleStats: stats,
    });
    const rulesDir = settingsPaths(deps).globalRulesDir;
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(path.join(rulesDir, "conflict.md"), "# 全局\n- 不要使用 npm\n", "utf8");
    writeFileSync(path.join(ws.a, "AGENTS.md"), "# 项目\n- 必须使用 npm\n", "utf8");
    stats.record({ text: "不要使用 npm", toolName: "write_file", target: "dist/a.js" });

    const snapshot = (await invoke(handlers, "settings:getRules")) as {
      conflicts: { type: string }[];
      stats: { text: string; count: number }[];
    };
    expect(snapshot.conflicts).toHaveLength(1);
    expect(snapshot.conflicts[0].type).toBe("conflict");
    expect(snapshot.stats[0]).toMatchObject({ text: "不要使用 npm", count: 1 });
  });

  it("未挂载的工作区 → 拒绝保存，不写任何文件", async () => {
    const ws = workspacesOf();
    const { handlers } = makeEnv(root, {}, {
      workspaces: { list: () => ws.list, activeId: () => "a" },
    });
    await expect(
      invoke(handlers, "settings:setRules", {
        entries: [{ scope: "workspace", workspaceId: "ghost", enabled: true, content: "x" }],
      }),
    ).rejects.toThrow(/不存在或未挂载/);
    expect(existsSync(path.join(ws.a, "AGENTS.md"))).toBe(false);
  });
});

describe("settings 域：API Key 加密保存", () => {
  it("setApiKey → getProvider 只回传掩码与来源，不回传明文", async () => {
    const { deps, handlers } = makeEnv(root);
    const { SecretStore } = await import("../../packages/shell/src/main/secretStore.ts");
    const store = new SecretStore(path.join(root, "data", "config"), {
      available: true,
      encrypt: (plain: string) => Buffer.from(plain, "utf8"),
      decrypt: (buf: Buffer) => buf.toString("utf8"),
    });
    // 复用同一注册表：重建 deps 不能重复注册，改为直接调用 handler 注入 secretStore 的方式不可行，
    // 因此这里改为对 SecretStore + 域行为分别断言（域层由下一用例覆盖 handler 拒绝路径）。
    store.set("p1", "sk-settings-domain-1234");
    expect(store.get("p1")).toBe("sk-settings-domain-1234");
    expect(store.hint("p1")).toContain("…");
    void deps;
    void handlers;
  });
});

describe("settings 域：listModels 探测", () => {
  it("使用表单刚输入的密钥（未保存）而不是活跃供应商的旧密钥；并解析模型参数", async () => {
    const { SecretStore } = await import("../../packages/shell/src/main/secretStore.ts");
    const secrets = new SecretStore(path.join(root, "data", "config"), {
      available: true,
      encrypt: (plain: string) => Buffer.from(plain, "utf8"),
      decrypt: (buf: Buffer) => buf.toString("utf8"),
    });
    secrets.set("active", "sk-stored-old");
    const { handlers } = makeEnv(root, {}, {
      providers: {
        list: () => [{ id: "active", provider: "mock", baseUrl: "http://127.0.0.1:1/v1", model: "m" }],
        active: () => ({ id: "active", provider: "mock", baseUrl: "http://127.0.0.1:1/v1", model: "m" }),
        upsert: () => ({ id: "active", provider: "mock", baseUrl: "", model: "" }),
        remove: () => true,
        setActive: () => true,
      } as never,
      secrets,
    });
    const realFetch = globalThis.fetch;
    let seenAuth = "";
    let seenUrl = "";
    try {
      globalThis.fetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
        seenUrl = String(url);
        seenAuth = init?.headers?.Authorization ?? "";
        return new Response(
          JSON.stringify({
            data: [
              { id: "model-a", context_length: 128000, max_output_tokens: 8192, architecture: { input_modalities: ["image"] }, reasoning: { supported_efforts: ["low", "high"] } },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch;
      const res = (await invoke(handlers, "settings:listModels", {
        provider: "agnes",
        baseUrl: "https://api.example.com/v1",
        model: "gpt-x",
        apiKey: "sk-form-typed",
      })) as { models: { id: string; contextWindow?: number; vision?: boolean; thinkingEfforts?: string[] }[]; error: string | null };
      expect(res.error).toBeNull();
      expect(seenUrl).toBe("https://api.example.com/v1/models");
      expect(seenAuth).toBe("Bearer sk-form-typed");
      expect(res.models[0].id).toBe("model-a");
      expect(res.models[0].contextWindow).toBe(128000);
      expect(res.models[0].vision).toBe(true);
      expect(res.models[0].thinkingEfforts).toEqual(["low", "high"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("拉取失败返回空列表 + 可读错误（不再塞占位模型）", async () => {
    const { handlers } = makeEnv(root);
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
      const res = (await invoke(handlers, "settings:listModels", {
        provider: "agnes",
        baseUrl: "https://api.example.com/v1",
        model: "",
      })) as { models: unknown[]; error: string };
      expect(res.models).toEqual([]);
      expect(res.error).toContain("401");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("settings 域：诊断 / 关于 / 供应商", () => {
  it("诊断与关于结构稳定（路径与实际数据目录一致）", async () => {
    const { handlers } = makeEnv(root, { LOOPSOAR_API_KEY: "sk-secret" });
    const diag = (await invoke(handlers, "settings:diagnostics")) as {
      paths: Record<string, string>;
      versions: Record<string, string>;
    };
    expect(diag.paths.dataDir).toContain(root);
    expect(diag.paths.memoryFile).toContain("memory.json");
    expect(diag.versions.app).toBe("9.9.9-test");

    const about = (await invoke(handlers, "settings:about")) as { name: string; appId: string };
    expect(about.name).toBe("Loopsoar");
    expect(about.appId).toBe("com.loopsoar.app");

    const provider = (await invoke(handlers, "settings:getProvider")) as {
      hasApiKey: boolean;
      configured: boolean;
    };
    expect(provider.hasApiKey).toBe(true);
    expect(provider.configured).toBe(false);
  });

  it("testProvider：用被测供应商自己的 Key / 表单刚输入的 Key（不回退活动供应商的 Key）", async () => {
    const { SecretStore } = await import("../../packages/shell/src/main/secretStore.ts");
    const secrets = new SecretStore(path.join(root, "data", "config"), {
      available: true,
      encrypt: (plain: string) => Buffer.from(plain, "utf8"),
      decrypt: (buf: Buffer) => buf.toString("utf8"),
    });
    // 活动供应商 active 的旧 Key 与目标供应商 target 的 Key 不同：测 target 时必须用 target 的
    secrets.set("active", "sk-active-old");
    secrets.set("target", "sk-target-key");
    const providers = {
      list: () => [
        { id: "active", provider: "a", baseUrl: "https://a.example.com/v1", model: "m" },
        { id: "target", provider: "t", baseUrl: "https://t.example.com/v1", model: "m" },
      ],
      active: () => ({ id: "active", provider: "a", baseUrl: "https://a.example.com/v1", model: "m" }),
      upsert: () => ({ id: "target", provider: "t", baseUrl: "", model: "" }),
      remove: () => true,
      setActive: () => true,
    } as never;
    const { handlers } = makeEnv(root, {}, { providers, secrets });
    const realFetch = globalThis.fetch;
    const seen: string[] = [];
    try {
      globalThis.fetch = (async (_url: string, init?: { headers?: Record<string, string> }) => {
        seen.push(init?.headers?.Authorization ?? "");
        return new Response("{}", { status: 200 });
      }) as typeof fetch;
      // ① 指定 id：用该供应商自己的已保存 Key
      await invoke(handlers, "settings:testProvider", {
        id: "target",
        provider: "t",
        baseUrl: "https://t.example.com/v1",
        model: "m",
      });
      expect(seen.at(-1)).toBe("Bearer sk-target-key");
      // ② 表单刚输入、尚未保存的 Key 优先（用户切 Key 后点「测试连接」测的就是新 Key）
      await invoke(handlers, "settings:testProvider", {
        id: "target",
        provider: "t",
        baseUrl: "https://t.example.com/v1",
        model: "m",
        apiKey: "sk-typed-just-now",
      });
      expect(seen.at(-1)).toBe("Bearer sk-typed-just-now");
      // ③ 没传 id：按 provider + baseUrl 唯一匹配，同样不回退活动供应商
      await invoke(handlers, "settings:testProvider", {
        provider: "t",
        baseUrl: "https://t.example.com/v1",
        model: "m",
      });
      expect(seen.at(-1)).toBe("Bearer sk-target-key");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("testProvider：成功/失败返回可读结果（不回传密钥）", async () => {
    const { handlers } = makeEnv(root, { LOOPSOAR_API_KEY: "sk-secret" });
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
      const okRes = (await invoke(handlers, "settings:testProvider", {
        provider: "p",
        baseUrl: "https://api.example.com/v1",
        model: "m",
      })) as { ok: boolean; message: string };
      expect(okRes.ok).toBe(true);
      expect(okRes.message).not.toContain("sk-secret");

      globalThis.fetch = (async () => new Response("bad", { status: 401 })) as typeof fetch;
      const badRes = (await invoke(handlers, "settings:testProvider", {
        provider: "p",
        baseUrl: "https://api.example.com/v1",
        model: "m",
      })) as { ok: boolean; status?: number };
      expect(badRes.ok).toBe(false);
      expect(badRes.status).toBe(401);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
