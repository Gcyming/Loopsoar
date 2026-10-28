/**
 * 扩展宿主（壳层）：扫描 <dataDir>/extensions/<id>/loopsoar.extension.json。
 * - 只做「发现 / 启停 / 卸载」；清单校验与注册表在 core/extension（纯逻辑）。
 * - 状态落盘 <dataDir>/extensions.json（启用状态 + 安装时间）。
 * - 卸载只接受位于扩展目录内的子目录（防路径穿越）。
 */
import fs from "node:fs";
import path from "node:path";
import {
  EXTENSION_MANIFEST_FILE,
  ExtensionRegistry,
  type InstalledExtension,
} from "loopsoar-core/extension";

interface ExtensionsState {
  enabled: Record<string, boolean>;
  installedAt: Record<string, number>;
}

export class ExtensionHost {
  private registry = new ExtensionRegistry();
  private stateFile: string;

  constructor(private dir: string) {
    this.stateFile = path.join(path.dirname(dir), "extensions.json");
    this.scan();
  }

  private readState(): ExtensionsState {
    try {
      if (!fs.existsSync(this.stateFile)) return { enabled: {}, installedAt: {} };
      const raw = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as Partial<ExtensionsState>;
      return { enabled: raw.enabled ?? {}, installedAt: raw.installedAt ?? {} };
    } catch {
      return { enabled: {}, installedAt: {} };
    }
  }

  private writeState(state: ExtensionsState): void {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2), "utf8");
    } catch {
      // 状态写入失败不阻断（下次扫描会重建默认禁用）
    }
  }

  /** 扫描扩展目录：坏清单跳过并汇报，不阻塞其它扩展。 */
  scan(): { installed: number; skipped: { dir: string; reason: string }[] } {
    const skipped: { dir: string; reason: string }[] = [];
    const state = this.readState();
    this.registry.clear();
    const seen = new Set<string>();
    let installed = 0;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      for (const name of fs.readdirSync(this.dir)) {
        const full = path.join(this.dir, name);
        try {
          if (!fs.statSync(full).isDirectory()) continue;
          const manifestPath = path.join(full, EXTENSION_MANIFEST_FILE);
          if (!fs.existsSync(manifestPath)) continue;
          const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
          const manifest = ExtensionRegistry.parseManifest(raw);
          if (seen.has(manifest.id)) {
            skipped.push({ dir: full, reason: `扩展 id 重复（${manifest.id}），已忽略` });
            continue;
          }
          seen.add(manifest.id);
          const enabled = state.enabled[manifest.id] ?? false;
          const installedAt = state.installedAt[manifest.id] ?? Date.now();
          this.registry.install(manifest, full, enabled, installedAt);
          if (!(manifest.id in state.installedAt)) {
            state.installedAt[manifest.id] = installedAt;
            state.enabled[manifest.id] = enabled;
          }
          installed += 1;
        } catch (err) {
          skipped.push({ dir: full, reason: err instanceof Error ? err.message : String(err) });
        }
      }
    } catch (err) {
      skipped.push({ dir: this.dir, reason: err instanceof Error ? err.message : String(err) });
    }
    this.writeState(state);
    return { installed, skipped };
  }

  list(): InstalledExtension[] {
    return this.registry.list();
  }

  setEnabled(id: string, enabled: boolean): InstalledExtension | null {
    const item = this.registry.setEnabled(id, enabled);
    if (!item) return null;
    const state = this.readState();
    state.enabled[id] = enabled;
    this.writeState(state);
    return item;
  }

  /** 卸载：注销 + 删除扩展子目录（仅限扩展目录内）。 */
  remove(id: string): boolean {
    const item = this.registry.get(id);
    if (!item) return false;
    const target = path.resolve(item.dir);
    const root = path.resolve(this.dir);
    if (!target.startsWith(root + path.sep)) return false;
    this.registry.remove(id);
    const state = this.readState();
    delete state.enabled[id];
    delete state.installedAt[id];
    this.writeState(state);
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch {
      return false;
    }
    return true;
  }

  dirPath(): string {
    return this.dir;
  }

  promptSummary(): string {
    return this.registry.promptSummary();
  }
}
