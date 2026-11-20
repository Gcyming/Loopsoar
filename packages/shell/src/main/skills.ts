/**
 * 技能宿主（壳层）：扫描 <dataDir>/skills/<id>/SKILL.md，启停状态存 <dataDir>/skills.json。
 * 与扩展（extensions/）、MCP（mcp.json）完全独立目录与状态文件。
 */
import fs from "node:fs";
import path from "node:path";
import { SKILL_FILE_NAME, SKILL_MAX_BYTES, SkillRegistry, type SkillRecord } from "loopsoar-core/skill";

interface SkillsState {
  enabled: Record<string, boolean>;
}

/** 技能资源包导入上限：防止一次导入把磁盘/扫描时间拖垮。 */
const IMPORT_MAX_FILES = 300;
const IMPORT_MAX_BYTES = 12 * 1024 * 1024;
const IMPORT_MAX_DEPTH = 12;

export interface SkillImportResult {
  ok: boolean;
  id?: string;
  target?: string;
  files?: number;
  bytes?: number;
  warnings?: string[];
  skipped?: string[];
  error?: string;
}

export interface CandidateInput {
  name: string;
  description: string;
  whenToUse?: string;
  body: string;
  tags?: string[];
}

function candidateBase(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "candidate"
  );
}

function isInside(root: string, target: string): boolean {
  return target !== root && target.startsWith(`${root}${path.sep}`);
}

export class SkillHost {
  private registry = new SkillRegistry();
  private stateFile: string;
  private watcher: fs.FSWatcher | null = null;
  private watchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private dir: string) {
    this.stateFile = path.join(path.dirname(dir), "skills.json");
    this.scan();
  }

  /**
   * 监听技能目录，外部编辑 SKILL.md 后自动重扫。
   * 不监听的话，Agent 在会话中生成的候选/用户手改的规则要重启应用才生效，
   * 与 loop 热更新不一致（loop 走 registry 重新加载）。
   */
  watch(onChange?: (installed: number) => void): void {
    if (this.watcher) return;
    const rescan = (): void => {
      if (this.watchTimer) clearTimeout(this.watchTimer);
      this.watchTimer = setTimeout(() => {
        this.watchTimer = null;
        try {
          const result = this.scan();
          onChange?.(result.installed);
        } catch {
          // 扫描失败保留上一次可用快照
        }
      }, 300);
      this.watchTimer.unref?.();
    };
    try {
      this.watcher = fs.watch(this.dir, { recursive: true }, rescan);
    } catch {
      try {
        this.watcher = fs.watch(this.dir, rescan);
      } catch {
        this.watcher = null;
        return;
      }
    }
    this.watcher.on("error", () => {
      this.watcher?.close();
      this.watcher = null;
    });
  }

  dispose(): void {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = null;
    this.watcher?.close();
    this.watcher = null;
  }

  private readState(): SkillsState {
    try {
      if (!fs.existsSync(this.stateFile)) return { enabled: {} };
      const raw = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as Partial<SkillsState>;
      return { enabled: raw.enabled ?? {} };
    } catch {
      return { enabled: {} };
    }
  }

  private writeState(state: SkillsState): void {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2), "utf8");
    } catch {
      // 忽略：下次扫描按默认启用
    }
  }

  scan(): { installed: number; skipped: { dir: string; reason: string }[] } {
    const skipped: { dir: string; reason: string }[] = [];
    const state = this.readState();
    this.registry.clear();
    let installed = 0;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      for (const name of fs.readdirSync(this.dir)) {
        const full = path.join(this.dir, name);
        // 跳过导入临时目录 / 隐藏目录：半成品不该被当成技能安装。
        if (name.startsWith(".")) continue;
        try {
          if (!fs.statSync(full).isDirectory()) continue;
          const file = path.join(full, SKILL_FILE_NAME);
          if (!fs.existsSync(file)) continue;
          const stat = fs.statSync(file);
          const bytes = stat.size;
          let raw: string;
          let truncatedBytes = 0;
          if (bytes > SKILL_MAX_BYTES) {
            // 超长技能：只读取前 SKILL_MAX_BYTES 字节（按 UTF-8 安全截断），仍然安装并可用
            const fd = fs.openSync(file, "r");
            try {
              const buffer = Buffer.allocUnsafe(SKILL_MAX_BYTES);
              const read = fs.readSync(fd, buffer, 0, SKILL_MAX_BYTES, 0);
              raw = buffer.subarray(0, read).toString("utf8");
            } finally {
              fs.closeSync(fd);
            }
            truncatedBytes = bytes - SKILL_MAX_BYTES;
          } else {
            raw = fs.readFileSync(file, "utf8");
          }
          const parsed = SkillRegistry.parseMarkdown(raw, name);
          if (truncatedBytes > 0) {
            parsed.warnings.push(
              `SKILL.md 过大（${bytes} 字节），已读取前 ${SKILL_MAX_BYTES} 字节（${truncatedBytes} 字节未载入；可用 file_read 读取原文件）`,
            );
          }
          this.registry.install(name, file, parsed, undefined, state.enabled[name] ?? true);
          if (!(name in state.enabled)) {
            state.enabled[name] = true;
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

  list(): SkillRecord[] {
    return this.registry.list();
  }

  setEnabled(id: string, enabled: boolean): SkillRecord | null {
    const item = this.registry.setEnabled(id, enabled);
    if (!item) return null;
    const state = this.readState();
    state.enabled[id] = enabled;
    this.writeState(state);
    return item;
  }

  /**
   * 生成候选技能：写入 skills/<id>/SKILL.md，并在 skills.json 里默认禁用。
   * 候选不会进入提示词注入，直到用户在设置·技能里启用——避免 Agent 自动“学会”未审阅的流程。
   */
  createCandidate(input: CandidateInput): SkillRecord | null {
    const base = candidateBase(input.name);
    let id = base;
    let suffix = 2;
    while (fs.existsSync(path.join(this.dir, id))) id = `${base}-${suffix++}`;
    this.writeCandidate(id, input);
    return this.registry.list().find((item) => item.id === id) ?? null;
  }

  /**
   * 修订候选：只允许未启用候选，保留 id，写回后仍禁用。
   * 已启用的技能拒绝自动改写，避免 Agent 改掉用户正在使用的规则。
   */
  replaceCandidate(id: string, input: CandidateInput): SkillRecord | null {
    const existing = this.registry.get(id);
    if (!existing || existing.enabled) return null;
    const tags = existing.frontmatter.tags ?? [];
    // 只允许改由 skill_candidate 生成的草稿；普通禁用技能不是候选，不能被 Agent 覆盖。
    if (!tags.includes("candidate") && !tags.includes("auto-candidate")) return null;
    const target = path.resolve(this.dir, id);
    if (!isInside(path.resolve(this.dir), target)) return null;
    this.writeCandidate(id, input);
    return this.registry.list().find((item) => item.id === id) ?? null;
  }

  /** 删除候选：只允许 skill_candidate 生成且未启用的草稿；防止误删普通技能或越界路径。 */
  remove(id: string): boolean {
    const existing = this.registry.get(id);
    if (!existing || existing.enabled) return false;
    const tags = existing.frontmatter.tags ?? [];
    if (!tags.includes("candidate") && !tags.includes("auto-candidate")) return false;
    const root = path.resolve(this.dir);
    const target = path.resolve(root, id);
    if (!isInside(root, target)) return false;
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch {
      return false;
    }
    const state = this.readState();
    delete state.enabled[id];
    this.writeState(state);
    this.scan();
    return true;
  }

  /** 自动候选去重：只找带 auto-candidate 标签的同名候选。 */
  findAutoCandidateByName(name: string): SkillRecord | null {
    const base = candidateBase(name);
    return this.registry
      .list()
      .find(
        (item) =>
          item.frontmatter.name === name &&
          (item.id === base || item.id.startsWith(`${base}-`)) &&
          (item.frontmatter.tags ?? []).includes("auto-candidate"),
      ) ?? null;
  }

  private writeCandidate(id: string, input: CandidateInput): void {
    const dir = path.join(this.dir, id);
    fs.mkdirSync(dir, { recursive: true });
    const tags = Array.from(new Set([...(input.tags ?? []), "candidate"]));
    const frontmatter = [
      "---",
      `name: ${JSON.stringify(input.name)}`,
      `description: ${JSON.stringify(input.description)}`,
      ...(input.whenToUse ? [`whenToUse: ${JSON.stringify(input.whenToUse)}`] : []),
      ...(tags.length > 0 ? ["tags:", ...tags.map((tag) => `  - ${JSON.stringify(tag)}`)] : []),
      "---",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(dir, SKILL_FILE_NAME), `${frontmatter}${input.body.trim()}\n`, "utf8");
    const state = this.readState();
    state.enabled[id] = false;
    this.writeState(state);
    this.scan();
  }

  dirPath(): string {
    return this.dir;
  }

  /**
   * 导入 Claude/Hermes 风格的技能目录（SKILL.md + scripts/ + references/ + assets/）。
   *
   * 安全与一致性：
   *  - 只接受「目录 + SKILL.md」，导入前先解析，坏技能不落盘；
   *  - 目标目录必须在技能库内，源目录不能在目标内（防自我复制）；
   *  - 不跟随符号链接；跳过 .git/node_modules；限制文件数/总字节/深度；
   *  - 先写 `.import-*` 临时目录再 rename，失败清理，扫描跳过点目录；
   *  - 导入成功后默认启用（用户显式安装），并立即重扫。
   */
  importSkill(sourcePath: string, opts: { id?: string; overwrite?: boolean } = {}): SkillImportResult {
    const source = path.resolve(sourcePath.trim());
    try {
      if (!source || !fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
        return { ok: false, error: `源路径不是目录：${sourcePath}` };
      }
      const skillFile = path.join(source, SKILL_FILE_NAME);
      if (!fs.existsSync(skillFile)) {
        return { ok: false, error: `目录里没有 ${SKILL_FILE_NAME}：${sourcePath}` };
      }
      const raw = fs.readFileSync(skillFile, "utf8");
      if (Buffer.byteLength(raw, "utf8") > SKILL_MAX_BYTES) {
        return { ok: false, error: `${SKILL_FILE_NAME} 超过 ${SKILL_MAX_BYTES} 字节，拒绝导入` };
      }
      let parsed: ReturnType<typeof SkillRegistry.parseMarkdown>;
      try {
        parsed = SkillRegistry.parseMarkdown(raw, path.basename(source));
      } catch (err) {
        return { ok: false, error: `SKILL.md 解析失败：${err instanceof Error ? err.message : String(err)}` };
      }

      const root = path.resolve(this.dir);
      const id = (opts.id?.trim() || candidateBase(parsed.frontmatter.name) || path.basename(source)).replace(
        /[^a-z0-9._-]/gi,
        "-",
      );
      if (!id || id === "." || id === ".." || id.startsWith(".")) return { ok: false, error: `非法的技能 id：${id || "(空)"}` };
      const target = path.resolve(root, id);
      if (!isInside(root, target)) return { ok: false, error: "目标路径越界" };
      if (source === target || isInside(source, target) || isInside(target, source)) {
        return { ok: false, error: "源目录与技能库目标互相包含，不能导入" };
      }
      if (source === root || isInside(root, source)) {
        return { ok: false, error: "源目录已经在技能库内，无需导入" };
      }
      if (fs.existsSync(target) && opts.overwrite !== true) {
        return { ok: false, error: `技能 ${id} 已存在；确认覆盖后重试` };
      }

      const temp = path.resolve(root, `.import-${id}-${process.pid}-${Date.now()}`);
      if (!isInside(root, temp)) return { ok: false, error: "临时目录越界" };
      const acc = { files: 0, bytes: 0, skipped: [] as string[] };
      fs.mkdirSync(temp, { recursive: true });
      try {
        this.copyTree(source, temp, "", acc, 0);
        if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
        fs.renameSync(temp, target);
      } catch (err) {
        fs.rmSync(temp, { recursive: true, force: true });
        return { ok: false, error: `复制失败：${err instanceof Error ? err.message : String(err)}` };
      }

      const state = this.readState();
      state.enabled[id] = true;
      this.writeState(state);
      this.scan();
      return {
        ok: true,
        id,
        target,
        files: acc.files,
        bytes: acc.bytes,
        warnings: parsed.warnings,
        ...(acc.skipped.length > 0 ? { skipped: acc.skipped } : {}),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 递归复制技能包；不跟随符号链接，超出上限直接失败（宁可拒绝也不半导入）。 */
  private copyTree(
    sourceRoot: string,
    targetRoot: string,
    rel: string,
    acc: { files: number; bytes: number; skipped: string[] },
    depth: number,
  ): void {
    if (depth > IMPORT_MAX_DEPTH) throw new Error(`目录层级过深（>${IMPORT_MAX_DEPTH}）：${rel || "."}`);
    const dir = path.join(sourceRoot, rel);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel ? path.join(rel, entry.name) : entry.name;
      const src = path.join(sourceRoot, relPath);
      const dst = path.join(targetRoot, relPath);
      if (!isInside(targetRoot, dst)) throw new Error(`目标路径越界：${relPath}`);
      if (entry.isSymbolicLink()) {
        acc.skipped.push(relPath);
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        fs.mkdirSync(dst, { recursive: true });
        this.copyTree(sourceRoot, targetRoot, relPath, acc, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const size = fs.statSync(src).size;
      if (acc.files + 1 > IMPORT_MAX_FILES) throw new Error(`文件数超过上限 ${IMPORT_MAX_FILES}`);
      if (acc.bytes + size > IMPORT_MAX_BYTES) throw new Error(`总大小超过上限 ${IMPORT_MAX_BYTES} 字节`);
      fs.copyFileSync(src, dst);
      acc.files += 1;
      acc.bytes += size;
    }
  }

  promptFor(userText: string): string {
    return this.registry.promptFor(userText);
  }

  /**
   * 技能声明 allowed-tools 时收窄本轮工具面。
   * 声明全写错（交集为空）时保留原名单：宁可技能限制失效，也不要让会话失去全部工具。
   */
  limitToolSurface(userText: string | undefined, names: string[] | undefined): string[] | undefined {
    if (!userText || !names) return names;
    const declared = this.registry.allowedToolsFor(userText);
    if (!declared) return names;
    const kept = names.filter((name) => declared.includes(name));
    return kept.length > 0 ? kept : names;
  }
}
