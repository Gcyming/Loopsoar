/**
 * 会话检查点：为「一次 Agent 回合内的文件改动」保留可回滚快照。
 *
 * 为什么在壳层而不是 core：快照要落盘、要跟随工作区根、要按会话清理；
 * core 只定义工具契约，不该碰文件系统布局。
 *
 * 语义边界（刻意保守）：
 *   · 只覆盖 file_write 这类「经由工具的文件写入」，不承诺回滚 terminal_run 的副作用；
 *   · 同一回合内同一文件只备份第一次写入前的状态（回滚 = 回到回合开始前）；
 *   · 恢复前重新校验路径必须落在当前工作区内，防止工作区切换后写到别处；
 *   · 恢复是把旧内容写回或删除「本回合新建」的文件；备份缺失时逐文件报错，不静默跳过。
 */
import fs from "node:fs";
import path from "node:path";

export interface CheckpointFile {
  /** 相对工作区根；恢复时按当前根解析。 */
  rel: string;
  /** 回合开始前是否存在；false 表示本回合新建，恢复时应删除。 */
  existed: boolean;
  /** 备份文件名（位于 <checkpoint>/files/ 下）；existed=false 时缺省。 */
  backup?: string;
  bytes?: number;
}

export interface CheckpointManifest {
  id: string;
  sessionId: string;
  label: string;
  createdAt: number;
  endedAt?: number;
  files: CheckpointFile[];
}

export interface RestoreResult {
  checkpointId: string;
  restored: number;
  deleted: number;
  errors: string[];
}

const MAX_CHECKPOINTS_PER_SESSION = 20;
const STALE_ACTIVE_MS = 30 * 60_000;

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "session";
}

function inside(root: string, target: string): boolean {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  return resolved === base || resolved.startsWith(base + path.sep);
}

export class CheckpointStore {
  /** sessionId → 当前回合的 checkpoint id。 */
  private active = new Map<string, string>();
  private seq = 0;

  constructor(private readonly root: string) {}

  private sessionDir(sessionId: string): string {
    return path.join(this.root, safeId(sessionId));
  }

  private checkpointDir(sessionId: string, id: string): string {
    return path.join(this.sessionDir(sessionId), id);
  }

  private readManifest(sessionId: string, id: string): CheckpointManifest | null {
    try {
      const raw = fs.readFileSync(path.join(this.checkpointDir(sessionId, id), "manifest.json"), "utf8");
      const parsed = JSON.parse(raw) as CheckpointManifest;
      if (!parsed || typeof parsed.id !== "string" || !Array.isArray(parsed.files)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private writeManifest(manifest: CheckpointManifest): void {
    const dir = this.checkpointDir(manifest.sessionId, manifest.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  }

  /** 开启一个回合检查点；同一会话已有活跃且未过期的检查点时复用它。 */
  begin(sessionId: string, label: string): string {
    const sid = sessionId || "default";
    const current = this.active.get(sid);
    if (current) {
      const manifest = this.readManifest(sid, current);
      if (manifest && Date.now() - manifest.createdAt < STALE_ACTIVE_MS) return current;
      this.active.delete(sid);
    }
    const id = `cp-${Date.now().toString(36)}-${(this.seq += 1).toString(36)}`;
    const manifest: CheckpointManifest = {
      id,
      sessionId: sid,
      label: label.slice(0, 200),
      createdAt: Date.now(),
      files: [],
    };
    this.writeManifest(manifest);
    this.active.set(sid, id);
    this.prune(sid);
    return id;
  }

  /** 回合结束：清活跃指针并按保留上限清理；快照仍可供回滚。 */
  end(sessionId: string): void {
    const sid = sessionId || "default";
    this.active.delete(sid);
    this.prune(sid);
  }

  /**
   * 写入前记录：同一回合内同一文件只记第一次（保留回合开始前的内容）。
   * 返回是否真的产生了快照（内容未变的覆盖不产生冗余备份）。
   */
  capture(sessionId: string, absPath: string, rel: string, nextContent: string): boolean {
    const sid = sessionId || "default";
    const id = this.active.get(sid) ?? this.begin(sid, "Agent 文件写入");
    const manifest = this.readManifest(sid, id);
    if (!manifest) return false;
    const cleanRel = rel.split(path.sep).join("/");
    if (manifest.files.some((file) => file.rel === cleanRel)) return true;
    let existed = false;
    let old = "";
    try {
      if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
        existed = true;
        old = fs.readFileSync(absPath, "utf8");
      }
    } catch {
      // 读不到旧内容时不拦写入：快照降级为「新建」，恢复时删除该文件。
    }
    if (existed && old === nextContent) return false;
    const filesDir = path.join(this.checkpointDir(sid, id), "files");
    fs.mkdirSync(filesDir, { recursive: true });
    const backup = `f${manifest.files.length}.bak`;
    if (existed) fs.writeFileSync(path.join(filesDir, backup), old, "utf8");
    manifest.files.push({
      rel: cleanRel,
      existed,
      ...(existed ? { backup } : {}),
      ...(existed ? { bytes: Buffer.byteLength(old, "utf8") } : {}),
    });
    this.writeManifest(manifest);
    return true;
  }

  list(sessionId: string, limit = MAX_CHECKPOINTS_PER_SESSION): CheckpointManifest[] {
    const sid = sessionId || "default";
    let entries: string[] = [];
    try {
      entries = fs
        .readdirSync(this.sessionDir(sid), { withFileTypes: true })
        .filter((item) => item.isDirectory())
        .map((item) => item.name);
    } catch {
      return [];
    }
    return entries
      .map((id) => this.readManifest(sid, id))
      .filter((item): item is CheckpointManifest => item !== null && item.files.length > 0)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  /**
   * 回滚到某个检查点之前的状态；缺省回滚最近一个有文件的检查点。
   * 恢复后保留快照（可重复恢复），但不再作为活跃回合。
   */
  restore(sessionId: string, workspaceRoot: string, checkpointId?: string): RestoreResult {
    const sid = sessionId || "default";
    const target = checkpointId
      ? this.readManifest(sid, checkpointId)
      : this.list(sid, 1)[0] ?? null;
    if (!target) {
      return { checkpointId: checkpointId ?? "", restored: 0, deleted: 0, errors: ["没有可回滚的检查点"] };
    }
    const result: RestoreResult = { checkpointId: target.id, restored: 0, deleted: 0, errors: [] };
    for (const file of target.files) {
      const abs = path.resolve(workspaceRoot, file.rel);
      if (!inside(workspaceRoot, abs)) {
        result.errors.push(`${file.rel}：路径越界，已跳过`);
        continue;
      }
      try {
        if (file.existed) {
          if (!file.backup) {
            result.errors.push(`${file.rel}：缺少备份文件，已跳过`);
            continue;
          }
          const backup = path.join(this.checkpointDir(sid, target.id), "files", file.backup);
          const content = fs.readFileSync(backup, "utf8");
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, content, "utf8");
          result.restored += 1;
        } else {
          fs.rmSync(abs, { force: true });
          result.deleted += 1;
        }
      } catch (err) {
        result.errors.push(`${file.rel}：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.active.delete(sid);
    return result;
  }

  /** 只保留最近 N 个非空检查点；空回合（工具写了但内容没变）直接清掉。 */
  prune(sessionId: string, keep = MAX_CHECKPOINTS_PER_SESSION): void {
    const sid = sessionId || "default";
    let entries: string[] = [];
    try {
      entries = fs
        .readdirSync(this.sessionDir(sid), { withFileTypes: true })
        .filter((item) => item.isDirectory())
        .map((item) => item.name);
    } catch {
      return;
    }
    const manifests = entries
      .map((id) => this.readManifest(sid, id))
      .filter((item): item is CheckpointManifest => item !== null)
      .sort((a, b) => b.createdAt - a.createdAt);
    const keepIds = new Set(
      manifests
        .filter((item) => item.files.length > 0)
        .slice(0, keep)
        .map((item) => item.id),
    );
    const activeId = this.active.get(sid);
    for (const manifest of manifests) {
      if (keepIds.has(manifest.id) || manifest.id === activeId) continue;
      try {
        fs.rmSync(this.checkpointDir(sid, manifest.id), { recursive: true, force: true });
      } catch {
        // 清理失败不影响主流程
      }
    }
  }
}
