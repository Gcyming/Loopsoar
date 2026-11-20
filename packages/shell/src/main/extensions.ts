/**
 * 扩展宿主（壳层）：扫描 <dataDir>/extensions/<id>/loopsoar.extension.json。
 *
 * 职责边界：
 *   · 发现 / 启停 / 卸载 / 版本记录（本文件）；
 *   · 清单校验、权限交集、注册表在 core/extension（纯逻辑）；
 *   · 兼容性/依赖图/签名认证在 core 的 extensionCompat / extensionGraph / extensionSignature；
 *   · 包摘要与信任库在 extensionTrust（IO 边界）。
 *
 * 关键不变量：
 *   1. 任何 blocked（兼容性/依赖/签名损坏）的扩展都不会被启动或注入提示词；
 *   2. 启用会先启用依赖闭包；禁用/卸载会级联禁用依赖者，并可见上报；
 *   3. 状态文件是「用户意图」，实际 enabled 还要叠加认证与信任策略——
 *      修复依赖/信任后无需用户重新点开关。
 */
import fs from "node:fs";
import path from "node:path";
import {
  EXTENSION_MANIFEST_FILE,
  ExtensionRegistry,
  type ExtensionManifest,
  type InstalledExtension,
} from "loopsoar-core/extension";
import { ExtensionRevocationSchema, type ExtensionRevocation } from "loopsoar-contracts/extensionRegistry";
import { checkExtensionCompatibility, type ExtensionCompatibility } from "loopsoar-core/extensionCompat";
import { dependencyClosure, resolveExtensionGraph } from "loopsoar-core/extensionGraph";
import { certificationFor, type ExtensionCertification, type ExtensionTrustState } from "loopsoar-core/extensionSignature";
import {
  ExtensionTrustStore,
  verifyExtensionPackage,
  type PackageVerification,
} from "./extensionTrust.js";

export interface ExtensionVersionRecord {
  active: string;
  previous?: string;
  source?: string;
  updatedAt?: number;
}

interface ExtensionsState {
  version?: 2;
  enabled: Record<string, boolean>;
  installedAt: Record<string, number>;
  versions?: Record<string, ExtensionVersionRecord>;
}

export interface ExtensionHostOptions {
  trustStore?: ExtensionTrustStore;
  /** 宿主应用版本（engines.loopsoar 的比对对象）。 */
  hostVersion?: string;
  /** 严格引擎约束（市场认证用）。 */
  requireEngine?: boolean;
}

interface Candidate {
  id: string;
  dir: string;
  manifest: ExtensionManifest;
  installedAt: number;
  desiredEnabled: boolean;
}

export class ExtensionHost {
  private registry = new ExtensionRegistry();
  private stateFile: string;
  private revocationsFile: string;
  private revocations: ExtensionRevocation[] = [];
  private trustStore: ExtensionTrustStore;
  private verificationCache = new Map<string, { key: string; result: PackageVerification }>();
  private hostVersion: string;
  private requireEngine: boolean;

  /** 变更钩子（启停/卸载/重扫后触发）：装配层用来同步扩展贡献点（loop/theme）。 */
  onChange?: () => void;
  /** 贡献点快照（由 ExtensionContributions 注入；未装配时为 null）。 */
  contributions?: () => unknown;

  /** 最近一次启停失败原因（domain 读取后清空）。 */
  lastEnableError: string | null = null;
  /** 最近一次启用时自动启用的依赖。 */
  lastAutoEnabled: string[] = [];
  /** 最近一次禁用/卸载时级联禁用的依赖者。 */
  lastCascadeDisabled: string[] = [];

  constructor(
    private dir: string,
    options: ExtensionHostOptions = {},
  ) {
    this.stateFile = path.join(path.dirname(dir), "extensions.json");
    this.revocationsFile = path.join(path.dirname(dir), "extensions-revocations.json");
    this.trustStore = options.trustStore ?? new ExtensionTrustStore(path.join(path.dirname(dir), "extensions-trust.json"));
    this.hostVersion = options.hostVersion ?? "0.1.0";
    this.requireEngine = options.requireEngine ?? false;
    this.loadRevocations();
    this.scan();
  }

  trust(): ExtensionTrustStore {
    return this.trustStore;
  }

  private loadRevocations(): void {
    try {
      if (!fs.existsSync(this.revocationsFile)) return;
      const raw = JSON.parse(fs.readFileSync(this.revocationsFile, "utf8")) as { revocations?: unknown[] };
      const valid: ExtensionRevocation[] = [];
      for (const item of raw.revocations ?? []) {
        const parsed = ExtensionRevocationSchema.safeParse(item);
        if (parsed.success) valid.push(parsed.data);
      }
      this.revocations = valid;
    } catch (err) {
      console.warn(`[Loopsoar] 扩展撤销列表读取失败（按空列表启动）：${err instanceof Error ? err.message : String(err)}`);
      this.revocations = [];
    }
  }

  private writeRevocations(): void {
    try {
      fs.mkdirSync(path.dirname(this.revocationsFile), { recursive: true });
      const tmp = `${this.revocationsFile}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, revocations: this.revocations }, null, 2), "utf8");
      fs.renameSync(tmp, this.revocationsFile);
    } catch (err) {
      console.warn(`[Loopsoar] 扩展撤销列表写入失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 应用市场撤销列表：持久化后立即重扫，命中的已安装扩展变为 blocked。
   * 撤销是单调的（并集）：新目录省略旧条目不能把已撤销版本“复活”。
   * 返回当前生效的撤销条数；列表无变化时不触发重扫。
   */
  applyRevocations(input: readonly unknown[]): number {
    const merged = new Map<string, ExtensionRevocation>();
    for (const entry of this.revocations) {
      merged.set(`${entry.id}@${entry.version ?? "*"}`, entry);
    }
    for (const item of input) {
      const parsed = ExtensionRevocationSchema.safeParse(item);
      if (!parsed.success) continue;
      merged.set(`${parsed.data.id}@${parsed.data.version ?? "*"}`, parsed.data);
    }
    const next = [...merged.values()];
    const previous = JSON.stringify(this.revocations);
    if (JSON.stringify(next) === previous) return next.length;
    this.revocations = next;
    this.writeRevocations();
    this.scan();
    return next.length;
  }

  revocationsList(): ExtensionRevocation[] {
    return [...this.revocations];
  }

  private revocationFor(id: string, version: string): ExtensionRevocation | undefined {
    return this.revocations.find(
      (entry) => entry.id === id && (entry.version === undefined || entry.version === version),
    );
  }

  private readState(): ExtensionsState {
    try {
      if (!fs.existsSync(this.stateFile)) return { version: 2, enabled: {}, installedAt: {}, versions: {} };
      const raw = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as Partial<ExtensionsState>;
      return {
        version: 2,
        enabled: raw.enabled ?? {},
        installedAt: raw.installedAt ?? {},
        versions: raw.versions ?? {},
      };
    } catch {
      return { version: 2, enabled: {}, installedAt: {}, versions: {} };
    }
  }

  private writeState(state: ExtensionsState): void {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const tmp = `${this.stateFile}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify({ ...state, version: 2 }, null, 2), "utf8");
      fs.renameSync(tmp, this.stateFile);
    } catch {
      // 状态写入失败不阻断（下次扫描会重建默认禁用）
    }
  }

  /** 校验结果按 manifest mtime + 清单摘要 + 信任库 revision 缓存，避免每次 list 都重算树摘要。 */
  private verifyPackageCached(dir: string, manifest: ExtensionManifest): PackageVerification {
    const manifestPath = path.join(dir, EXTENSION_MANIFEST_FILE);
    const stat = fs.statSync(manifestPath);
    const key = [
      stat.mtimeMs,
      stat.size,
      manifest.integrity ?? "",
      manifest.signature?.value ?? "",
      this.trustStore.revision,
    ].join(":");
    const cached = this.verificationCache.get(dir);
    if (cached && cached.key === key) return cached.result;
    const result = verifyExtensionPackage(dir, manifest, this.trustStore);
    this.verificationCache.set(dir, { key, result });
    return result;
  }

  /** 扫描扩展目录：坏清单跳过并汇报，不阻塞其它扩展。 */
  scan(): { installed: number; skipped: { dir: string; reason: string }[] } {
    const skipped: { dir: string; reason: string }[] = [];
    const state = this.readState();
    this.registry.clear();
    this.verificationCache.clear();

    const candidates: Candidate[] = [];
    const seen = new Set<string>();
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      for (const name of fs.readdirSync(this.dir)) {
        const full = path.join(this.dir, name);
        try {
          // .staging / .backups 等内部目录不参与扫描（否则安装中的半成品会被当成扩展）。
          if (name.startsWith(".")) continue;
          if (!fs.statSync(full).isDirectory()) continue;
          const manifestPath = path.join(full, EXTENSION_MANIFEST_FILE);
          if (!fs.existsSync(manifestPath)) continue;
          const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
          const manifest = ExtensionRegistry.parseManifest(raw);
          if (seen.has(manifest.id)) {
            skipped.push({ dir: full, reason: `扩展 id 重复（${manifest.id}），已忽略` });
            continue;
          }
          // 入口路径守卫：main 只能是扩展目录内的相对路径（防 `../` / 绝对路径把任意文件当扩展执行）；
          // worker 侧还有一层同样的校验，这里提前跳过并记录原因（坏扩展不进入列表）。
          const main = manifest.main?.trim();
          if (main) {
            const root = path.resolve(full);
            const entry = path.resolve(root, main);
            if (path.isAbsolute(main) || (entry !== root && !entry.startsWith(root + path.sep))) {
              skipped.push({ dir: full, reason: "main 入口必须是扩展目录内的相对路径（不允许绝对路径 / .. 穿越）" });
              continue;
            }
          }
          seen.add(manifest.id);
          const installedAt = state.installedAt[manifest.id] ?? Date.now();
          candidates.push({
            id: manifest.id,
            dir: full,
            manifest,
            installedAt,
            desiredEnabled: state.enabled[manifest.id] ?? false,
          });
          if (!(manifest.id in state.installedAt)) {
            state.installedAt[manifest.id] = installedAt;
            state.enabled[manifest.id] = false;
          }
          if (!state.versions) state.versions = {};
          if (!state.versions[manifest.id]) {
            state.versions[manifest.id] = { active: manifest.version, updatedAt: Date.now() };
          }
        } catch (err) {
          skipped.push({ dir: full, reason: err instanceof Error ? err.message : String(err) });
        }
      }
    } catch (err) {
      skipped.push({ dir: this.dir, reason: err instanceof Error ? err.message : String(err) });
    }

    const graph = resolveExtensionGraph(
      candidates.map((candidate) => ({
        id: candidate.id,
        version: candidate.manifest.version,
        dependencies: candidate.manifest.dependencies,
      })),
    );
    const graphIssues = new Map<string, string[]>();
    for (const issue of graph.issues) {
      const list = graphIssues.get(issue.id) ?? [];
      list.push(issue.message);
      graphIssues.set(issue.id, list);
    }
    const blockedSet = new Set(graph.blocked);

    for (const candidate of candidates) {
      let compatibility: ExtensionCompatibility;
      let trust: ExtensionTrustState;
      try {
        const verification = this.verifyPackageCached(candidate.dir, candidate.manifest);
        trust = verification.trust;
        compatibility = checkExtensionCompatibility(candidate.manifest, {
          hostVersion: this.hostVersion,
          requireEngine: this.requireEngine,
        });
      } catch (err) {
        trust = { status: "invalid", message: err instanceof Error ? err.message : String(err) };
        compatibility = checkExtensionCompatibility(candidate.manifest, {
          hostVersion: this.hostVersion,
          requireEngine: this.requireEngine,
        });
      }

      const directIssues = graphIssues.get(candidate.id) ?? [];
      const dependenciesOk = !blockedSet.has(candidate.id);
      const dependencyIssues = directIssues.length > 0 ? directIssues : dependenciesOk ? [] : ["依赖链上有不可用扩展"];
      const baseCertification: ExtensionCertification = certificationFor(compatibility, trust, dependenciesOk);
      const policyBlocked = this.trustStore.policy() === "strict" && trust.status !== "trusted";
      const revocation = this.revocationFor(candidate.id, candidate.manifest.version);
      // 市场撤销是一票否决：即使签名/兼容性都正常，也不允许再启用或继续运行。
      const certification: ExtensionCertification = revocation ? "blocked" : policyBlocked ? "blocked" : baseCertification;
      const blocked = certification === "blocked";
      const info = {
        compatibility,
        trust,
        certification,
        ...(revocation
          ? {
              revocation: {
                reason: revocation.reason,
                revokedAt: revocation.revokedAt,
                ...(revocation.version ? { version: revocation.version } : {}),
              },
            }
          : {}),
        dependencies: {
          ok: dependenciesOk,
          issues: dependencyIssues,
          dependents: graph.dependents[candidate.id] ?? [],
        },
        ...(state.versions?.[candidate.id]
          ? {
              version: {
                active: state.versions[candidate.id].active,
                ...(state.versions[candidate.id].previous ? { previous: state.versions[candidate.id].previous } : {}),
              },
            }
          : {}),
      };
      const effectiveEnabled = candidate.desiredEnabled && !blocked;
      this.registry.install(candidate.manifest, candidate.dir, effectiveEnabled, candidate.installedAt);
      const installed = this.registry.get(candidate.id);
      if (installed) installed.info = info;
    }

    // 清理已不存在扩展的版本/启用记录，避免状态文件无限增长。
    const ids = new Set(candidates.map((candidate) => candidate.id));
    for (const id of Object.keys(state.enabled)) if (!ids.has(id)) delete state.enabled[id];
    for (const id of Object.keys(state.installedAt)) if (!ids.has(id)) delete state.installedAt[id];
    for (const id of Object.keys(state.versions ?? {})) if (!ids.has(id)) delete state.versions![id];

    this.writeState(state);
    this.onChange?.();
    return { installed: candidates.length, skipped };
  }

  list(): InstalledExtension[] {
    return this.registry.list();
  }

  /**
   * 启停（带依赖语义）：
   *   · 启用：先做全量预检，再按拓扑序自动启用依赖闭包；
   *   · 禁用：递归禁用所有依赖此扩展且已启用的扩展；
   *   · 任何失败都写 lastEnableError 且不改状态（除已完成的级联，可回滚）。
   */
  setEnabled(id: string, enabled: boolean): InstalledExtension | null {
    this.lastEnableError = null;
    this.lastAutoEnabled = [];
    this.lastCascadeDisabled = [];
    const item = this.registry.get(id);
    if (!item) {
      this.lastEnableError = `扩展不存在：${id}`;
      return null;
    }
    const state = this.readState();

    if (enabled) {
      if (item.info?.certification === "blocked") {
        const reasons = [
          ...(item.info.revocation ? [`已被市场撤销：${item.info.revocation.reason}`] : []),
          ...item.info.compatibility.issues.filter((issue) => issue.level === "error").map((issue) => issue.message),
          ...item.info.dependencies.issues,
          ...(item.info.trust.status === "invalid" ? [item.info.trust.message ?? "签名/摘要无效"] : []),
          ...(this.trustStore.policy() === "strict" && item.info.trust.status !== "trusted"
            ? ["严格信任策略：扩展未使用已信任的签名"]
            : []),
        ];
        this.lastEnableError = `扩展被阻断：${reasons.join("；") || "认证未通过"}`;
        return null;
      }
      if (this.trustStore.policy() === "strict" && item.info?.trust.status !== "trusted") {
        this.lastEnableError = "严格信任策略：扩展未使用已信任的签名，拒绝启用";
        return null;
      }

      const nodes = this.list().map((entry) => ({
        id: entry.manifest.id,
        version: entry.manifest.version,
        dependencies: entry.manifest.dependencies,
      }));
      const graph = resolveExtensionGraph(nodes);
      if (graph.blocked.includes(id)) {
        const issues = graph.issues.filter((issue) => issue.id === id).map((issue) => issue.message);
        this.lastEnableError = `依赖不满足：${issues.join("；") || "依赖链上有不可用扩展"}`;
        return null;
      }
      const closure = dependencyClosure(id, graph, nodes);
      for (const depId of closure) {
        const dep = this.registry.get(depId);
        if (!dep) {
          this.lastEnableError = `缺少依赖：${depId}`;
          return null;
        }
        if (dep.info?.certification === "blocked") {
          this.lastEnableError = `依赖 ${depId} 被阻断，无法启用`;
          return null;
        }
        if (this.trustStore.policy() === "strict" && dep.info?.trust.status !== "trusted") {
          this.lastEnableError = `严格信任策略：依赖 ${depId} 未受信任`;
          return null;
        }
      }
      for (const depId of closure) {
        if (!this.registry.get(depId)?.enabled) {
          this.registry.setEnabled(depId, true);
          state.enabled[depId] = true;
          if (depId !== id) this.lastAutoEnabled.push(depId);
        }
      }
      this.registry.setEnabled(id, true);
      state.enabled[id] = true;
    } else {
      const nodes = this.list().map((entry) => ({
        id: entry.manifest.id,
        version: entry.manifest.version,
        dependencies: entry.manifest.dependencies,
      }));
      const graph = resolveExtensionGraph(nodes);
      const cascade: string[] = [];
      const collect = (target: string): void => {
        for (const dependent of graph.dependents[target] ?? []) {
          if (dependent === id || cascade.includes(dependent)) continue;
          if (this.registry.get(dependent)?.enabled) {
            cascade.push(dependent);
            collect(dependent);
          }
        }
      };
      collect(id);
      for (const dependent of cascade) {
        this.registry.setEnabled(dependent, false);
        state.enabled[dependent] = false;
        this.lastCascadeDisabled.push(dependent);
      }
      this.registry.setEnabled(id, false);
      state.enabled[id] = false;
    }

    this.writeState(state);
    this.onChange?.();
    return this.registry.get(id) ?? null;
  }

  /**
   * 安装/更新后写入版本记录。previous 用于回滚展示；activate 为空时沿用现有启用意图。
   */
  recordInstall(
    id: string,
    version: string,
    options: { source?: string; previous?: string; activate?: boolean } = {},
  ): void {
    const state = this.readState();
    const current = state.versions?.[id];
    if (!state.versions) state.versions = {};
    state.versions[id] = {
      active: version,
      ...(options.previous ?? current?.active ? { previous: options.previous ?? current?.active } : {}),
      ...(options.source ?? current?.source ? { source: options.source ?? current?.source } : {}),
      updatedAt: Date.now(),
    };
    state.installedAt[id] = state.installedAt[id] ?? Date.now();
    if (options.activate !== undefined) state.enabled[id] = options.activate;
    this.writeState(state);
  }

  versionInfo(id: string): ExtensionVersionRecord | undefined {
    return this.readState().versions?.[id];
  }

  /** 卸载：级联禁用依赖者 → 注销 → 删除扩展子目录（仅限扩展目录内）。 */
  remove(id: string): boolean {
    const item = this.registry.get(id);
    if (!item) {
      this.lastEnableError = `扩展不存在：${id}`;
      return false;
    }
    const target = path.resolve(item.dir);
    const root = path.resolve(this.dir);
    if (!target.startsWith(root + path.sep)) {
      this.lastEnableError = "拒绝卸载扩展目录之外的路径";
      return false;
    }
    this.lastAutoEnabled = [];
    this.lastCascadeDisabled = [];
    const nodes = this.list().map((entry) => ({
      id: entry.manifest.id,
      version: entry.manifest.version,
      dependencies: entry.manifest.dependencies,
    }));
    const graph = resolveExtensionGraph(nodes);
    const cascade: string[] = [];
    const collect = (targetId: string): void => {
      for (const dependent of graph.dependents[targetId] ?? []) {
        if (dependent === id || cascade.includes(dependent)) continue;
        if (this.registry.get(dependent)?.enabled) {
          cascade.push(dependent);
          collect(dependent);
        }
      }
    };
    collect(id);
    const state = this.readState();
    for (const dependent of cascade) {
      this.registry.setEnabled(dependent, false);
      state.enabled[dependent] = false;
      this.lastCascadeDisabled.push(dependent);
    }
    this.registry.remove(id);
    delete state.enabled[id];
    delete state.installedAt[id];
    if (state.versions) delete state.versions[id];
    this.writeState(state);
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch (err) {
      this.lastEnableError = `扩展已注销，但目录删除失败：${err instanceof Error ? err.message : String(err)}`;
      this.onChange?.();
      return false;
    }
    this.onChange?.();
    return true;
  }

  /** 重新认证（设置页“重新校验”）：清缓存并重扫。 */
  verify(id: string): InstalledExtension | null {
    this.verificationCache.delete(this.registry.get(id)?.dir ?? "");
    this.scan();
    return this.registry.get(id) ?? null;
  }

  dirPath(): string {
    return this.dir;
  }

  hostVersionValue(): string {
    return this.hostVersion;
  }

  /** 启用意图（状态文件里的值；用于安装后保持原开关）。 */
  isEnabledIntent(id: string): boolean {
    return this.readState().enabled[id] ?? false;
  }

  promptSummary(): string {
    return this.registry.promptSummary();
  }

  instructionsPrompt(): string {
    return this.registry.instructionsPrompt();
  }
}
