/**
 * 工作区存储（壳层）：<dataDir>/workspaces.json
 *
 * 工作区 = 挂载到本地的项目文件夹。会话归属于工作区；Agent 的文件/终端根目录
 * 由「会话 worktree > 会话工作区根 > 当前活动工作区」解析（见 index 的 resolveSessionRoot）。
 */
import fs from "node:fs";
import path from "node:path";

export interface WorkspaceRecord {
  id: string;
  name: string;
  root: string;
  createdAt: number;
  lastUsedAt: number;
}

interface WorkspaceFile {
  activeId: string | null;
  items: WorkspaceRecord[];
}

const MAX_WORKSPACES = 30;

export class WorkspaceStore {
  private data: WorkspaceFile;

  constructor(
    private filePath: string,
    defaultRoot: string,
  ) {
    this.data = this.load();
    if (this.data.items.length === 0) {
      const created = this.create(defaultRoot, "默认工作区");
      if (!created.ok) throw new Error(`无法初始化工作区：${created.error}`);
    }
    if (!this.data.activeId || !this.data.items.some((item) => item.id === this.data.activeId)) {
      this.data.activeId = this.data.items[0]?.id ?? null;
      this.save();
    }
  }

  private load(): WorkspaceFile {
    try {
      if (!fs.existsSync(this.filePath)) return { activeId: null, items: [] };
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<WorkspaceFile>;
      const items = Array.isArray(raw.items)
        ? raw.items.filter(
            (item): item is WorkspaceRecord =>
              Boolean(item) &&
              typeof item.id === "string" &&
              typeof item.name === "string" &&
              typeof item.root === "string" &&
              fs.existsSync(item.root),
          )
        : [];
      return {
        activeId: typeof raw.activeId === "string" ? raw.activeId : null,
        items: items.slice(0, MAX_WORKSPACES),
      };
    } catch {
      return { activeId: null, items: [] };
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf8");
  }

  private normalizeRoot(raw: string): { ok: true; root: string } | { ok: false; error: string } {
    const trimmed = raw.trim();
    if (!trimmed) return { ok: false, error: "文件夹路径为空" };
    const resolved = path.resolve(trimmed);
    if (!fs.existsSync(resolved)) return { ok: false, error: "文件夹不存在" };
    try {
      if (!fs.statSync(resolved).isDirectory()) return { ok: false, error: "不是文件夹" };
    } catch {
      return { ok: false, error: "无法读取文件夹" };
    }
    let real = resolved;
    try {
      real = fs.realpathSync.native(resolved);
    } catch {
      // 保留 resolved
    }
    return { ok: true, root: real };
  }

  list(): WorkspaceRecord[] {
    return this.data.items.slice().sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  active(): WorkspaceRecord | null {
    return this.data.items.find((item) => item.id === this.data.activeId) ?? null;
  }

  activeId(): string | null {
    return this.data.activeId;
  }

  get(id: string): WorkspaceRecord | null {
    return this.data.items.find((item) => item.id === id) ?? null;
  }

  create(
    root: string,
    name?: string,
  ): { ok: true; workspace: WorkspaceRecord } | { ok: false; error: string } {
    if (this.data.items.length >= MAX_WORKSPACES) return { ok: false, error: `工作区数量达到上限 ${MAX_WORKSPACES}` };
    const normalized = this.normalizeRoot(root);
    if (!normalized.ok) return normalized;
    const existing = this.data.items.find(
      (item) => item.root.toLowerCase() === normalized.root.toLowerCase(),
    );
    if (existing) {
      // 同一个文件夹不重复挂载，直接选中已有工作区
      this.data.activeId = existing.id;
      existing.lastUsedAt = Date.now();
      this.save();
      return { ok: true, workspace: existing };
    }
    const id = `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const now = Date.now();
    const workspace: WorkspaceRecord = {
      id,
      name: (name?.trim() || path.basename(normalized.root) || "工作区").slice(0, 60),
      root: normalized.root,
      createdAt: now,
      lastUsedAt: now,
    };
    this.data.items.push(workspace);
    this.data.activeId = id;
    this.save();
    return { ok: true, workspace };
  }

  select(id: string): WorkspaceRecord | null {
    const workspace = this.get(id);
    if (!workspace) return null;
    this.data.activeId = id;
    workspace.lastUsedAt = Date.now();
    this.save();
    return workspace;
  }

  rename(id: string, name: string): WorkspaceRecord | null {
    const workspace = this.get(id);
    const next = name.trim().slice(0, 60);
    if (!workspace || !next) return null;
    workspace.name = next;
    this.save();
    return workspace;
  }

  remove(id: string): { ok: boolean; error?: string } {
    const index = this.data.items.findIndex((item) => item.id === id);
    if (index < 0) return { ok: false, error: "工作区不存在" };
    if (this.data.items.length === 1) return { ok: false, error: "至少保留一个工作区" };
    this.data.items.splice(index, 1);
    if (this.data.activeId === id) {
      this.data.activeId = this.data.items[0]?.id ?? null;
    }
    this.save();
    return { ok: true };
  }
}
