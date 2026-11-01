/**
 * 会话持久化（壳层，多会话）：<dataDir>/sessions/
 *   index.json            { currentId, items: [{ id, title, updatedAt, preview, messageCount }] }
 *   <sessionId>.json      { sessionId, updatedAt, messages: [{role, text, ts}] }
 *
 * 兼容旧版：若存在 last.json（单会话时代），首次加载自动迁移为一条会话。
 * 最多保留 200 条消息；列表按 updatedAt 倒序。
 */
import fs from "node:fs";
import path from "node:path";
import type { PersistedBrowserState } from "./browserSessionState.js";

export interface PersistedMessage {
  role: "user" | "assistant";
  text: string;
  ts: number;
  /** 助手消息的交错时间线（思考/工具/规划/播报/引导）；用户消息无此字段。 */
  timeline?: unknown[];
  /** 生成本条回复的供应商/模型（用于悬停显示历史真实模型，而不是当前选择）。 */
  provider?: string;
  model?: string;
}

export interface PersistedWorktree {
  path: string;
  branch: string;
  baseBranch: string;
  repoRoot: string;
  createdAt: number;
}

export interface PersistedSession {
  sessionId: string;
  updatedAt: number;
  messages: PersistedMessage[];
  /** 该会话最后打开的网页（会话即"文件夹"；重启后恢复左侧页面）。 */
  browser?: PersistedBrowserState;
  /** 会话归属的工作区（WorkpsaceStore 的 id）。 */
  workspaceId?: string | null;
  /** 该会话的隔离 git worktree；存在时 Agent 的工作根目录取它。 */
  worktree?: PersistedWorktree | null;
}

export interface SessionMeta {
  id: string;
  title: string;
  updatedAt: number;
  preview: string;
  messageCount: number;
  /** 会话归属的工作区 id（旧会话可能没有）。 */
  workspaceId?: string | null;
}

interface SessionIndex {
  currentId: string | null;
  items: SessionMeta[];
}

const MAX_MESSAGES = 200;
const MAX_SESSIONS = 100;

export class SessionStore {
  private dir: string;
  private indexFile: string;

  constructor(dir: string) {
    this.dir = dir;
    this.indexFile = path.join(dir, "index.json");
    this.ensureDirs();
    this.migrateLegacy();
  }

  private ensureDirs(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private readJson<T>(file: string): T | null {
    try {
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, "utf8")) as T;
    } catch {
      return null;
    }
  }

  private writeJson(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
  }

  private index(): SessionIndex {
    const raw = this.readJson<Partial<SessionIndex>>(this.indexFile);
    if (raw && Array.isArray(raw.items)) {
      return {
        currentId: raw.currentId && raw.items.some((i) => i.id === raw.currentId) ? raw.currentId : (raw.items[0]?.id ?? null),
        items: raw.items,
      };
    }
    return { currentId: null, items: [] };
  }

  private saveIndex(index: SessionIndex): void {
    const items = index.items.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SESSIONS);
    this.writeJson(this.indexFile, { currentId: index.currentId, items });
  }

  private sessionFile(id: string): string {
    const safe = id.replace(/[^a-zA-Z0-9._-]/g, "_");
    return path.join(this.dir, `${safe}.json`);
  }

  /** 旧版 last.json → 会话文件 + 索引。 */
  private migrateLegacy(): void {
    if (fs.existsSync(this.indexFile)) return;
    const legacy = this.readJson<PersistedSession>(path.join(this.dir, "last.json"));
    if (!legacy || !Array.isArray(legacy.messages) || legacy.messages.length === 0) return;
    const id = legacy.sessionId || `sess-${Date.now()}`;
    this.writeJson(this.sessionFile(id), { ...legacy, sessionId: id });
    this.writeJson(this.indexFile, {
      currentId: id,
      items: [this.metaOf(id, legacy.messages, legacy.updatedAt)],
    });
  }

  private metaOf(
    id: string,
    messages: PersistedMessage[],
    updatedAt: number,
    workspaceId?: string | null,
  ): SessionMeta {
    const firstUser = messages.find((m) => m.role === "user")?.text ?? "新会话";
    const last = messages[messages.length - 1]?.text ?? "";
    return {
      id,
      title: firstUser.replace(/\s+/g, " ").slice(0, 40) || "新会话",
      updatedAt,
      preview: last.replace(/\s+/g, " ").slice(0, 80),
      messageCount: messages.length,
      ...(workspaceId ? { workspaceId } : {}),
    };
  }

  /** 保存某会话的浏览器标签快照（不触发 updatedAt/列表元信息变化）。 */
  saveBrowserState(sessionId: string, state: PersistedBrowserState): boolean {
    const file = this.sessionFile(sessionId);
    const data = this.readJson<PersistedSession>(file);
    if (!data) return false;
    data.browser = state.tabs.length > 0 ? state : undefined;
    this.writeJson(file, data);
    return true;
  }

  /** 读取某会话的浏览器标签快照（旧文件无此字段时返回 null）。 */
  getBrowserState(sessionId: string): PersistedBrowserState | null {
    return this.get(sessionId)?.browser ?? null;
  }

  /** 把时间线挂到最后一条助手消息（对话完成后由 UI 上报；失败静默不影响对话）。 */
  attachTimeline(sessionId: string | null, timeline: unknown[]): boolean {
    const id = sessionId ?? this.currentId();
    if (!id) return false;
    const file = path.join(this.dir, `${id}.json`);
    const data = this.readJson<PersistedSession>(file);
    if (!data) return false;
    for (let i = data.messages.length - 1; i >= 0; i -= 1) {
      if (data.messages[i].role === "assistant") {
        data.messages[i] = { ...data.messages[i], timeline };
        this.writeJson(file, data);
        return true;
      }
    }
    return false;
  }

  /** 截断到第 keepCount 条消息（保留 [0, keepCount)），用于消息回滚；返回截断后的会话。 */
  truncate(sessionId: string | null, keepCount: number): PersistedSession | null {
    const id = sessionId ?? this.currentId();
    if (!id) return null;
    const file = path.join(this.dir, `${id}.json`);
    const data = this.readJson<PersistedSession>(file);
    if (!data) return null;
    const keep = Math.max(0, Math.min(Math.floor(keepCount), data.messages.length));
    data.messages = data.messages.slice(0, keep);
    data.updatedAt = Date.now();
    this.writeJson(file, data);
    const index = this.index();
    const meta = index.items.find((i) => i.id === id);
    if (meta) {
      const last = data.messages[data.messages.length - 1];
      meta.messageCount = data.messages.length;
      meta.preview = last ? last.text.slice(0, 80) : "";
      meta.updatedAt = data.updatedAt;
      this.saveIndex(index);
    }
    return data;
  }

  list(): SessionMeta[] {
    return this.index().items.slice().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  currentId(): string | null {
    return this.index().currentId;
  }

  get(id: string): PersistedSession | null {
    return this.readJson<PersistedSession>(this.sessionFile(id));
  }

  /** 兼容旧接口：当前会话。 */
  load(): PersistedSession | null {
    const id = this.currentId();
    return id ? this.get(id) : null;
  }

  save(session: PersistedSession): PersistedSession {
    const trimmed: PersistedSession = {
      ...session,
      messages: session.messages.slice(-MAX_MESSAGES),
    };
    this.writeJson(this.sessionFile(session.sessionId), trimmed);
    const index = this.index();
    const meta = this.metaOf(session.sessionId, trimmed.messages, trimmed.updatedAt, trimmed.workspaceId);
    const at = index.items.findIndex((i) => i.id === session.sessionId);
    if (at >= 0) index.items[at] = meta;
    else index.items.push(meta);
    index.currentId = index.currentId ?? session.sessionId;
    this.saveIndex(index);
    return trimmed;
  }

  newSession(workspaceId?: string | null): PersistedSession {
    const id = `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const session: PersistedSession = {
      sessionId: id,
      updatedAt: Date.now(),
      messages: [],
      ...(workspaceId ? { workspaceId } : {}),
    };
    this.writeJson(this.sessionFile(id), session);
    const index = this.index();
    index.items.push(this.metaOf(id, [], Date.now(), workspaceId));
    index.currentId = id;
    this.saveIndex(index);
    return session;
  }

  /** 会话归属工作区（旧会话可补绑）。 */
  setWorkspaceId(sessionId: string, workspaceId: string | null): boolean {
    const data = this.get(sessionId);
    if (!data) return false;
    data.workspaceId = workspaceId;
    this.writeJson(this.sessionFile(sessionId), data);
    const index = this.index();
    const meta = index.items.find((item) => item.id === sessionId);
    if (meta) {
      if (workspaceId) meta.workspaceId = workspaceId;
      else delete meta.workspaceId;
      this.saveIndex(index);
    }
    return true;
  }

  getWorktree(sessionId: string): PersistedWorktree | null {
    return this.get(sessionId)?.worktree ?? null;
  }

  setWorktree(sessionId: string, worktree: PersistedWorktree | null): boolean {
    const data = this.get(sessionId);
    if (!data) return false;
    data.worktree = worktree;
    this.writeJson(this.sessionFile(sessionId), data);
    return true;
  }

  switchTo(id: string): boolean {
    const index = this.index();
    if (!index.items.some((i) => i.id === id)) return false;
    index.currentId = id;
    this.saveIndex(index);
    return true;
  }

  /** 追加一轮对话（用户消息 + 助手最终答复）。 */
  append(
    sessionId: string,
    userMessage: string,
    assistantReply: string,
    meta?: { provider?: string; model?: string },
  ): PersistedSession {
    const current = this.get(sessionId);
    const base: PersistedSession = current ?? { sessionId, updatedAt: Date.now(), messages: [] };
    base.messages.push({ role: "user", text: userMessage, ts: Date.now() });
    if (assistantReply.trim()) {
      base.messages.push({
        role: "assistant",
        text: assistantReply,
        ts: Date.now(),
        ...(meta?.provider ? { provider: meta.provider } : {}),
        ...(meta?.model ? { model: meta.model } : {}),
      });
    }
    base.updatedAt = Date.now();
    return this.save(base);
  }

  remove(id: string): boolean {
    const index = this.index();
    const exists = index.items.some((i) => i.id === id);
    if (!exists) return false;
    try {
      const file = this.sessionFile(id);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      return false;
    }
    index.items = index.items.filter((i) => i.id !== id);
    if (index.currentId === id) index.currentId = index.items[0]?.id ?? null;
    this.saveIndex(index);
    return true;
  }
}
