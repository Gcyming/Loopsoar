/**
 * 迁移与兼容（架构稳固性维度缺口 3/3）。
 *
 * 为什么把「旧数据能不能读」当成架构问题：用户升级是不可逆的，任何一次「新版读不懂旧盘」
 * 都会表现为「设置全丢 / 标签全没 / 扩展全挂」。这类故障在开发机上永远看不到，因为
 * 开发机的数据总是最新的。
 *
 * 本文件钉住三类契约：
 *   ① 磁盘格式向后兼容：旧字段值被迁移，缺失字段补默认值，未知字段不炸；
 *   ② 脏数据逐条净化：单条坏记录不能带走整份数据；
 *   ③ 插件 API 版本协商：没有 apiVersion 的老扩展按 1.0.0 对待（工具可用、富能力不可用），
 *      而不是被当成「当前版本」全量放行。
 */
import { describe, expect, it } from "vitest";
import { mergePermissions } from "../../packages/core/src/permissions.ts";
import { mergePreferences, DEFAULT_PREFERENCES } from "../../packages/core/src/preferences.ts";
import {
  EXTENSION_HOST_API_VERSION,
  EXTENSION_LEGACY_API_VERSION,
  ExtensionManifestSchema,
} from "../../packages/contracts/src/extension.ts";
import { checkExtensionCompatibility } from "../../packages/core/src/extensionCompat.ts";
import { sanitizeBrowserState, MAX_PERSISTED_TABS } from "../../packages/shell/src/main/browserSessionState.ts";

describe("迁移：偏好文件的历史值", () => {
  it("已下线的搜索引擎 duckduckgo → 回到当前默认（不让整份偏好判非法）", () => {
    const prefs = mergePreferences({ searchEngine: "duckduckgo" });
    expect(prefs.searchEngine).toBe(DEFAULT_PREFERENCES.searchEngine);
    expect(prefs.searchEngine).not.toBe("duckduckgo");
  });

  it("sidebarMode=float（旧持久化值）→ docked", () => {
    expect(mergePreferences({ sidebarMode: "float" }).sidebarMode).toBe("docked");
  });

  it("browserOpenLayout=ask（已下线策略）→ docked", () => {
    expect(mergePreferences({ browserOpenLayout: "ask" }).browserOpenLayout).toBe("docked");
  });

  it("agentMaxRounds 旧默认 40 → 80（长任务不再频繁触发轮次闸）", () => {
    expect(mergePreferences({ agentMaxRounds: 40 }).agentMaxRounds).toBe(80);
    // 用户显式设过的值必须保留
    expect(mergePreferences({ agentMaxRounds: 25 }).agentMaxRounds).toBe(25);
  });

  it("空文件 / null → 完整默认值（每个字段都有值）", () => {
    for (const raw of [{}, null, undefined]) {
      const prefs = mergePreferences(raw);
      expect(prefs.downloadDir).toBe("");
      expect(prefs.workspaceRoot).toBe("");
      expect(prefs.memoryStorePath).toBe("");
      expect(prefs.language).toBeTruthy();
    }
  });
});

describe("迁移：权限文件", () => {
  it("workspaceRoots 去重、去空、保序", () => {
    const perms = mergePermissions({ workspaceRoots: [" /a ", "/b", "/a", "  ", "/c"] });
    expect(perms.workspaceRoots).toEqual(["/a", "/b", "/c"]);
  });

  it("缺失类别补默认值，非法类别整份拒绝（保存路径必须严格）", () => {
    expect(mergePermissions({}).read).toBeTruthy();
    expect(() => mergePermissions({ read: "nope" })).toThrow();
  });
});

describe("迁移：标签状态（旧版没有 history/index/agentBound）", () => {
  it("旧标签只有 url+title → 补出单元素历史与末位 index", () => {
    const state = sanitizeBrowserState({
      tabs: [{ url: "https://example.com/a", title: "A" }],
      activeIndex: 0,
    });
    expect(state?.tabs[0]).toEqual({
      url: "https://example.com/a",
      title: "A",
      history: ["https://example.com/a"],
      index: 0,
    });
  });

  it("未知字段被丢弃、agentBound 保留（折叠工作区重启不丢）", () => {
    const state = sanitizeBrowserState({
      tabs: [{ url: "https://example.com/a", agentBound: true, somethingNew: 1 }],
      activeIndex: 0,
    });
    expect(state?.tabs[0]?.agentBound).toBe(true);
    expect(Object.keys(state!.tabs[0]!)).not.toContain("somethingNew");
  });

  it("单条坏记录被丢弃，好记录仍然保留（不能整份拒绝）", () => {
    const state = sanitizeBrowserState({
      tabs: [
        { url: "javascript:alert(1)" },
        { url: "file:///etc/passwd" },
        { url: "https://example.com/ok" },
      ],
      activeIndex: 2,
    });
    expect(state?.tabs.length).toBe(1);
    expect(state?.tabs[0]?.url).toBe("https://example.com/ok");
  });

  it("历史栈被截断到上限，index 被夹进合法区间", () => {
    const history = Array.from({ length: 80 }, (_, i) => `https://example.com/${i}`);
    const state = sanitizeBrowserState({
      tabs: [{ url: "https://example.com/79", history, index: 999 }],
      activeIndex: 0,
    });
    const tab = state!.tabs[0]!;
    expect(tab.index).toBe((tab.history?.length ?? 1) - 1);
    expect(tab.index).toBeLessThan(999);
  });

  it("标签数量截断到上限", () => {
    const tabs = Array.from({ length: MAX_PERSISTED_TABS + 5 }, (_, i) => ({ url: `https://example.com/${i}` }));
    expect(sanitizeBrowserState({ tabs, activeIndex: 0 })?.tabs.length).toBe(MAX_PERSISTED_TABS);
  });

  it("结构完全不对 → null（调用方按「没有可恢复状态」处理）", () => {
    expect(sanitizeBrowserState(null)).toBeNull();
    expect(sanitizeBrowserState({ tabs: "nope" })).toBeNull();
    expect(sanitizeBrowserState({ tabs: [] })).toBeNull();
  });
});

describe("迁移：插件 API 版本协商", () => {
  it("没有 apiVersion 的老扩展按 1.0.0 解析（工具桥仍可用）", () => {
    const manifest = ExtensionManifestSchema.parse({ id: "legacy", name: "Legacy", version: "1.0.0" });
    expect(manifest.apiVersion).toBe(EXTENSION_LEGACY_API_VERSION);

    const report = checkExtensionCompatibility(manifest);
    expect(report.legacyApi).toBe(true);
    expect(report.apiVersion).toBe(EXTENSION_LEGACY_API_VERSION);
    // 老扩展不整份拒绝：给警告，让用户知道富能力不可用
    expect(report.status).toBe("compatible-with-warnings");
    expect(report.errors).toBe(0);
  });

  it("声明了当前 API 版本 → compatible", () => {
    const manifest = ExtensionManifestSchema.parse({
      id: "modern",
      name: "Modern",
      version: "1.0.0",
      apiVersion: EXTENSION_HOST_API_VERSION,
      engines: { loopsoar: ">=0.1.0" },
    });
    expect(checkExtensionCompatibility(manifest, { hostVersion: "0.1.0" }).status).toBe("compatible");
  });

  it("声明了更新的 API 大版本 → blocked（不猜、不放行）", () => {
    const manifest = ExtensionManifestSchema.parse({
      id: "future",
      name: "Future",
      version: "1.0.0",
      apiVersion: "3.0.0",
    });
    expect(checkExtensionCompatibility(manifest).status).toBe("blocked");
  });

  it("engines 要求更高宿主版本 → blocked（升级方向被明确挡住）", () => {
    const manifest = ExtensionManifestSchema.parse({
      id: "picky",
      name: "Picky",
      version: "1.0.0",
      apiVersion: EXTENSION_HOST_API_VERSION,
      engines: { loopsoar: ">=9.0.0" },
    });
    expect(checkExtensionCompatibility(manifest, { hostVersion: "0.4.0" }).status).toBe("blocked");
  });
});
