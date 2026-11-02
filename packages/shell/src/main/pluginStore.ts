/**
 * 插件存储（壳层，ADR-0011「万物皆插件」）：发现 + 启用状态持久化。
 *
 * 目录约定：
 *   <dataDir>/plugins/<id>/plugin.json   插件清单（内核只认这个文件名）
 *   <dataDir>/plugins.json               { version: 1, enabled: { <id>: boolean } }
 *
 * 设计要点（为什么这样写）：
 *  - 清单校验复用 core/plugin 的 validateManifest（唯一判据，壳层不重复实现规则）；
 *    坏清单只跳过该插件并记原因，不阻断其它插件/应用启动（与 extensions 一致）。
 *  - 用户插件默认禁用（第三方代码 opt-in）；启用状态落盘，重启保持。
 *  - builtin/系统插件（origin=builtin，由装配层注入清单）只读：不可停用、不可卸载，
 *    作为「系统根」常驻列表，让用户看得见内核能力边界。
 *  - main 入口只接受插件目录内的相对路径（防 `../` 逃逸到任意文件被执行）。
 */
import fs from "node:fs";
import path from "node:path";
import { validateManifest, type PluginManifest } from "loopsoar-core/plugin";

/** 插件清单文件名（唯一产地，runtime/index 共用）。 */
export const PLUGIN_MANIFEST_FILE = "plugin.json";
/** 启用状态文件名（位于 dataDir 根，与 sessions/ 等同级）。 */
export const PLUGIN_STATE_FILE = "plugins.json";
/** 插件数量上限：防 plugins 目录被塞爆导致启动扫描/UI 列表失控。 */
export const MAX_PLUGINS = 100;
/** 单个插件目录内入口文件的相对路径长度上限。 */
const MAX_MAIN_LENGTH = 300;

export interface PluginEntry {
  /** 插件 id（= manifest.name；全局唯一）。 */
  id: string;
  manifest: PluginManifest;
  /** 插件目录绝对路径（builtin 注入项为空字符串）。 */
  dir: string;
  /** 入口文件（相对插件目录）；null = 纯声明式插件（无子进程）。 */
  main: string | null;
  enabled: boolean;
  /** 系统根：只读（不可停用/卸载）。 */
  builtin: boolean;
}

export interface PluginSkip {
  /** 出问题的插件目录（builtin 非法时为 "(builtin)"）。 */
  dir: string;
  reason: string;
}

interface PluginStateFile {
  version: 1;
  enabled: Record<string, boolean>;
}

export interface PluginStoreOptions {
  /**
   * 内置/系统插件清单（origin=builtin）。由装配层（index）注入内核能力清单；
   * 缺省空数组——内核不把自己硬编码成插件，避免「系统根清单」散落在壳层。
   */
  builtins?: PluginManifest[];
  /** 插件数量上限覆盖（测试用；默认 100）。 */
  maxPlugins?: number;
}

export interface PluginScanResult {
  plugins: number;
  skipped: PluginSkip[];
}

export class PluginStore {
  private dir: string;
  private stateFile: string;
  private entries = new Map<string, PluginEntry>();
  private skipped: PluginSkip[] = [];
  private readonly builtins: PluginManifest[];
  private readonly maxPlugins: number;

  constructor(dataDir: string, opts: PluginStoreOptions = {}) {
    this.dir = path.join(dataDir, "plugins");
    this.stateFile = path.join(dataDir, PLUGIN_STATE_FILE);
    this.builtins = Array.isArray(opts.builtins) ? opts.builtins : [];
    this.maxPlugins =
      typeof opts.maxPlugins === "number" && Number.isFinite(opts.maxPlugins) && opts.maxPlugins > 0
        ? Math.floor(opts.maxPlugins)
        : MAX_PLUGINS;
    this.scan();
  }

  /** 插件目录绝对路径（UI/诊断「打开插件目录」用；index 注入 shell.openPath）。 */
  dirPath(): string {
    return this.dir;
  }

  /** 当前扫描到的插件（builtin 在前，其余按名称排序）。 */
  list(): PluginEntry[] {
    return [...this.entries.values()].sort((a, b) => {
      if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
      return a.manifest.name.localeCompare(b.manifest.name);
    });
  }

  get(id: string): PluginEntry | null {
    return this.entries.get(id) ?? null;
  }

  /** 最近一次扫描被跳过的坏清单（供 UI 展示原因 / 诊断）。 */
  listSkipped(): PluginSkip[] {
    return this.skipped.map((item) => ({ ...item }));
  }

  /**
   * 启用/停用插件。
   * builtin 为系统根 → 只读拒绝（fail-closed，不做「可禁用」的模糊语义）。
   */
  setEnabled(id: string, enabled: boolean): { ok: true; entry: PluginEntry } | { ok: false; error: string } {
    const entry = this.entries.get(id);
    if (!entry) return { ok: false, error: `插件不存在：${id}` };
    if (entry.builtin) return { ok: false, error: `插件 ${id} 是内置系统插件（只读，不可停用）` };
    entry.enabled = enabled;
    const state = this.readState();
    state.enabled[id] = enabled;
    this.writeState(state);
    return { ok: true, entry };
  }

  /** 重新扫描插件目录（保留启用状态；坏清单只记录不抛）。 */
  reload(): PluginScanResult {
    this.scan();
    return { plugins: this.entries.size, skipped: this.listSkipped() };
  }

  /** 扫描：builtin 注入项 + `<dir>/<id>/plugin.json`；单插件失败不影响其它插件。 */
  private scan(): void {
    this.entries.clear();
    this.skipped = [];
    const state = this.readState();

    // ① 内置系统插件（清单由装配层注入；非法内置项同样只跳过并记原因）
    for (const manifest of this.builtins) {
      const errors = validateManifest(manifest);
      if (errors.length > 0) {
        this.skipped.push({ dir: "(builtin)", reason: `内置插件 ${String((manifest as Partial<PluginManifest>)?.name ?? "?")} 清单非法：${errors.join("；")}` });
        continue;
      }
      if (this.entries.has(manifest.name)) {
        this.skipped.push({ dir: "(builtin)", reason: `内置插件 id 重复：${manifest.name}` });
        continue;
      }
      this.entries.set(manifest.name, {
        id: manifest.name,
        manifest,
        dir: "",
        main: null,
        // builtin 默认常开且只读（系统根）；状态文件不参与控制
        enabled: true,
        builtin: true,
      });
    }

    // ② 用户插件目录
    let scanned = 0;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const names = fs.readdirSync(this.dir).sort();
      for (const name of names) {
        if (scanned >= this.maxPlugins) {
          this.skipped.push({ dir: path.join(this.dir, name), reason: `插件数量超过上限 ${this.maxPlugins}，已忽略` });
          continue;
        }
        const full = path.join(this.dir, name);
        try {
          if (!fs.statSync(full).isDirectory()) continue;
          const manifestPath = path.join(full, PLUGIN_MANIFEST_FILE);
          if (!fs.existsSync(manifestPath)) continue; // 目录里没有清单：不是插件，静默跳过
          const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            this.skipped.push({ dir: full, reason: "plugin.json 必须是对象" });
            continue;
          }
          const record = raw as Record<string, unknown>;
          if (typeof record.name !== "string" || typeof record.version !== "string") {
            this.skipped.push({ dir: full, reason: "清单缺少字符串 name/version" });
            continue;
          }
          const manifest = record as unknown as PluginManifest;
          const errors = validateManifest(manifest);
          if (errors.length > 0) {
            this.skipped.push({ dir: full, reason: `清单校验失败：${errors.join("；")}` });
            continue;
          }
          if (this.entries.has(manifest.name)) {
            this.skipped.push({ dir: full, reason: `插件 id 重复（${manifest.name}），已忽略` });
            continue;
          }
          const main = this.safeMain(full, record.main);
          if (main === false) {
            this.skipped.push({ dir: full, reason: "main 入口必须是插件目录内的相对路径（不允许绝对路径/.. 穿越）" });
            continue;
          }
          const enabled = state.enabled[manifest.name] ?? false;
          this.entries.set(manifest.name, { id: manifest.name, manifest, dir: full, main, enabled, builtin: false });
          scanned += 1;
          // 新发现的插件写入默认启用状态（重启后状态稳定；卸载后重装仍记忆上次选择）
          if (!(manifest.name in state.enabled)) state.enabled[manifest.name] = enabled;
        } catch (err) {
          this.skipped.push({ dir: full, reason: err instanceof Error ? err.message : String(err) });
        }
      }
    } catch (err) {
      this.skipped.push({ dir: this.dir, reason: err instanceof Error ? err.message : String(err) });
    }
    this.writeState(state);
  }

  /** 校验 main：缺省/空 = 纯声明式；非法返回 false（调用方跳过插件）。 */
  private safeMain(pluginDir: string, raw: unknown): string | null | false {
    if (raw === undefined || raw === null || raw === "") return null;
    if (typeof raw !== "string") return false;
    const main = raw.trim();
    if (!main || main.length > MAX_MAIN_LENGTH) return false;
    if (path.isAbsolute(main)) return false;
    const root = path.resolve(pluginDir);
    const target = path.resolve(root, main);
    if (target !== root && !target.startsWith(root + path.sep)) return false;
    return main;
  }

  private readState(): PluginStateFile {
    try {
      if (!fs.existsSync(this.stateFile)) return { version: 1, enabled: {} };
      const raw = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as Partial<PluginStateFile>;
      const enabled: Record<string, boolean> = {};
      if (raw && typeof raw === "object" && raw.enabled && typeof raw.enabled === "object") {
        for (const [id, value] of Object.entries(raw.enabled)) {
          if (typeof value === "boolean") enabled[id] = value;
        }
      }
      return { version: 1, enabled };
    } catch {
      // 状态文件损坏 → 以「全部默认」启动（用户插件禁用），下次 setEnabled 会原子重写
      return { version: 1, enabled: {} };
    }
  }

  /** 原子写状态：tmp + rename；失败吞掉（插件启停不因状态落盘失败而崩）。 */
  private writeState(state: PluginStateFile): void {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const tmp = `${this.stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
      fs.renameSync(tmp, this.stateFile);
    } catch {
      // 写失败：本次会话内的启用状态仍生效，下次操作重试
    }
  }
}
